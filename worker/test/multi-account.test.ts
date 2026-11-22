// One install paired with several accounts: each account pairs it as its own device row, and pairing for one account
// never revokes or changes another account's device, whatever name, IP, platform or token the recorder sends. Each
// account sees and drives only its own device and recordings; plan limits and the watermark follow the recording's
// account; uninstalling for one account leaves the others paired.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { verifyDeviceToken } from "../src/auth";
import { deviceHub, RECORDER_FEATURES } from "../src/device-hub";
import { LIMITS } from "../src/env";
import { RECORDER_VERSION } from "../src/generated";
import { call, connectDevice, mcp, MP4, ORIGIN, seedAccount, seedDevice } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error("timed out");
}

const IP = "203.0.113.7";

async function enroll(code: string, o: { name?: string; device_token?: string; platform?: string } = {}) {
  const res = await call("/device/enroll", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": IP },
    body: JSON.stringify({ code, name: "Desk", platform: "windows", ...o }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const code = async (key: string) => (await mcp("get_installer", { platform: "windows" }, key)).data.pairing_code as string;

const active = async (accountId: string) =>
  (await env.DB.prepare("SELECT id FROM devices WHERE account_id = ? AND revoked_at IS NULL ORDER BY rowid").bind(accountId).all<{ id: string }>()).results.map(
    (r) => r.id,
  );

describe("pairing one install with a second account", () => {
  it("same name, IP and platform, no token: a new device on the second account; the first account's device is untouched", async () => {
    const a = await seedAccount(false);
    const b = await seedAccount(false);
    const da = (await enroll(await code(a.key))).body;
    const db = await enroll(await code(b.key));
    expect(db.status).toBe(200);
    expect(db.body.account_id).toBe(b.accountId);
    expect(db.body.device_id).not.toBe(da.device_id);
    expect(await active(a.accountId)).toEqual([da.device_id]);
    expect(await active(b.accountId)).toEqual([db.body.device_id]);
    expect(await verifyDeviceToken(env, da.device_token)).toMatchObject({ deviceId: da.device_id, accountId: a.accountId });
    const row = await env.DB.prepare("SELECT revoked_at, revoke_reason, token_hash IS NOT NULL AS t FROM devices WHERE id = ?").bind(da.device_id).first();
    expect(row).toEqual({ revoked_at: null, revoke_reason: null, t: 1 });
  });

  it("the first account's token sent with the second account's code: a new device, the first one keeps its token", async () => {
    const a = await seedAccount(false);
    const b = await seedAccount(false);
    const da = (await enroll(await code(a.key))).body;
    const db = await enroll(await code(b.key), { device_token: da.device_token });
    expect(db.status).toBe(200);
    expect(db.body.device_id).not.toBe(da.device_id);
    expect(await verifyDeviceToken(env, da.device_token)).toMatchObject({ deviceId: da.device_id, accountId: a.accountId });
    expect(await active(a.accountId)).toEqual([da.device_id]);
  });

  it("re-pairing the second account with its own token reuses its row; the first account's row stays", async () => {
    const a = await seedAccount(false);
    const b = await seedAccount(false);
    const da = (await enroll(await code(a.key))).body;
    const db = (await enroll(await code(b.key))).body;
    const again = (await enroll(await code(b.key), { device_token: db.device_token })).body;
    expect(again.device_id).toBe(db.device_id);
    expect(await active(a.accountId)).toEqual([da.device_id]);
    expect(await active(b.accountId)).toEqual([db.device_id]);
  });

  it("each account spends its own device slots: a full first account does not stop the second, and the reverse", async () => {
    const a = await seedAccount();
    await seedDevice(a.accountId, "Laptop");
    const b = await seedAccount(false);
    expect((await enroll(await code(b.key))).status).toBe(200);
    expect((await mcp("account_info", {}, a.key)).data.paired_devices).toBe(2);
    expect((await mcp("account_info", {}, b.key)).data.paired_devices).toBe(1);
    expect((await mcp("list_devices", {}, b.key)).data.paired_devices).toHaveLength(1);

    await seedDevice(b.accountId, "Laptop");
    const c = await seedAccount(false);
    expect((await enroll(await code(b.key), { name: "Third" })).status).toBe(409);
    expect((await enroll(await code(c.key), { name: "Third" })).status).toBe(200);
    expect(await active(a.accountId)).toHaveLength(2);
  });

  it("get_installer and the playbook describe adding an account to an installed computer as normal", async () => {
    const res = await call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const tools = ((await res.json()) as any).result.tools as { name: string; description: string }[];
    const desc = tools.find((t) => t.name === "get_installer")!.description;
    const playbook = (await mcp("get_latest", {}, (await seedAccount(false)).key)).data.playbook.text as string;
    for (const text of [desc, playbook.replace(/\s+/g, " ")]) {
      expect(text).toMatch(/several Recitbot accounts/);
      expect(text).toMatch(/that is normal/);
      expect(text).toMatch(/adds this account to that computer; nothing is reinstalled or wiped/);
    }
    expect(playbook).toMatch(/`full_removal: true` only when the user\s+explicitly asks/);
  });

  it("an uninstalled account's token blocks re-pairing that account (410), not pairing another one", async () => {
    const a = await seedAccount(false);
    const b = await seedAccount(false);
    const da = (await enroll(await code(a.key))).body;
    expect((await mcp("uninstall_recorder", {}, a.key)).isError).toBe(false);
    const db = await enroll(await code(b.key), { device_token: da.device_token });
    expect(db.status).toBe(200);
    expect(db.body.account_id).toBe(b.accountId);
    expect((await enroll(await code(a.key), { device_token: da.device_token })).status).toBe(410);
  });
});

/**
 * One install paired with accounts A and B: one socket per account, each with its own token, both announcing every
 * feature. remaining = the accounts_remaining the install acks an uninstall with.
 */
async function sharedInstall(remaining = 1) {
  const a = await seedAccount(false);
  const b = await seedAccount(false);
  const da = (await enroll(await code(a.key))).body;
  const db = (await enroll(await code(b.key))).body;
  const sock = async (token: string, accountId: string) => {
    const d = await connectDevice(token);
    d.ws.send(JSON.stringify({ type: "hello", version: RECORDER_VERSION, features: [...RECORDER_FEATURES] }));
    d.ws.addEventListener("message", (ev) => {
      const f = JSON.parse(ev.data as string);
      if (f.type === "uninstall") d.ws.send(JSON.stringify({ type: "uninstall_ack", request_id: f.recording_id, accounts_remaining: remaining }));
      if (f.type === "devices") d.ws.send(JSON.stringify({ type: "devices", request_id: f.recording_id, monitors: [], mics: [], cameras: [] }));
    });
    await waitFor(async () => !!(await deviceHub(env, accountId).recorderInfo(accountId))?.version);
    return { ...d, closed: new Promise<void>((r) => d.ws.addEventListener("close", () => r())) };
  };
  const wa = await sock(da.device_token, a.accountId);
  const wb = await sock(db.device_token, b.accountId);
  /** Closes both sockets and lets the hub finish with them before the test ends. */
  const done = async () => {
    for (const w of [wa, wb]) if (w.ws.readyState === WebSocket.OPEN) w.ws.close();
    await Promise.race([Promise.all([wa.closed, wb.closed]), sleep(500)]);
    await sleep(50);
  };
  return { a, b, da, db, wa, wb, done };
}

describe("isolation between accounts on one install", () => {
  it("B cannot list, check, drive, remove or uninstall A's device", async () => {
    const { a, b, da, db, wa, wb, done } = await sharedInstall();
    expect((await mcp("list_devices", {}, b.key)).data.paired_devices.map((d: any) => d.id)).toEqual([db.device_id]);
    expect((await mcp("list_devices", {}, a.key)).data.paired_devices.map((d: any) => d.id)).toEqual([da.device_id]);
    for (const [tool, args] of [
      ["device_status", { device: da.device_id }],
      ["list_devices", { device: da.device_id }],
      ["start_recording", { device: da.device_id, max_seconds: 10 }],
      ["remove_device", { device: da.device_id }],
      ["uninstall_recorder", { device_id: da.device_id }],
    ] as const) {
      const r = await mcp(tool, args, b.key);
      expect(r.isError, tool).toBe(true);
      expect(r.data.error, tool).toBe("DEVICE_NOT_FOUND");
    }
    expect(wa.frames.filter((f) => f.type !== "devices")).toEqual([]);
    expect(await active(a.accountId)).toEqual([da.device_id]);
    expect((await mcp("device_status", {}, a.key)).data).toMatchObject({ online: true, device: { id: da.device_id } });

    // B's start goes to B's own pairing only, signed for B.
    const s = await mcp("start_recording", { max_seconds: 10 }, b.key);
    expect(s.isError).toBe(false);
    await waitFor(() => wb.frames.some((f) => f.type === "start"));
    expect(wb.frames.find((f) => f.type === "start")).toMatchObject({ account_id: b.accountId, device_id: db.device_id });
    expect(wa.frames.some((f) => f.type === "start")).toBe(false);
    await done();
  });

  it("B cannot see, stop, change or delete A's recordings, and B's socket cannot report on them", async () => {
    const { a, b, da, wa, wb, done } = await sharedInstall();
    const s = await mcp("start_recording", { max_seconds: 10 }, a.key);
    expect(s.isError).toBe(false);
    const id = s.data.recording_id as string;
    const row = () => env.DB.prepare("SELECT account_id, device_id, status FROM recordings WHERE id = ?").bind(id).first();
    expect(await row()).toEqual({ account_id: a.accountId, device_id: da.device_id, status: "starting" });
    expect((await mcp("list_videos", {}, b.key)).data.recordings).toEqual([]);
    expect((await mcp("list_videos", {}, a.key)).data.recordings.map((r: any) => r.recording_id)).toEqual([id]);
    for (const [tool, args] of [
      ["get_video", { recording_id: id }],
      ["stop_recording", { recording_id: id }],
      ["update_video", { recording_id: id, title: "mine now" }],
      ["delete", { recording_id: id }],
    ] as const) {
      const r = await mcp(tool, args, b.key);
      expect(r.isError, tool).toBe(true);
    }
    expect((await mcp("stop_recording", {}, b.key)).data.error).toBe("NO_ACTIVE_RECORDING");
    wb.ws.send(JSON.stringify({ type: "status", recording_id: id, status: "failed", error: "spoofed" }));
    await sleep(50);
    expect(await row()).toEqual({ account_id: a.accountId, device_id: da.device_id, status: "starting" });
    expect(wa.frames.some((f) => f.type === "stop")).toBe(false);
    await done();
  });
});

describe("plan limits and watermark follow the recording's account", () => {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36";
  const WM = 'class="wm" id="wm"';

  async function readyAndShared(id: string, key: string): Promise<string> {
    await env.DB.prepare("UPDATE recordings SET status = 'ready' WHERE id = ?").bind(id).run();
    await env.MEDIA.put(`v/${id}.mp4`, MP4());
    expect((await mcp("share", { recording_id: id }, key)).isError).toBe(false);
    const url = (await mcp("get_video", { recording_id: id }, key)).data.url as string;
    return (await call(url.slice(ORIGIN.length), { headers: { "user-agent": UA } })).text();
  }

  it("A on Pro, B on Free, same install: each start gets its own account's limit, and only B's video is watermarked", async () => {
    const { a, b, da, db, wa, wb, done } = await sharedInstall();
    await env.DB.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(a.accountId).run();

    const over = await mcp("start_recording", { max_seconds: 600 }, b.key);
    expect(over.isError).toBe(true);
    expect(over.data).toMatchObject({ error: "LIMIT_EXCEEDED", max: 300, tier: "free" });

    const sb = await mcp("start_recording", {}, b.key);
    const sa = await mcp("start_recording", {}, a.key);
    expect([sa.isError, sb.isError]).toEqual([false, false]);
    await waitFor(() => wa.frames.some((f) => f.type === "start") && wb.frames.some((f) => f.type === "start"));
    expect(wb.frames.find((f) => f.type === "start")).toMatchObject({ account_id: b.accountId, device_id: db.device_id, max_seconds: 300 });
    expect(wa.frames.find((f) => f.type === "start")).toMatchObject({ account_id: a.accountId, device_id: da.device_id, max_seconds: LIMITS.recordingCeilingSeconds });
    const rows = await env.DB.prepare("SELECT account_id, max_seconds, expires_at IS NULL OR expires_at > ? AS kept FROM recordings WHERE id IN (?, ?) ORDER BY max_seconds")
      .bind(Math.floor(Date.now() / 1000) + 30 * 86400, sb.data.recording_id, sa.data.recording_id)
      .all();
    expect(rows.results).toEqual([
      { account_id: b.accountId, max_seconds: 300, kept: 0 },
      { account_id: a.accountId, max_seconds: LIMITS.recordingCeilingSeconds, kept: 1 },
    ]);

    expect(await readyAndShared(sb.data.recording_id, b.key)).toContain(WM);
    expect(await readyAndShared(sa.data.recording_id, a.key)).not.toContain(WM);
    await done();
  });
});

describe("uninstall on one account of a shared install", () => {
  it("default (account): only A's device goes; B stays paired, connected and able to record", async () => {
    const { a, b, da, db, wa, wb, done } = await sharedInstall(1);
    const aClosed = new Promise<number>((r) => wa.ws.addEventListener("close", (ev) => r(ev.code)));
    const r = await mcp("uninstall_recorder", {}, a.key);
    expect(r.isError).toBe(false);
    expect(wa.frames.find((f) => f.type === "uninstall")).toMatchObject({ scope: "account", account_id: a.accountId, device_id: da.device_id });
    expect(wb.frames.some((f) => f.type === "uninstall")).toBe(false);
    expect(r.data.uninstalled[0]).toMatchObject({ id: da.device_id, scope: "account", accounts_remaining: 1, pending_on_device: false });
    expect(r.data.message).toBe("This account was removed from Desk. Recitbot stays installed there for 1 other account.");
    expect(await aClosed).toBe(4001);

    expect(await active(a.accountId)).toEqual([]);
    expect(await active(b.accountId)).toEqual([db.device_id]);
    expect(await verifyDeviceToken(env, db.device_token)).toMatchObject({ deviceId: db.device_id, accountId: b.accountId });
    expect((await mcp("device_status", {}, b.key)).data).toMatchObject({ online: true, device: { id: db.device_id } });
    expect((await mcp("start_recording", { max_seconds: 10 }, b.key)).isError).toBe(false);
    await waitFor(() => wb.frames.some((f) => f.type === "start"));
    await done();
  });

  it("full_removal: scope all goes to A's pairing only; B's device row is never touched by A's call", async () => {
    const { a, b, db, wa, wb, done } = await sharedInstall(0);
    const r = await mcp("uninstall_recorder", { full_removal: true }, a.key);
    expect(wa.frames.find((f) => f.type === "uninstall").scope).toBe("all");
    expect(wb.frames.some((f) => f.type === "uninstall")).toBe(false);
    expect(r.data.message).toBe("Recitbot was removed from Desk.");
    expect(await active(b.accountId)).toEqual([db.device_id]);
    await done();
  });

  it("then the install's unsolicited uninstall_ack on B's socket removes B's own device (scope all), and nothing else", async () => {
    const { a, b, db, wb, done } = await sharedInstall(0);
    const laptop = await seedDevice(b.accountId, "laptop"); // B's other computer: must stay
    const bClosed = new Promise<number>((r) => wb.ws.addEventListener("close", (ev) => r(ev.code)));
    const revoked = () =>
      env.DB.prepare("SELECT account_id, scope FROM revoked_device_tokens WHERE device_id = ?").bind(db.device_id).first<{ account_id: string; scope: string }>();

    // Accounts still left on the install, or not an ack at all: nothing happens.
    wb.ws.send(JSON.stringify({ type: "uninstall_ack", accounts_remaining: 1 }));
    wb.ws.send(JSON.stringify({ type: "uninstall_ack" }));
    await sleep(100);
    expect(await active(b.accountId)).toEqual([db.device_id, laptop.deviceId]);

    expect((await mcp("uninstall_recorder", { full_removal: true }, a.key)).isError).toBe(false);
    // The exact frame the recorder sends over every other account's socket.
    wb.ws.send(JSON.stringify({ type: "uninstall_ack", accounts_remaining: 0 }));
    expect(await bClosed).toBe(4001);
    expect(await active(b.accountId)).toEqual([laptop.deviceId]);
    expect(await revoked()).toEqual({ account_id: b.accountId, scope: "all" });
    const again = await call("/device/ws", { headers: { upgrade: "websocket", authorization: `Bearer ${db.device_token}` } });
    expect(again.status).toBe(410);
    expect(await again.json()).toEqual({ error: "device_revoked", scope: "all" });
    expect(await verifyDeviceToken(env, laptop.token)).toMatchObject({ deviceId: laptop.deviceId, accountId: b.accountId });
    expect(await active(a.accountId)).toEqual([]);
    await done();
  });

  it("an ack with an unknown request_id and accounts_remaining 0 counts as the install removing itself too", async () => {
    const { a, da, wa, b, db, done } = await sharedInstall(0);
    const aClosed = new Promise<number>((r) => wa.ws.addEventListener("close", (ev) => r(ev.code)));
    wa.ws.send(JSON.stringify({ type: "uninstall_ack", request_id: "nobody-asked", accounts_remaining: 0 }));
    expect(await aClosed).toBe(4001);
    expect(await active(a.accountId)).toEqual([]);
    expect(
      await env.DB.prepare("SELECT scope FROM revoked_device_tokens WHERE device_id = ?").bind(da.device_id).first<{ scope: string }>(),
    ).toEqual({ scope: "all" });
    expect(await active(b.accountId)).toEqual([db.device_id]);
    await done();
  });
});
