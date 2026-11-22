// macOS install and update: get_installer platform "macos", /install.sh + /uninstall.sh + /Recitbot-mac-<v>.zip,
// mac_install / mac_update links, update_recorder for a paired Mac. Tests that need the Mac zip
// (recorder-mac/Recitbot-mac-<v>.zip at build time) are skipped without it; the unavailable path runs instead.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { issuePairingCode } from "../src/auth";
import { canonicalCommand, deviceCommandKey, deviceHub, RECORDER_FEATURES } from "../src/device-hub";
import { INSTALL_PS1_SHA256, INSTALL_SH_SHA256, RECORDER_MAC_VERSION, RECORDER_MAC_ZIP_SHA256, RECORDER_VERSION } from "../src/generated";
import { installCommand, installerUrl, macInstallCommand, verifyInstallerToken } from "../src/installer";
import { hmacHex, now } from "../src/util";
import { call, connectDevice, mcp, ORIGIN, seedAccount, seedDevice, withEnv } from "./helpers";

const HAS_MAC = RECORDER_MAC_VERSION !== "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const linkPath = (url: string) => new URL(url).pathname;
const sha256Upper = async (buf: ArrayBuffer) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
const enroll = (code: string, extra: Record<string, unknown> = {}) =>
  call("/device/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "mac", ...extra }) });
const FAKE_SHA = "A".repeat(64);

/** The checks every Mac command must pass: download to a file, verify, then run; never piped into a shell. */
function expectMacCommand(cmd: string, origin: string, code: string, sha: string, account: string) {
  expect(cmd.startsWith("/bin/bash -c '")).toBe(true);
  expect(cmd.endsWith("'")).toBe(true);
  const inner = cmd.slice("/bin/bash -c '".length, -1);
  expect(inner).not.toContain("'");
  expect(cmd).not.toMatch(/curl[^;]*\|\s*(ba)?sh/);
  expect(cmd).not.toMatch(/\|\s*(\/bin\/)?(ba|z)?sh\b/);
  expect(inner).toContain(`curl -fsSL --proto =https -o "$f" ${origin}/install.sh || `);
  expect(inner).toContain(`[ "$(shasum -a 256 "$f" | cut -c1-64 | tr a-f A-F)" = "${sha}" ] || `);
  expect(inner).toContain(`RECITBOT_PAIRING_CODE=${code} /bin/bash "$f" --server ${origin} --account ${account}`);
  expect(inner).toContain("RECITBOT_INSTALL_FAILED: install.sh SHA-256 mismatch");
  // Download, then hash check, then run.
  expect(inner.indexOf("curl ")).toBeLessThan(inner.indexOf("shasum"));
  expect(inner.indexOf("shasum")).toBeLessThan(inner.indexOf("RECITBOT_PAIRING_CODE="));
  // The pairing code is never in a URL.
  expect(inner).not.toMatch(new RegExp(`https?://\\S*${code}`));
}

describe("macInstallCommand", () => {
  it("downloads install.sh to a temp file, checks its SHA-256, runs it with the code in the environment", () => {
    const cmd = macInstallCommand("https://example.test", "CODEcode0123456789", "ACCTacct0123456789AB", FAKE_SHA);
    expectMacCommand(cmd, "https://example.test", "CODEcode0123456789", FAKE_SHA, "ACCTacct0123456789AB");
    expect(cmd).toBe(
      `/bin/bash -c 'f=$(mktemp "\${TMPDIR:-/tmp}/recitbot-install-XXXXXXXX") || exit 1; trap "rm -f \\"$f\\"" EXIT; ` +
        `curl -fsSL --proto =https -o "$f" https://example.test/install.sh || { echo "RECITBOT_INSTALL_FAILED: install.sh download failed"; exit 1; }; ` +
        `[ "$(shasum -a 256 "$f" | cut -c1-64 | tr a-f A-F)" = "${FAKE_SHA}" ] || { echo "RECITBOT_INSTALL_FAILED: install.sh SHA-256 mismatch"; exit 1; }; ` +
        `RECITBOT_PAIRING_CODE=CODEcode0123456789 /bin/bash "$f" --server https://example.test --account ACCTacct0123456789AB'`,
    );
  });
});

describe("installer commands carry the account (re-pairing reuses the device row)", () => {
  it("windows: install.ps1 -Account <account id>", () => {
    const cmd = installCommand("https://example.test", "CODEcode0123456789", "ACCTacct0123456789AB");
    expect(cmd).toContain("-Server 'https://example.test' -Code 'CODEcode0123456789' -Account 'ACCTacct0123456789AB';");
    expect(cmd.slice(cmd.indexOf('"') + 1, -1)).not.toMatch(/[$"%!`\\]/);
  });

  it("macos: install.sh --account <account id>", () => {
    expect(macInstallCommand("https://example.test", "CODEcode0123456789", "ACCTacct0123456789AB", FAKE_SHA)).toContain(
      `RECITBOT_PAIRING_CODE=CODEcode0123456789 /bin/bash "$f" --server https://example.test --account ACCTacct0123456789AB'`,
    );
  });

  it("an account id outside ^[A-Za-z0-9]{1,64}$ (what install.ps1/install.sh accept) is refused", () => {
    for (const bad of ["", "a'b", "a b", "a;rm", "x".repeat(65)]) {
      expect(() => installCommand("https://example.test", "CODEcode0123456789", bad)).toThrow();
      expect(() => macInstallCommand("https://example.test", "CODEcode0123456789", bad, FAKE_SHA)).toThrow();
    }
  });
});

describe("get_installer platform", () => {
  it("windows: unchanged shape, no Mac fields (explicit, or omitted on a Windows-only account)", async () => {
    const { key } = await seedAccount(true);
    for (const args of [{}, { platform: "windows" }]) {
      const d = (await mcp("get_installer", args, key)).data;
      expect(d.platform).toBe("windows");
      expect(d.command.startsWith("powershell.exe ")).toBe(true);
      expect(d.install_ps1_sha256).toBe(INSTALL_PS1_SHA256);
      expect(d.powershell).toBe(d.command);
      expect(d).not.toHaveProperty("install_sh_sha256");
      expect(linkPath(d.download_url)).toMatch(/^\/i\/v1\.install\./);
    }
  });

  it("rejects an unknown platform", async () => {
    const { key } = await seedAccount(false);
    const r = await mcp("get_installer", { platform: "linux" }, key);
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe("INVALID_ARGUMENTS");
  });

  it("the tool description tells the bot about macos and the result markers and exit codes", async () => {
    const res = await call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${(await seedAccount(false)).key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const tools = ((await res.json()) as any).result.tools as { name: string; description: string; inputSchema: any }[];
    const t = tools.find((x) => x.name === "get_installer")!;
    expect(t.description).toContain('platform "macos"');
    expect(t.description).toContain("RECITBOT_INSTALL_OK");
    expect(t.description).toContain("RECITBOT_INSTALL_FAILED");
    for (const n of [1, 2, 3, 4, 5]) expect(t.description).toContain(`${n} (`);
    expect(t.inputSchema.properties.platform.enum).toEqual(["windows", "macos"]);
    expect(t.inputSchema.required ?? []).not.toContain("platform");
    expect(t.inputSchema.properties.platform.description).toMatch(/ask the user "Windows or Mac\?".*never guess/);
    expect(t.description).toContain('ask the user "Windows or Mac?"');
    expect(t.description).toContain("never guess");
    expect(t.description).toMatch(/platform "windows" to get a PowerShell one-liner/);
    expect(t.description).toMatch(/platform "macos" to get a bash one-liner that runs install\.sh after checking its pinned SHA-256/);
    expect(t.description).toMatch(/Omitted platform: only when every paired device on the account is the same platform/);
    expect(t.description).toMatch(/no paired device, or devices on both platforms, the result is needs_choice:true with no command/);
    expect(t.inputSchema.properties.platform.description).toMatch(/needs_choice/);
  });

  /** needs_choice: no command, no link, no pairing code issued. */
  async function expectAsks(key: string, accountId: string) {
    const before = await env.DB.prepare("SELECT count(*) AS n FROM pairing_codes WHERE account_id = ?").bind(accountId).first<{ n: number }>();
    const r = await mcp("get_installer", {}, key);
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ needs_choice: true, choices: ["windows", "macos"], question: "Windows or Mac?" });
    expect(r.data.note).toContain('Ask the user "Windows or Mac?"');
    for (const f of ["command", "download_url", "pairing_code", "powershell", "platform"]) expect(r.data).not.toHaveProperty(f);
    const after = await env.DB.prepare("SELECT count(*) AS n FROM pairing_codes WHERE account_id = ?").bind(accountId).first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
    return r.data;
  }

  it("Windows-only account (or a pre-platform device row): omitted = windows command; macos = the Mac command", async () => {
    const { key, accountId, deviceId } = await seedAccount(true);
    expect((await mcp("get_installer", {}, key)).data.platform).toBe("windows");
    await env.DB.prepare("UPDATE devices SET platform = 'windows' WHERE id = ?").bind(deviceId).run();
    await seedDevice(accountId, "second pc");
    const d = (await mcp("get_installer", {}, key)).data;
    expect(d.platform).toBe("windows");
    expect(d.command.startsWith("powershell.exe ")).toBe(true);
    // The user names the Mac: that wins over the paired devices.
    const m = await mcp("get_installer", { platform: "macos" }, key);
    if (!HAS_MAC) {
      expect(m.data.error).toBe("MAC_INSTALLER_UNAVAILABLE");
      return;
    }
    expect(m.data.platform).toBe("macos");
    expect(m.data).not.toHaveProperty("powershell");
    expectMacCommand(m.data.command, ORIGIN, m.data.pairing_code, INSTALL_SH_SHA256, accountId);
  });

  it("Mac-only account: omitted = the Mac command (or MAC_INSTALLER_UNAVAILABLE, never the PowerShell one)", async () => {
    const { key, accountId, deviceId } = await seedAccount(true);
    await env.DB.prepare("UPDATE devices SET platform = 'macos' WHERE id = ?").bind(deviceId).run();
    const r = await mcp("get_installer", {}, key);
    if (!HAS_MAC) {
      expect(r.data.error).toBe("MAC_INSTALLER_UNAVAILABLE");
      return;
    }
    expect(r.data.platform).toBe("macos");
    expectMacCommand(r.data.command, ORIGIN, r.data.pairing_code, INSTALL_SH_SHA256, accountId);
  });

  it("no paired device + omitted platform: asks Windows or Mac, issues nothing", async () => {
    const { key, accountId } = await seedAccount(false);
    const d = await expectAsks(key, accountId);
    expect(d).toMatchObject({ paired_devices: 0, max_devices: 2, devices: [] });
    expect(d.note).toContain("No device is paired yet.");
    expect((await mcp("get_installer", { platform: "windows" }, key)).data.command.startsWith("powershell.exe ")).toBe(true);
  });

  it("devices on both platforms + omitted platform: asks Windows or Mac, issues nothing", async () => {
    const { key, accountId, deviceId } = await seedAccount(true);
    const mac = await seedDevice(accountId, "macbook");
    await env.DB.prepare("UPDATE devices SET platform = 'macos' WHERE id = ?").bind(mac.deviceId).run();
    const d = await expectAsks(key, accountId);
    expect(d.paired_devices).toBe(2);
    expect(d.devices).toEqual(
      expect.arrayContaining([
        { device_id: deviceId, name: "test pc", platform: "windows" },
        { device_id: mac.deviceId, name: "macbook", platform: "macos" },
      ]),
    );
    expect(d.note).toContain("both Windows and Mac");
    expect((await mcp("get_installer", { platform: "windows" }, key)).data.platform).toBe("windows");
  });

  it.skipIf(HAS_MAC)("macos without a Mac recorder on the server: MAC_INSTALLER_UNAVAILABLE, no pairing code issued", async () => {
    const { key, accountId } = await seedAccount(false);
    const r = await mcp("get_installer", { platform: "macos" }, key);
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe("MAC_INSTALLER_UNAVAILABLE");
    const n = await env.DB.prepare("SELECT count(*) AS n FROM pairing_codes WHERE account_id = ?").bind(accountId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it.skipIf(!HAS_MAC)("macos: verified bash command, mac_install link, install_sh_sha256, expiry, pairs a Mac", async () => {
    const { key, accountId } = await seedAccount(false);
    const t = now();
    const r = await mcp("get_installer", { platform: "macos" }, key);
    expect(r.isError).toBe(false);
    const d = r.data;
    expect(d.platform).toBe("macos");
    expect(d.install_sh_sha256).toBe(INSTALL_SH_SHA256);
    expect(d).not.toHaveProperty("powershell");
    expect(d).not.toHaveProperty("install_ps1_sha256");
    expectMacCommand(d.command, ORIGIN, d.pairing_code, INSTALL_SH_SHA256, accountId);
    expect(d.expires_at).toBeGreaterThanOrEqual(t);
    expect(linkPath(d.download_url)).toMatch(/^\/i\/v1\.mac_install\.[A-Za-z0-9]+\.\d+\.[A-Za-z0-9]+\.[A-Za-z0-9]+\.[A-Za-z0-9_-]{43}$/);
    expect(d.uninstall).toBe(`Run ~/Library/Application Support/Recitbot/uninstall.sh (also served at ${ORIGIN}/uninstall.sh).`);
    const recit = (await mcp("get_installer", { platform: "macos" }, key, withEnv({ PUBLIC_BASE_URL: "https://example.test" }))).data;
    expect(recit.command).toContain(`--server https://example.test --account ${accountId}'`);
    // The Mac that enrolls with this code is recorded as a Mac.
    const dev = (await (await enroll(d.pairing_code)).json()) as any;
    expect((await env.DB.prepare("SELECT platform FROM devices WHERE id = ?").bind(dev.device_id).first<{ platform: string }>())!.platform).toBe("macos");
  });
});

describe("pairing code platform", () => {
  it("is stored with the code and copied onto a device that reports none (the Mac recorder); a reported platform wins", async () => {
    const { accountId } = await seedAccount(false);
    const mac = await issuePairingCode(env, accountId, 600, "macos");
    const a = (await (await enroll(mac.code, { name: "Mac" })).json()) as any;
    expect((await env.DB.prepare("SELECT platform FROM devices WHERE id = ?").bind(a.device_id).first<{ platform: string }>())!.platform).toBe("macos");
    const other = await seedAccount(false);
    const mac2 = await issuePairingCode(env, other.accountId, 600, "macos");
    const r = (await (await enroll(mac2.code, { name: "pc", platform: "windows" })).json()) as any;
    expect((await env.DB.prepare("SELECT platform FROM devices WHERE id = ?").bind(r.device_id).first<{ platform: string }>())!.platform).toBe("windows");
    const win = await issuePairingCode(env, accountId, 600);
    const b = (await (await enroll(win.code, { name: "pc" })).json()) as any;
    expect((await env.DB.prepare("SELECT platform FROM devices WHERE id = ?").bind(b.device_id).first<{ platform: string }>())!.platform).toBe("windows");
  });
});

describe("mac /i/ links", () => {
  const acct = "AAAAAAAAAAAAAAAAAAAAAA";
  const code = "CODEcode0123456789";

  it("mac_install carries a code, mac_update does not; both verify", async () => {
    await expect(installerUrl(env, ORIGIN, { purpose: "mac_install", accountId: acct, expiresAt: now() + 60 })).rejects.toThrow();
    await expect(installerUrl(env, ORIGIN, { purpose: "mac_update", accountId: acct, expiresAt: now() + 60, code })).rejects.toThrow();
    const i = await installerUrl(env, ORIGIN, { purpose: "mac_install", accountId: acct, expiresAt: now() + 60, code });
    expect(await verifyInstallerToken(env, linkPath(i).slice(3))).toMatchObject({ ok: true, token: { purpose: "mac_install", code } });
    const u = await installerUrl(env, ORIGIN, { purpose: "mac_update", accountId: acct, expiresAt: now() + 60 });
    expect(linkPath(u)).toMatch(/^\/i\/v1\.mac_update\.[A-Za-z0-9]+\.\d+\.[A-Za-z0-9]+\.\.[A-Za-z0-9_-]{43}$/);
    expect(await verifyInstallerToken(env, linkPath(u).slice(3))).toMatchObject({ ok: true, token: { purpose: "mac_update", code: null } });
    // A mac_install token without its code is malformed.
    const parts = linkPath(i).slice(3).split(".");
    expect(await verifyInstallerToken(env, [...parts.slice(0, 5), "", parts[6]].join("."))).toEqual({ ok: false, status: 404 });
  });

  it("mac_install serves a pre-paired bash script (recitbot-install.sh)", async () => {
    const url = await installerUrl(env, ORIGIN, { purpose: "mac_install", accountId: acct, expiresAt: now() + 60, code });
    const res = await call(linkPath(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="recitbot-install.sh"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const script = await res.text();
    expect(script.startsWith("#!/bin/bash\n# Recitbot recorder installer from ")).toBe(true);
    expect(script).toContain("bash ~/Downloads/recitbot-install.sh");
    expect(script).not.toContain("\r");
    const last = script.trimEnd().split("\n").at(-1)!;
    expect(`/bin/bash -c '${last}'`).toBe(macInstallCommand(ORIGIN, code, acct));
  });

  it.skipIf(!HAS_MAC)("mac_update serves install.sh itself (the pinned hash)", async () => {
    const url = await installerUrl(env, ORIGIN, { purpose: "mac_update", accountId: acct, expiresAt: now() + 60 });
    const res = await call(linkPath(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="recitbot-update.sh"');
    expect(await sha256Upper(await res.arrayBuffer())).toBe(INSTALL_SH_SHA256);
  });

  it.skipIf(HAS_MAC)("mac_update without a Mac recorder on the server: 503", async () => {
    const url = await installerUrl(env, ORIGIN, { purpose: "mac_update", accountId: acct, expiresAt: now() + 60 });
    expect((await call(linkPath(url))).status).toBe(503);
  });
});

describe.skipIf(!HAS_MAC)("Mac static files", () => {
  it("/install.sh: shell script type, hash = INSTALL_SH_SHA256, carries the zip hash and version", async () => {
    const res = await call("/install.sh");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    const buf = await res.arrayBuffer();
    expect(await sha256Upper(buf)).toBe(INSTALL_SH_SHA256);
    const text = new TextDecoder().decode(buf);
    expect(text.startsWith("#!/bin/bash\n")).toBe(true);
    expect(text).not.toContain("\r");
    expect(text).toContain(`RecorderZipSha256='${RECORDER_MAC_ZIP_SHA256}'`);
    expect(text).toContain(`RecorderVersion='${RECORDER_MAC_VERSION}'`);
    expect(text).not.toMatch(/__[A-Z0-9_]+__/);
  });

  it("/Recitbot-mac-<version>.zip: application/zip, hash = RECORDER_MAC_ZIP_SHA256", async () => {
    const res = await call(`/Recitbot-mac-${RECORDER_MAC_VERSION}.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(await sha256Upper(await res.arrayBuffer())).toBe(RECORDER_MAC_ZIP_SHA256);
  });

  it("/uninstall.sh is served as a shell script", async () => {
    const res = await call("/uninstall.sh");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    expect((await res.text()).startsWith("#!/bin/bash\n")).toBe(true);
  });

  it("the Mac files are geo-gated like install.ps1", async () => {
    for (const p of ["/install.sh", "/uninstall.sh", `/Recitbot-mac-${RECORDER_MAC_VERSION}.zip`]) {
      expect((await call(p, { headers: { "cf-ipcountry": "DE" } })).status).toBe(451);
    }
  });
});

describe("update_recorder on a Mac", () => {
  async function pairedMac(hello: { version: string; features: string[] }) {
    const acct = await seedAccount();
    await env.DB.prepare("UPDATE devices SET platform = 'macos' WHERE id = ?").bind(acct.deviceId).run();
    const dev = await connectDevice(acct.deviceToken!);
    dev.ws.send(JSON.stringify({ type: "hello", ...hello }));
    for (let i = 0; i < 50; i++) {
      if ((await deviceHub(env, acct.accountId).recorderInfo(acct.accountId))?.version) break;
      await sleep(10);
    }
    return { ...acct, ...dev };
  }

  it.skipIf(!HAS_MAC)("pushes {mac_update url, RECORDER_MAC_VERSION, INSTALL_SH_SHA256}", async () => {
    const rec = await pairedMac({ version: "0.0.1", features: RECORDER_FEATURES.filter((f) => f !== "signed_update") });
    const r = (await mcp("update_recorder", {}, rec.key)).data;
    expect(r).toMatchObject({ current: "0.0.1", latest: RECORDER_MAC_VERSION, platform: "macos", action: "update_sent" });
    let f: any;
    for (let i = 0; i < 100 && !(f = rec.frames.find((x) => x.type === "update")); i++) await sleep(10);
    const { mac, ...rest } = f;
    expect(mac).toBe(await hmacHex(await deviceCommandKey(env, rec.deviceId!), canonicalCommand(rest)));
    expect(f).toMatchObject({ version: RECORDER_MAC_VERSION, sha256: INSTALL_SH_SHA256 });
    expect(await verifyInstallerToken(env, linkPath(f.url).slice(3))).toMatchObject({ ok: true, token: { purpose: "mac_update", code: null } });
    const latest = (await mcp("get_latest", {}, rec.key)).data;
    expect(latest).toMatchObject({ platform: "macos", recorder: { version: RECORDER_MAC_VERSION, install_sh_sha256: INSTALL_SH_SHA256 } });
  });

  it.skipIf(HAS_MAC)("without a Mac recorder on the server: MAC_INSTALLER_UNAVAILABLE, nothing sent", async () => {
    const rec = await pairedMac({ version: "0.0.1", features: RECORDER_FEATURES.filter((f) => f !== "signed_update") });
    const r = await mcp("update_recorder", {}, rec.key);
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe("MAC_INSTALLER_UNAVAILABLE");
    await sleep(50);
    expect(rec.frames.some((x) => x.type === "update")).toBe(false);
    // get_latest still answers (the playbook), for Windows.
    expect((await mcp("get_latest", {}, rec.key)).data).toMatchObject({ platform: "windows", recorder: { version: RECORDER_VERSION } });
  });

  it("a Windows device still gets install.ps1", async () => {
    const acct = await seedAccount();
    const latest = (await mcp("get_latest", {}, acct.key)).data;
    expect(latest).toMatchObject({ platform: "windows", recorder: { version: RECORDER_VERSION, install_ps1_sha256: INSTALL_PS1_SHA256 } });
    expect(linkPath(latest.installer.download_url)).toMatch(/^\/i\/v1\.update\./);
  });
});
