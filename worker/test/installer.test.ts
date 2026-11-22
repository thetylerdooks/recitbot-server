// Bot-run install and pairing (get_installer command + signed /i/ links), recorder self-update (update_recorder) and
// the server-carried playbook (get_latest, initialize instructions).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canonicalCommand, deviceCommandKey, deviceHub, RECORDER_FEATURES } from "../src/device-hub";
import { LIMITS } from "../src/env";
import { INSTALL_PS1_SHA256, RECORDER_VERSION } from "../src/generated";
import { compareVersions, installerUrl, verifyInstallerToken } from "../src/installer";
import { FREE_PLAN, MCP_INSTRUCTIONS, PLAYBOOK_TEXT, PLAYBOOK_VERSION } from "../src/playbook";
import { hmacHex, now, redact, sha256Hex } from "../src/util";
import { call, connectDevice, mcp, ORIGIN, seedAccount, suspendAccount, withEnv } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 0.6.1's features (no signed_update): the hash-pinned update path. Signed updates: signed-update.test.ts.
const ALL = RECORDER_FEATURES.filter((f) => f !== "signed_update");
const OLD = ALL.filter((f) => f !== "self_update");

const enroll = (code: string) =>
  call("/device/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "pc" }) });

const sha256Upper = async (buf: ArrayBuffer) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();

const linkPath = (url: string) => new URL(url).pathname;

/** A paired, connected recorder that said hello with `version` and `features` (null = never said hello). */
async function recorder(hello: { version: string; features: string[] } | null) {
  const acct = await seedAccount();
  const dev = await connectDevice(acct.deviceToken!);
  if (hello) {
    dev.ws.send(JSON.stringify({ type: "hello", ...hello }));
    for (let i = 0; i < 50; i++) {
      if ((await deviceHub(env, acct.accountId).recorderInfo(acct.accountId))?.version) break;
      await sleep(10);
    }
  }
  return { ...acct, ...dev };
}

async function frame(frames: any[], type: string) {
  for (let i = 0; i < 100 && !frames.some((x) => x.type === type); i++) await sleep(10);
  return frames.find((x) => x.type === type);
}

describe("get_installer", () => {
  it("returns a no-prompt powershell.exe command, a signed download link, expiry and platform", async () => {
    const { key, accountId } = await seedAccount(false);
    const t = now();
    const r = await mcp("get_installer", { platform: "windows" }, key);
    expect(r.isError).toBe(false);
    const d = r.data;
    expect(d.platform).toBe("windows");
    expect(d.install_ps1_sha256).toBe(INSTALL_PS1_SHA256);
    expect(d.expires_at).toBeGreaterThanOrEqual(t + LIMITS.pairingCodeSeconds);
    expect(d.expires_at).toBeLessThanOrEqual(now() + LIMITS.pairingCodeSeconds);
    expect(d.command.startsWith('powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "')).toBe(true);
    expect(d.command.endsWith('"')).toBe(true);
    // One quoted argument that cmd, PowerShell and bash (WSL) all pass through untouched.
    expect(d.command.slice(d.command.indexOf('"') + 1, -1)).not.toMatch(/[$"%!`\\]/);
    expect(d.command).toContain(`-Uri '${ORIGIN}/install.ps1'`);
    expect(d.command).toContain(`.Hash -ne '${INSTALL_PS1_SHA256}'`);
    expect(d.command).toContain(`-NonInteractive -ExecutionPolicy Bypass -File (gv f -ValueOnly) -Server '${ORIGIN}' -Code '${d.pairing_code}' -Account '${accountId}';`);
    expect(d.command).toContain("RECITBOT_INSTALL_FAILED: ");
    expect(d.command).not.toMatch(/\|\s*iex|Invoke-Expression/i);
    expect(d.powershell).toBe(d.command);
    const link = new URL(d.download_url);
    expect(link.origin).toBe(ORIGIN);
    expect(link.pathname).toMatch(/^\/i\/v1\.install\.[A-Za-z0-9]+\.\d+\.[A-Za-z0-9]+\.[A-Za-z0-9]+\.[A-Za-z0-9_-]{43}$/);
    expect(link.search).toBe("");
    expect(d.uninstall).toContain(`${ORIGIN}/uninstall.ps1`);
  });

  it("links and commands use PUBLIC_BASE_URL", async () => {
    const { key } = await seedAccount(false);
    const recit = withEnv({ PUBLIC_BASE_URL: "https://example.test" });
    const d = (await mcp("get_installer", { platform: "windows" }, key, recit)).data;
    expect(new URL(d.download_url).origin).toBe("https://example.test");
    expect(d.command).toContain("-Server 'https://example.test'");
  });

  it("the download link serves a pre-paired installer; the link is reusable within its TTL, the code is not", async () => {
    const { key, accountId } = await seedAccount(false);
    const d = (await mcp("get_installer", { platform: "windows" }, key)).data;
    const res = await call(linkPath(d.download_url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="recitbot-install.ps1"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const script = await res.text();
    expect(script).toContain(`-Code '${d.pairing_code}' -Account '${accountId}';`);
    expect(script).toContain(`'${INSTALL_PS1_SHA256}'`);
    expect(script).toContain(`-Uri '${ORIGIN}/install.ps1'`);
    expect(script.split("\r\n").at(-2)).toBe(d.command.slice(d.command.indexOf('"') + 1, -1));
    expect((await call(linkPath(d.download_url))).status).toBe(200);
    expect((await enroll(d.pairing_code)).status).toBe(200);
    expect((await enroll(d.pairing_code)).status).toBe(401);
  });

  it("device_status shows the PC paired after enrolling with the code; pairing a second PC keeps the first", async () => {
    const { key } = await seedAccount(false);
    expect((await mcp("device_status", {}, key)).data).toMatchObject({ paired: false, online: false, device: null, paired_devices: 0, max_devices: 2 });
    const first = (await (await enroll((await mcp("get_installer", { platform: "windows" }, key)).data.pairing_code)).json()) as any;
    const s1 = (await mcp("device_status", {}, key)).data;
    expect(s1.paired).toBe(true);
    expect(s1.device.id).toBe(first.device_id);
    const second = (await (await enroll((await mcp("get_installer", { platform: "windows" }, key)).data.pairing_code)).json()) as any;
    expect((await mcp("device_status", {}, key)).data.paired_devices).toBe(2);
    const rows = await env.DB.prepare("SELECT id FROM devices WHERE id IN (?, ?) AND revoked_at IS NULL").bind(first.device_id, second.device_id).all();
    expect(rows.results).toHaveLength(2);
  });

  it("the pairing code is stored hashed only", async () => {
    const { key } = await seedAccount(false);
    const d = (await mcp("get_installer", { platform: "windows" }, key)).data;
    const row = await env.DB.prepare("SELECT code_hash FROM pairing_codes WHERE code_hash = ?").bind(await sha256Hex(d.pairing_code)).first();
    expect(row).not.toBeNull();
    const raw = await env.DB.prepare("SELECT count(*) AS n FROM pairing_codes WHERE code_hash = ?").bind(d.pairing_code).first<{ n: number }>();
    expect(raw!.n).toBe(0);
  });

  it("is refused while the service is read-only", async () => {
    const { key } = await seedAccount(false);
    expect((await mcp("get_installer", {}, key, withEnv({ SERVICE_MODE: "READ_ONLY" }))).data.error).toBe("SERVICE_PAUSED");
  });

  it("a suspended account: get_installer and update_recorder refused, and a code issued before can't enroll a PC", async () => {
    const { accountId, key } = await seedAccount(false);
    const d = (await mcp("get_installer", { platform: "windows" }, key)).data;
    const action = await suspendAccount(accountId);
    const g = await mcp("get_installer", { platform: "windows" }, key);
    expect(g.isError).toBe(true);
    expect(g.data.error).toBe("ACCOUNT_SUSPENDED");
    const u = await mcp("update_recorder", {}, key);
    expect(u.data.error).toBe("ACCOUNT_SUSPENDED");
    const e = await enroll(d.pairing_code);
    expect(e.status).toBe(403);
    expect(await e.json()).toMatchObject({ error: "ACCOUNT_SUSPENDED" });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM devices WHERE account_id = ?").bind(accountId).first<{ n: number }>())!.n).toBe(0);
    // The code wasn't used up: after a restore it pairs.
    await env.DB.prepare("UPDATE admin_actions SET reversed_at = ?, reversed_by = 'test-operator' WHERE id = ?").bind(now(), action).run();
    expect((await enroll(d.pairing_code)).status).toBe(200);
  });
});

describe("signed installer links", () => {
  const acct = "BBBBBBBBBBBBBBBBBBBBBB";
  const code = "CODEcode0123456789";

  it("verify: valid, expired (410), tampered (403), malformed or unknown purpose (404)", async () => {
    const exp = now() + 60;
    const url = await installerUrl(env, ORIGIN, { purpose: "install", accountId: acct, expiresAt: exp, code });
    const token = linkPath(url).slice(3);
    expect(await verifyInstallerToken(env, token)).toEqual({ ok: true, token: { purpose: "install", accountId: acct, exp, code } });
    expect(await verifyInstallerToken(env, token, exp)).toEqual({ ok: false, status: 410 });
    const parts = token.split(".");
    const mac = parts[6];
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    const tampered = [
      [...parts.slice(0, 6), flip(mac)],
      [parts[0], parts[1], "DDDDDDDDDDDDDDDDDDDDDD", ...parts.slice(3)],
      [...parts.slice(0, 3), String(exp + 3600), ...parts.slice(4)],
      [...parts.slice(0, 5), "OTHERcode0123456789", mac],
      // An install link relabelled as an update link (code dropped to fit the update shape).
      [parts[0], "update", ...parts.slice(2, 5), "", mac],
    ];
    for (const p of tampered) expect(await verifyInstallerToken(env, p.join("."))).toEqual({ ok: false, status: 403 });
    for (const bad of [
      [parts[0], "admin", ...parts.slice(2)].join("."),
      [parts[0], "update", ...parts.slice(2)].join("."), // update links carry no code
      [...parts.slice(0, 5), "", mac].join("."), // install links need one
      "v2." + token.slice(3),
      "nonsense",
    ]) {
      expect(await verifyInstallerToken(env, bad)).toEqual({ ok: false, status: 404 });
    }
    const other = withEnv({ INSTALLER_URL_KEY: "another-key" });
    expect(await verifyInstallerToken(other, token)).toEqual({ ok: false, status: 403 });
  });

  it("route: 200 / 410 / 403 / 404 over HTTP, GET only", async () => {
    const ok = linkPath(await installerUrl(env, ORIGIN, { purpose: "install", accountId: acct, expiresAt: now() + 60, code }));
    expect((await call(ok)).status).toBe(200);
    expect((await call(ok, { method: "POST" })).status).toBe(404);
    const expired = linkPath(await installerUrl(env, ORIGIN, { purpose: "install", accountId: acct, expiresAt: now() - 1, code }));
    const gone = await call(expired);
    expect(gone.status).toBe(410);
    expect(await gone.text()).toMatch(/expired/);
    expect((await call(ok.slice(0, -1) + (ok.endsWith("A") ? "B" : "A"))).status).toBe(403);
    expect((await call("/i/whatever")).status).toBe(404);
  });

  it("update links serve install.ps1 itself (the pinned hash) and carry no pairing code", async () => {
    const url = await installerUrl(env, ORIGIN, { purpose: "update", accountId: acct, expiresAt: now() + 60 });
    expect(linkPath(url)).toMatch(/^\/i\/v1\.update\.[A-Za-z0-9]+\.\d+\.[A-Za-z0-9]+\.\.[A-Za-z0-9_-]{43}$/);
    const res = await call(linkPath(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="recitbot-update.ps1"');
    expect(await sha256Upper(await res.arrayBuffer())).toBe(INSTALL_PS1_SHA256);
  });

  it("an install link must carry a code and an update link must not", async () => {
    await expect(installerUrl(env, ORIGIN, { purpose: "install", accountId: acct, expiresAt: now() + 60 })).rejects.toThrow();
    await expect(installerUrl(env, ORIGIN, { purpose: "update", accountId: acct, expiresAt: now() + 60, code })).rejects.toThrow();
  });

  it("tokens never reach the logs", () => {
    expect(redact("GET /i/v1.install.BBBBBBBBBBBBBBBBBBBBBB.1731650600.nonce.CODEcode0123456789.mac 200")).toBe("GET /i/[REDACTED] 200");
  });
});

describe("update_recorder", () => {
  const behind = "0.0.1";

  it("not_paired, DEVICE_OFFLINE and unknown_version (no hello)", async () => {
    const unpaired = await seedAccount(false);
    expect((await mcp("update_recorder", {}, unpaired.key)).data).toMatchObject({ current: null, latest: RECORDER_VERSION, action: "not_paired" });
    const offline = await seedAccount();
    const off = await mcp("update_recorder", {}, offline.key);
    expect(off.isError).toBe(true);
    expect(off.data).toMatchObject({ error: "DEVICE_OFFLINE", device: offline.deviceId, latest: RECORDER_VERSION });
    const silent = await recorder(null);
    const r = (await mcp("update_recorder", {}, silent.key)).data;
    expect(r).toMatchObject({ current: null, action: "unknown_version" });
    expect(r.next_step).toMatch(/get_installer/);
  });

  it("up_to_date at or above the latest version", async () => {
    for (const version of [RECORDER_VERSION, "99.0.0"]) {
      const rec = await recorder({ version, features: ALL });
      expect((await mcp("update_recorder", {}, rec.key)).data).toEqual({
        current: version,
        device: rec.deviceId,
        device_name: "test pc",
        platform: "windows",
        latest: RECORDER_VERSION,
        action: "up_to_date",
      });
      expect(rec.frames.some((f) => f.type === "update")).toBe(false);
    }
  });

  it("an older recorder without self_update gets reinstall guidance and no command", async () => {
    const rec = await recorder({ version: behind, features: OLD });
    const r = (await mcp("update_recorder", {}, rec.key)).data;
    expect(r).toMatchObject({ current: behind, latest: RECORDER_VERSION, action: "reinstall_required" });
    expect(r.next_step).toMatch(/get_installer/);
    await sleep(50);
    expect(rec.frames.some((f) => f.type === "update")).toBe(false);
  });

  it("behind and self_update: sends a signed update command with the update link, hash and version", async () => {
    const rec = await recorder({ version: behind, features: ALL });
    const r = (await mcp("update_recorder", {}, rec.key)).data;
    expect(r).toMatchObject({ current: behind, latest: RECORDER_VERSION, action: "update_sent" });
    const f = await frame(rec.frames, "update");
    expect(f).toBeTruthy();
    const { mac, ...rest } = f;
    expect(mac).toBe(await hmacHex(await deviceCommandKey(env, rec.deviceId!), canonicalCommand(rest)));
    expect(canonicalCommand(rest)).toContain(`|url|${f.url}|upd|${RECORDER_VERSION}|${INSTALL_PS1_SHA256}`);
    expect(f).toMatchObject({ account_id: rec.accountId, device_id: rec.deviceId, version: RECORDER_VERSION, sha256: INSTALL_PS1_SHA256 });
    expect(f.exp).toBeGreaterThan(now());
    const token = await verifyInstallerToken(env, linkPath(f.url).slice(3));
    expect(token).toMatchObject({ ok: true, token: { purpose: "update", accountId: rec.accountId, code: null } });
    const res = await call(linkPath(f.url));
    expect(await sha256Upper(await res.arrayBuffer())).toBe(f.sha256);
  });

  it("keeps the recorder's update report and returns it as last_update", async () => {
    const rec = await recorder({ version: behind, features: ALL });
    await mcp("update_recorder", {}, rec.key);
    rec.ws.send(JSON.stringify({ type: "update", status: "failed", version: RECORDER_VERSION, error: "sha256 mismatch" }));
    rec.ws.send(JSON.stringify({ type: "update", status: "bogus", version: RECORDER_VERSION }));
    const hub = deviceHub(env, rec.accountId);
    for (let i = 0; i < 50 && !(await hub.lastUpdate(rec.accountId, rec.deviceId!)); i++) await sleep(10);
    const r = (await mcp("update_recorder", {}, rec.key)).data;
    expect(r.action).toBe("update_sent");
    expect(r.last_update).toMatchObject({ status: "failed", version: RECORDER_VERSION, error: "sha256 mismatch", device_id: rec.deviceId });
  });
});

describe("get_latest and the playbook", () => {
  it("returns the playbook, the recorder version and an update link, and mints no pairing code", async () => {
    const { accountId, key } = await seedAccount(false);
    const r = await mcp("get_latest", {}, key);
    expect(r.isError).toBe(false);
    const d = r.data;
    expect(d.playbook).toEqual({ version: PLAYBOOK_VERSION, text: PLAYBOOK_TEXT });
    expect(d.recorder).toEqual({ version: RECORDER_VERSION, install_ps1_sha256: INSTALL_PS1_SHA256 });
    expect(d.how_to_update).toMatch(/update_recorder/);
    const v = await verifyInstallerToken(env, linkPath(d.installer.download_url).slice(3));
    expect(v).toEqual({ ok: true, token: { purpose: "update", accountId, exp: d.installer.expires_at, code: null } });
    const codes = await env.DB.prepare("SELECT count(*) AS n FROM pairing_codes WHERE account_id = ?").bind(accountId).first<{ n: number }>();
    expect(codes!.n).toBe(0);
    expect((await mcp("get_latest", {})).status).toBe(401);
  });

  it("is versioned and quotes the real limits and defaults", () => {
    expect(PLAYBOOK_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d+$/);
    expect(PLAYBOOK_TEXT).toContain(PLAYBOOK_VERSION);
    for (const s of [
      "Free: 25 videos total, each up to 5 minutes (300 s)",
      "they never reset, deleting a video doesn't give one back",
      "Pro (upgrade; get_plan shows the plan): unlimited videos, up to 4 hours (14400 s) per recording",
      "14400 s, 4 hours, on Pro;",
      "up to 60 minutes per UTC day on Free and 600 on Pro,",
      "auto-delete 7 days after recording",
      `each viewer can open a video up to ${LIMITS.viewsPerViewerPerVideoPerDay} times per UTC day`,
      "free_limit_reached{limit,used}",
      "RECITBOT_INSTALL_OK",
      "download_url",
      "until the user approves",
      "update_recorder",
    ]) {
      expect(PLAYBOOK_TEXT).toContain(s);
    }
    // Pro: up to 4 hours per recording and no daily count (storage is the limit).
    for (const s of ["30 minutes", "1800 s", "Daily recording limit reached", "recordings started per UTC day", "no time limit", "none on Pro"]) {
      expect(PLAYBOOK_TEXT).not.toContain(s);
    }
    expect(FREE_PLAN).toContain("Pro: unlimited videos, up to 4 hours per recording");
    expect(FREE_PLAN).not.toContain("no time limit");
    // Keyframes are described as get_recording_for_skill returns them now.
    expect(PLAYBOOK_TEXT).toContain("also sent to you as a JPEG image");
    expect(PLAYBOOK_TEXT).not.toContain("empty for now");
  });

  it("initialize returns the playbook summary as instructions", async () => {
    const res = await call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    });
    const instructions = ((await res.json()) as any).result.instructions;
    expect(instructions).toBe(MCP_INSTRUCTIONS);
    expect(instructions).toMatch(/get_installer.*device_status.*start_recording/);
    expect(instructions).toMatch(/never call list_devices\(refresh:true\) before a start/);
  });
});

// Same canonical form as the recorder selftests; their vectors use another host, so the HMAC differs.
describe("signing (same canonical form as the recorder selftest)", () => {
  it("the update block is signed after the url block, only on update commands", async () => {
    const f = {
      type: "update",
      recording_id: "AAAAAAAAAAAAAAAAAAAAAA",
      max_seconds: 0,
      mic: false,
      nonce: 1731650000000,
      exp: 1731650060,
      account_id: "BBBBBBBBBBBBBBBBBBBBBB",
      device_id: "CCCCCCCCCCCCCCCCCCCCCC",
      upload_token: "",
      url: "https://example.com/i/v1.update.BBBBBBBBBBBBBBBBBBBBBB.1731650600.NNNNNNNNNNNN.." + "M".repeat(43),
      version: "0.5.0",
      sha256: "6685944C4FFFC4F5B140100CEEB4BD6BC9663578062018C2E8B0756C7ECE7D9D",
    };
    expect(canonicalCommand(f).endsWith(`|1731650060|BBBBBBBBBBBBBBBBBBBBBB|CCCCCCCCCCCCCCCCCCCCCC||url|${f.url}|upd|0.5.0|${f.sha256}`)).toBe(true);
    expect(await hmacHex("test-device-secret", canonicalCommand(f))).toBe("d0eac8e70331874d67dccbea0846e53158cb226609ba45ad8556dc1424e0db84");
    const { version: _v, sha256: _s, ...plain } = f;
    expect(canonicalCommand(plain)).not.toMatch(/\|upd\|/);
  });

  it("compareVersions orders x.y.z numerically", () => {
    expect(compareVersions("0.4.0", "0.5.0")).toBe(-1);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });
});
