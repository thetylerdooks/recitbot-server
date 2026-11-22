// uninstall_recorder: uninstall command over the device socket (ack or not), token hash and scope kept in
// revoked_device_tokens, device row deleted; revoked tokens get 410 device_revoked with the scope (HTTP, WebSocket,
// pairing). scope "account" by default, "all" only with full_removal. Re-pair reuses the device row when the token and
// platform match.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { verifyDeviceToken } from "../src/auth";
import { canonicalCommand, deviceCommandKey, RECORDER_FEATURES } from "../src/device-hub";
import { RECORDER_VERSION } from "../src/generated";
import { hmacHex, sha256Hex } from "../src/util";
import { call, connectDevice, mcp, seedAccount, seedDevice } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function enroll(code: string, body: Record<string, unknown> = {}) {
  const res = await call("/device/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: "pc", ...body }),
  });
  return { status: res.status, body: (await res.json()) as any };
}
const code = async (key: string) => (await mcp("get_installer", { platform: "windows" }, key)).data.pairing_code as string;
const deviceRow = (id: string) => env.DB.prepare("SELECT id FROM devices WHERE id = ?").bind(id).first();
const revokedRow = async (token: string) =>
  env.DB.prepare("SELECT device_id FROM revoked_device_tokens WHERE token_hash = ?").bind(await sha256Hex(token)).first<{ device_id: string }>();

const revokedScope = async (token: string) =>
  (await env.DB.prepare("SELECT scope FROM revoked_device_tokens WHERE token_hash = ?").bind(await sha256Hex(token)).first<{ scope: string }>())?.scope;

/**
 * Fake recorder that acks the uninstall command. multi: says hello with every feature (multi_account included) and acks
 * with accounts_remaining = remaining.
 */
async function ackingDevice(token: string, o: { multi?: boolean; remaining?: number } = {}) {
  const d = await connectDevice(token);
  if (o.multi) d.ws.send(JSON.stringify({ type: "hello", version: RECORDER_VERSION, features: [...RECORDER_FEATURES] }));
  d.ws.addEventListener("message", (ev) => {
    const f = JSON.parse(ev.data as string);
    if (f.type !== "uninstall") return;
    d.ws.send(JSON.stringify({ type: "uninstall_ack", request_id: f.recording_id, ...(o.remaining !== undefined && { accounts_remaining: o.remaining }) }));
  });
  await sleep(20);
  return d;
}

/** The frame's mac is the device key's HMAC of its canonical form. */
async function signedOk(f: any): Promise<boolean> {
  const { mac, ...rest } = f;
  return mac === (await hmacHex(await deviceCommandKey(env, f.device_id), canonicalCommand(rest)));
}

describe("uninstall_recorder", () => {
  it("online device: sends a signed uninstall, gets the ack, revokes the token and deletes the row", async () => {
    const { key, deviceId, deviceToken } = await seedAccount();
    const d = await ackingDevice(deviceToken!);
    const closed = new Promise<number>((r) => d.ws.addEventListener("close", (ev) => r(ev.code)));
    const r = await mcp("uninstall_recorder", { device_id: deviceId }, key);
    expect(r.isError).toBe(false);
    expect(r.data.pending_on_device).toBe(false);
    expect(r.data.uninstalled).toEqual([expect.objectContaining({ id: deviceId, was_online: true, pending_on_device: false })]);
    expect(r.data.message).toMatch(/removed/);
    const cmd = d.frames.find((f) => f.type === "uninstall");
    expect(cmd).toMatchObject({ device_id: deviceId, mac: expect.any(String) });
    expect(await deviceRow(deviceId!)).toBeNull();
    expect(await revokedRow(deviceToken!)).toEqual({ device_id: deviceId });
    expect(await verifyDeviceToken(env, deviceToken!)).toBeNull();
    expect(await closed).toBe(4001);
  });

  it("offline device: revoked and deleted anyway, pending_on_device with a plain line", async () => {
    const { key, deviceId, deviceToken } = await seedAccount();
    const r = await mcp("uninstall_recorder", { device_id: deviceId }, key);
    expect(r.isError).toBe(false);
    expect(r.data.pending_on_device).toBe(true);
    expect(r.data.uninstalled[0]).toMatchObject({ id: deviceId, was_online: false, pending_on_device: true });
    expect(r.data.message).toMatch(/next time it connects it removes this account, and Recitbot itself if no other account uses it/);
    expect(await deviceRow(deviceId!)).toBeNull();
    expect(await revokedRow(deviceToken!)).toEqual({ device_id: deviceId });
  });

  it("all:true uninstalls every device (one online acking, one offline)", async () => {
    const { accountId, key, deviceId, deviceToken } = await seedAccount();
    const other = await seedDevice(accountId, "laptop");
    const d = await ackingDevice(deviceToken!);
    const r = await mcp("uninstall_recorder", { all: true }, key);
    expect(r.isError).toBe(false);
    expect(r.data.pending_on_device).toBe(true);
    const by = Object.fromEntries(r.data.uninstalled.map((u: any) => [u.id, u.pending_on_device]));
    expect(by).toEqual({ [deviceId!]: false, [other.deviceId]: true });
    expect(r.data.paired_devices).toEqual([]);
    const left = await env.DB.prepare("SELECT count(*) AS n FROM devices WHERE account_id = ?").bind(accountId).first<{ n: number }>();
    expect(left!.n).toBe(0);
    expect(await revokedRow(other.token)).toEqual({ device_id: other.deviceId });
    d.ws.close();
  });

  it("device_id and all together is an error", async () => {
    const { key, deviceId } = await seedAccount();
    expect((await mcp("uninstall_recorder", { device_id: deviceId, all: true }, key)).isError).toBe(true);
    expect(await deviceRow(deviceId!)).not.toBeNull();
  });

  it("no arguments, several devices: needs_choice with the device list, nothing uninstalled", async () => {
    const { accountId, key, deviceId, deviceToken } = await seedAccount();
    const other = await seedDevice(accountId, "laptop");
    await env.DB.prepare("UPDATE devices SET platform = 'macos', last_seen_at = 1700000000 WHERE id = ?").bind(other.deviceId).run();
    const d = await connectDevice(deviceToken!);
    await sleep(20);
    const r = await mcp("uninstall_recorder", {}, key);
    expect(r.isError).toBe(false);
    expect(r.data.needs_choice).toBe(true);
    expect(r.data.uninstalled).toBeUndefined();
    expect(r.data.note).toMatch(/Ask the user which one/);
    expect(r.data.note).toMatch(/all of them/);
    const by = Object.fromEntries(r.data.devices.map((x: any) => [x.device_id, x]));
    expect(Object.keys(by).sort()).toEqual([deviceId, other.deviceId].sort());
    expect(Object.keys(by[deviceId!]).sort()).toEqual(["device_id", "last_seen", "name", "online", "platform"]);
    expect(by[deviceId!]).toMatchObject({ device_id: deviceId, name: "test pc", platform: "windows", online: true });
    expect(by[other.deviceId]).toEqual({ device_id: other.deviceId, name: "laptop", platform: "macos", online: false, last_seen: 1700000000 });
    expect(d.frames.some((f) => f.type === "uninstall")).toBe(false);
    expect(await deviceRow(deviceId!)).not.toBeNull();
    expect(await deviceRow(other.deviceId)).not.toBeNull();
    d.ws.close();
  });

  it("no arguments, exactly one device: uninstalls it directly", async () => {
    const { key, deviceId, deviceToken } = await seedAccount();
    const d = await ackingDevice(deviceToken!);
    const r = await mcp("uninstall_recorder", {}, key);
    expect(r.isError).toBe(false);
    expect(r.data.needs_choice).toBeUndefined();
    expect(r.data.uninstalled).toEqual([expect.objectContaining({ id: deviceId, was_online: true, pending_on_device: false })]);
    expect(d.frames.some((f) => f.type === "uninstall")).toBe(true);
    expect(await deviceRow(deviceId!)).toBeNull();
    expect(await revokedRow(deviceToken!)).toEqual({ device_id: deviceId });
  });

  it("description routes uninstall phrasings here and says the removal is complete and silent", async () => {
    const res = await call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const tools = ((await res.json()) as any).result.tools as { name: string; description: string }[];
    const desc = tools.find((t) => t.name === "uninstall_recorder")!.description;
    for (const p of [/uninstall Recitbot/, /remove the recorder/, /delete Recitbot from their computer/, /startup item/, /its data/, /no visible windows/]) {
      expect(desc).toMatch(p);
    }
  });

  it("revoked token: 410 device_revoked on the WebSocket (before upgrade) and on pairing; unknown token keeps 401", async () => {
    const { key, deviceId, deviceToken } = await seedAccount();
    await mcp("uninstall_recorder", { device_id: deviceId }, key);
    const ws = await call("/device/ws", { headers: { upgrade: "websocket", authorization: `Bearer ${deviceToken}` } });
    expect(ws.status).toBe(410);
    expect(ws.webSocket).toBeNull();
    expect(await ws.json()).toEqual({ error: "device_revoked", scope: "account" });
    const unknown = await call("/device/ws", { headers: { upgrade: "websocket", authorization: `Bearer ardt_${"a".repeat(22)}_${"b".repeat(43)}` } });
    expect(unknown.status).toBe(401);
    // Pairing (HTTP) with the revoked token: 410, the code is not consumed.
    const c = await code(key);
    const p = await enroll(c, { device_token: deviceToken, platform: "windows" });
    expect(p.status).toBe(410);
    expect(p.body).toEqual({ error: "device_revoked", scope: "account" });
    expect((await enroll(c, { platform: "windows" })).status).toBe(200);
  });
});

describe("uninstall scope", () => {
  it("default is account: a multi_account recorder gets a signed scope:'account' and its accounts_remaining is reported", async () => {
    const { key, deviceId, deviceToken } = await seedAccount();
    const d = await ackingDevice(deviceToken!, { multi: true, remaining: 2 });
    const r = await mcp("uninstall_recorder", { device_id: deviceId }, key);
    expect(r.isError).toBe(false);
    const cmd = d.frames.find((f) => f.type === "uninstall");
    expect(cmd.scope).toBe("account");
    expect(canonicalCommand(cmd)).toMatch(/\|scope\|account$/);
    expect(await signedOk(cmd)).toBe(true);
    expect(r.data.uninstalled[0]).toMatchObject({ id: deviceId, scope: "account", pending_on_device: false, accounts_remaining: 2 });
    expect(r.data.message).toBe("This account was removed from test pc. Recitbot stays installed there for 2 other accounts.");
    expect(await revokedScope(deviceToken!)).toBe("account");
    expect(await deviceRow(deviceId!)).toBeNull();
  });

  it("one other account: singular wording; none left: removed from the computer", async () => {
    const one = await seedAccount();
    await ackingDevice(one.deviceToken!, { multi: true, remaining: 1 });
    expect((await mcp("uninstall_recorder", {}, one.key)).data.message).toBe(
      "This account was removed from test pc. Recitbot stays installed there for 1 other account.",
    );
    const last = await seedAccount();
    await ackingDevice(last.deviceToken!, { multi: true, remaining: 0 });
    const r = await mcp("uninstall_recorder", {}, last.key);
    expect(r.data.uninstalled[0]).toMatchObject({ scope: "account", accounts_remaining: 0 });
    expect(r.data.message).toBe("Recitbot was removed from test pc.");
  });

  it("full_removal:true sends scope:'all' and keeps 'all' for the revoked token", async () => {
    const { key, deviceId, deviceToken } = await seedAccount();
    const d = await ackingDevice(deviceToken!, { multi: true, remaining: 0 });
    const r = await mcp("uninstall_recorder", { device_id: deviceId, full_removal: true }, key);
    expect(r.isError).toBe(false);
    const cmd = d.frames.find((f) => f.type === "uninstall");
    expect(cmd.scope).toBe("all");
    expect(await signedOk(cmd)).toBe(true);
    expect(r.data.uninstalled[0]).toMatchObject({ scope: "all", accounts_remaining: 0 });
    expect(r.data.message).toBe("Recitbot was removed from test pc.");
    expect(await revokedScope(deviceToken!)).toBe("all");
  });

  it("full_removal only accepts true", async () => {
    const { key, deviceId } = await seedAccount();
    expect((await mcp("uninstall_recorder", { device_id: deviceId, full_removal: false }, key)).isError).toBe(true);
    expect(await deviceRow(deviceId!)).not.toBeNull();
  });

  it("a recorder without multi_account gets no scope field or block (it removes itself completely, as before)", async () => {
    const { key, deviceId, deviceToken } = await seedAccount();
    const d = await ackingDevice(deviceToken!);
    const r = await mcp("uninstall_recorder", { device_id: deviceId }, key);
    const cmd = d.frames.find((f) => f.type === "uninstall");
    expect(cmd).not.toHaveProperty("scope");
    expect(canonicalCommand(cmd)).not.toMatch(/scope/);
    expect(await signedOk(cmd)).toBe(true);
    expect(r.data.uninstalled[0]).toMatchObject({ scope: "account", pending_on_device: false, accounts_remaining: 0 });
    expect(r.data.message).toBe("Recitbot was removed from test pc.");
  });

  it("offline: the scope waits for the device (410 carries it), account by default and all on request", async () => {
    const a = await seedAccount();
    const ra = await mcp("uninstall_recorder", {}, a.key);
    expect(ra.data.uninstalled[0]).toMatchObject({ scope: "account", pending_on_device: true, accounts_remaining: null });
    const wa = await call("/device/ws", { headers: { upgrade: "websocket", authorization: `Bearer ${a.deviceToken}` } });
    expect([wa.status, await wa.json()]).toEqual([410, { error: "device_revoked", scope: "account" }]);

    const b = await seedAccount();
    const rb = await mcp("uninstall_recorder", { full_removal: true }, b.key);
    expect(rb.data.uninstalled[0]).toMatchObject({ scope: "all", pending_on_device: true });
    expect(rb.data.message).toBe("test pc was unpaired and its key revoked; it'll remove Recitbot completely next time it connects.");
    const wb = await call("/device/ws", { headers: { upgrade: "websocket", authorization: `Bearer ${b.deviceToken}` } });
    expect([wb.status, await wb.json()]).toEqual([410, { error: "device_revoked", scope: "all" }]);
    const p = await enroll(await code(b.key), { device_token: b.deviceToken, platform: "windows" });
    expect([p.status, p.body]).toEqual([410, { error: "device_revoked", scope: "all" }]);
  });

  it("uninstalls from before scopes read as 'all'", async () => {
    const { deviceToken } = await seedAccount();
    const hash = await sha256Hex(deviceToken!);
    await env.DB.prepare("INSERT INTO revoked_device_tokens (token_hash, device_id, revoked_at) VALUES (?, 'old', 1)").bind(hash).run();
    await env.DB.prepare("DELETE FROM devices WHERE token_hash = ?").bind(hash).run();
    const ws = await call("/device/ws", { headers: { upgrade: "websocket", authorization: `Bearer ${deviceToken}` } });
    expect([ws.status, await ws.json()]).toEqual([410, { error: "device_revoked", scope: "all" }]);
  });
});

describe("re-pair by device token + platform", () => {
  it("reuses the device row (same id, new token) when token and platform match", async () => {
    const { accountId, key } = await seedAccount(false);
    const d1 = (await enroll(await code(key), { name: "Desk", platform: "windows" })).body;
    const again = await enroll(await code(key), { name: "Desk", platform: "windows", device_token: d1.device_token });
    expect(again.status).toBe(200);
    expect(again.body.device_id).toBe(d1.device_id);
    expect(again.body.device_token).not.toBe(d1.device_token);
    expect(await verifyDeviceToken(env, d1.device_token)).toBeNull();
    expect(await verifyDeviceToken(env, again.body.device_token)).toMatchObject({ deviceId: d1.device_id, accountId });
    const rows = await env.DB.prepare("SELECT id, revoked_at FROM devices WHERE account_id = ?").bind(accountId).all();
    expect(rows.results).toEqual([{ id: d1.device_id, revoked_at: null }]);
  });

  it("macos matches macos; another platform pairs a new device; 'mac' is not a platform", async () => {
    const { accountId, key } = await seedAccount(false);
    expect((await enroll(await code(key), { name: "Mac", platform: "mac" })).status).toBe(401);
    const m = (await enroll(await code(key), { name: "Mac", platform: "macos" })).body;
    const plat = await env.DB.prepare("SELECT platform FROM devices WHERE id = ?").bind(m.device_id).first<{ platform: string }>();
    expect(plat!.platform).toBe("macos");
    const same = (await enroll(await code(key), { name: "Mac", platform: "macos", device_token: m.device_token })).body;
    expect(same.device_id).toBe(m.device_id);
    const diff = await enroll(await code(key), { name: "Mac", platform: "windows", device_token: same.device_token });
    expect(diff.status).toBe(200);
    expect(diff.body.device_id).not.toBe(m.device_id);
    const n = await env.DB.prepare("SELECT count(*) AS n FROM devices WHERE account_id = ? AND revoked_at IS NULL").bind(accountId).first<{ n: number }>();
    expect(n!.n).toBe(2);
  });
});
