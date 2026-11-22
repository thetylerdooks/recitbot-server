// Installer commands and links. get_installer hands out a no-prompt command a bot runs on the user's PC or Mac, plus a
// short-lived signed link (/i/<token>) for clients that cannot run commands: "install" / "mac_install" links serve a
// script that pairs with the pairing code carried in the token, "update" / "mac_update" links serve install.ps1 /
// install.sh itself (recorder self-update).
import type { Env } from "./env";
import { publicBase } from "./env";
import { INSTALL_PS1_SHA256, INSTALL_SH_SHA256 } from "./generated";
import { hmacB64, now, randomId, safeEqual } from "./util";

export type InstallerPurpose = "install" | "update" | "mac_install" | "mac_update";
export type Platform = "windows" | "macos";

/** Purposes that carry a pairing code. */
const PAIRS = (p: string) => p === "install" || p === "mac_install";
export type InstallerToken = { purpose: InstallerPurpose; accountId: string; exp: number; code: string | null };

/** v1.<purpose>.<account>.<exp>.<nonce>.<code>.<mac>. Only install and mac_install links carry a pairing code. */
const TOKEN = /^v1\.(install|update|mac_install|mac_update)\.([A-Za-z0-9]{20,30})\.(\d{1,12})\.([A-Za-z0-9]{8,24})\.([A-Za-z0-9]{10,40})?\.([A-Za-z0-9_-]{43})$/;

function sign(env: Env, body: string): Promise<string> {
  if (!env.INSTALLER_URL_KEY) throw new Error("INSTALLER_URL_KEY is not set");
  return hmacB64(env.INSTALLER_URL_KEY, `installer-url|${body}`);
}

/** A signed /i/ link for this account, valid until expiresAt. `code` (install only) is the pairing code it installs with. */
export async function installerUrl(
  env: Env,
  base: string,
  o: { purpose: InstallerPurpose; accountId: string; expiresAt: number; code?: string },
): Promise<string> {
  if (PAIRS(o.purpose) !== (o.code !== undefined)) throw new Error("install links carry a pairing code; update links none");
  const body = ["v1", o.purpose, o.accountId, o.expiresAt, randomId(64), o.code ?? ""].join(".");
  return `${base}/i/${body}.${await sign(env, body)}`;
}

/** Malformed or unknown purpose = 404, bad signature = 403, expired = 410. */
export async function verifyInstallerToken(
  env: Env,
  token: string,
  t = now(),
): Promise<{ ok: true; token: InstallerToken } | { ok: false; status: 403 | 404 | 410 }> {
  const m = TOKEN.exec(token);
  if (!m || PAIRS(m[1]) !== (m[5] !== undefined)) return { ok: false, status: 404 };
  if (!safeEqual(m[6], await sign(env, token.slice(0, token.lastIndexOf("."))))) return { ok: false, status: 403 };
  const exp = Number(m[3]);
  if (exp <= t) return { ok: false, status: 410 };
  return { ok: true, token: { purpose: m[1] as InstallerPurpose, accountId: m[2], exp, code: m[5] ?? null } };
}

/**
 * PowerShell that installs and pairs: downloads install.ps1 to %TEMP%, checks its SHA-256, runs it with the pairing
 * code (install.ps1 hands the code to the recorder over stdin, never on a command line) and the account the code is for
 * (-Account: a re-pair of a PC already paired with it reuses its device row) and exits with its exit code.
 * It contains no $, ", `, % or !, so the same text survives cmd, PowerShell and bash (WSL) inside double quotes.
 */
export function installScript(origin: string, code: string, accountId: string): string {
  checkAccount(accountId);
  return [
    "try{",
    "[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12;",
    "Set-Variable ProgressPreference SilentlyContinue;",
    "Set-Variable f (Join-Path ([IO.Path]::GetTempPath()) ('recitbot-install-'+[guid]::NewGuid()+'.ps1'));",
    `Invoke-WebRequest -UseBasicParsing -Uri '${origin}/install.ps1' -OutFile (gv f -ValueOnly) -ErrorAction Stop;`,
    `if((Get-FileHash -Algorithm SHA256 -LiteralPath (gv f -ValueOnly)).Hash -ne '${INSTALL_PS1_SHA256}'){throw 'install.ps1 SHA-256 mismatch'};`,
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (gv f -ValueOnly) -Server '${origin}' -Code '${code}' -Account '${accountId}';`,
    "Set-Variable rc (gv LASTEXITCODE -ValueOnly)",
    "}catch{Write-Output ('RECITBOT_INSTALL_FAILED: '+(gv _ -ValueOnly));Set-Variable rc 1}",
    "finally{if(gv f -ValueOnly -ErrorAction SilentlyContinue){Remove-Item -LiteralPath (gv f -ValueOnly) -ErrorAction SilentlyContinue}};",
    "exit (gv rc -ValueOnly)",
  ].join("");
}

/** The one-liner get_installer returns: runs installScript from cmd, PowerShell or WSL, never prompts. */
export function installCommand(origin: string, code: string, accountId: string): string {
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${installScript(origin, code, accountId)}"`;
}

/**
 * The bash one-liner get_installer returns for a Mac: downloads install.sh to a temp file, checks its SHA-256, then
 * runs it with the pairing code in RECITBOT_PAIRING_CODE (install.sh hands it to the recorder over stdin) and --account
 * (the account the code is for: a re-pair of a Mac already paired with it reuses its device row), never `curl | bash`. Exit 1 + RECITBOT_INSTALL_FAILED when this wrapper fails, else install.sh's own result line and exit
 * code. Contains no ' (single-quoted as one argument to /bin/bash -c) and works from zsh, bash and sh.
 */
export function macInstallScript(origin: string, code: string, accountId: string, sha256 = INSTALL_SH_SHA256): string {
  checkAccount(accountId);
  return [
    'f=$(mktemp "${TMPDIR:-/tmp}/recitbot-install-XXXXXXXX") || exit 1',
    'trap "rm -f \\"$f\\"" EXIT',
    `curl -fsSL --proto =https -o "$f" ${origin}/install.sh || { echo "RECITBOT_INSTALL_FAILED: install.sh download failed"; exit 1; }`,
    `[ "$(shasum -a 256 "$f" | cut -c1-64 | tr a-f A-F)" = "${sha256}" ] || { echo "RECITBOT_INSTALL_FAILED: install.sh SHA-256 mismatch"; exit 1; }`,
    `RECITBOT_PAIRING_CODE=${code} /bin/bash "$f" --server ${origin} --account ${accountId}`,
  ].join("; ");
}

export function macInstallCommand(origin: string, code: string, accountId: string, sha256 = INSTALL_SH_SHA256): string {
  return `/bin/bash -c '${macInstallScript(origin, code, accountId, sha256)}'`;
}

/** install.ps1 -Account and install.sh --account accept ^[A-Za-z0-9]{1,64}$; it also keeps the commands' quoting safe. */
function checkAccount(accountId: string): void {
  if (!/^[A-Za-z0-9]{1,64}$/.test(accountId)) throw new Error("invalid account id for an installer command");
}

/** Semver x.y.z compare (hello versions are validated to that shape). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

const LINK_ERRORS: Record<403 | 404 | 410, string> = {
  403: "This install link is not valid.",
  404: "Not found.",
  410: "This install link has expired. Ask your assistant for a new one.",
};

/**
 * GET /i/<token>. Install links: a pre-paired installer script. Update links: install.ps1 (pinned INSTALL_PS1_SHA256).
 * mac_install: the same as a bash script; mac_update: install.sh (pinned INSTALL_SH_SHA256).
 */
export async function handleInstallerLink(req: Request, env: Env, token: string): Promise<Response> {
  const v = await verifyInstallerToken(env, token);
  if (!v.ok) return new Response(LINK_ERRORS[v.status] + "\n", { status: v.status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  const url = new URL(req.url);
  const mac = v.token.purpose === "mac_install" || v.token.purpose === "mac_update";
  let body: string | ArrayBuffer;
  if (v.token.purpose === "mac_install") {
    const origin = publicBase(env, url.origin);
    body =
      [
        "#!/bin/bash",
        `# Recitbot recorder installer from ${origin}. Pairs this Mac with the account that asked for it. The pairing code`,
        `# inside works once, until ${new Date(v.token.exp * 1000).toISOString()}.`,
        "# Run it in Terminal: bash ~/Downloads/recitbot-install.sh",
        macInstallScript(origin, v.token.code!, v.token.accountId),
      ].join("\n") + "\n";
  } else if (v.token.purpose === "install") {
    const origin = publicBase(env, url.origin);
    body =
      [
        `# Recitbot recorder installer from ${origin}. Pairs this Windows PC with the account that asked for it. The`,
        `# pairing code inside works once, until ${new Date(v.token.exp * 1000).toISOString()}.`,
        "# Run it: right-click > Run with PowerShell, or: powershell -NoProfile -ExecutionPolicy Bypass -File recitbot-install.ps1",
        installScript(origin, v.token.code!, v.token.accountId),
      ].join("\r\n") + "\r\n";
  } else {
    const asset = await env.ASSETS.fetch(new Request(new URL(mac ? "/install.sh" : "/install.ps1", url.origin)));
    if (!asset.ok) return new Response("Installer unavailable.\n", { status: 503, headers: { "cache-control": "no-store" } });
    body = await asset.arrayBuffer();
  }
  return new Response(body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="recitbot-${v.token.purpose.replace("mac_", "")}.${mac ? "sh" : "ps1"}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
      "referrer-policy": "no-referrer",
    },
  });
}
