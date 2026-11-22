// The DeviceHub must be able to hibernate whenever no tool call is waiting on it. Production showed hubs billed 60 s of
// every minute: each reconnect wrote a close frame (4000 "replaced") into the recorder's abandoned socket, a write the
// dead peer never reads, and a pending write keeps a Durable Object in memory until the runtime drops that socket
// (minutes). evictDurableObject (hibernating WebSockets) waits for such work to finish and gives up after 30 s, so it
// is the test's "can this hub hibernate now?" probe; it also rebuilds the hub from scratch as a wake-up would.
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { deviceHub } from "../src/device-hub";
import { now } from "../src/util";
import { call, connectDevice, mcp, seedAccount, seedDevice } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HELLO = { type: "hello", version: "0.5.5", features: ["system_audio", "webcam_shape", "webcam_pct", "ready_push", "chunked_upload", "self_update", "multi_account"] };
const INVENTORY = { type: "devices", request_id: "", monitors: [], mics: [], cameras: [] };

type Att = { deviceId: string; version?: string; features?: string[]; replaced?: boolean; stale?: boolean; messageAt?: number };
const attachments = (accountId: string) =>
  runInDurableObject(deviceHub(env, accountId), (_, state) => state.getWebSockets().map((ws) => ws.deserializeAttachment() as Att));

/** Waits (polling the hub) until `ok` holds for its sockets' attachments. */
async function until(accountId: string, ok: (a: Att[]) => boolean): Promise<Att[]> {
  for (let i = 0; i < 100; i++) {
    const a = await attachments(accountId);
    if (ok(a)) return a;
    await sleep(20);
  }
  throw new Error(`hub never reached the expected state: ${JSON.stringify(await attachments(accountId))}`);
}

/**
 * Hibernates the hub; fails (instead of waiting 30 s) when it cannot go idle within `ms`. A hub that is not running has
 * already shut down on its own, which passes too.
 */
async function hibernate(accountId: string, ms = 5000): Promise<void> {
  await Promise.race([
    evictDurableObject(deviceHub(env, accountId)).catch((e) => {
      if (!String(e).includes("not currently running")) throw e;
    }),
    sleep(ms).then(() => {
      throw new Error(`hub did not go idle within ${ms} ms (pending I/O, timer or write)`);
    }),
  ]);
}

/** A recorder connection that keeps raw frames (connectDevice JSON-parses every frame, and "pong" is not JSON). */
async function connectRaw(token: string): Promise<{ ws: WebSocket; frames: string[] }> {
  const res = await call("/device/ws", { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } });
  const ws = res.webSocket!;
  ws.accept();
  const frames: string[] = [];
  ws.addEventListener("message", (ev) => frames.push(ev.data as string));
  return { ws, frames };
}

const nextFrame = (ws: WebSocket) =>
  new Promise<string>((resolve) => ws.addEventListener("message", (ev) => resolve(ev.data as string), { once: true }));

describe("DeviceHub hibernation", () => {
  it('answers the recorders\' exact "ping" with "pong" by auto-response (no wake-up), and records when', async () => {
    const acct = await seedAccount();
    const d = await connectRaw(acct.deviceToken!);
    const pair = await runInDurableObject(deviceHub(env, acct.accountId), (_, state) => {
      const p = state.getWebSocketAutoResponse();
      return p && { request: p.request, response: p.response };
    });
    expect(pair).toEqual({ request: "ping", response: "pong" });
    await hibernate(acct.accountId);
    const pong = nextFrame(d.ws);
    d.ws.send("ping");
    expect(await pong).toBe("pong");
    // The ping is not a message: no messageAt, but the auto-response timestamp is the heartbeat.
    const seen = await runInDurableObject(deviceHub(env, acct.accountId), (_, state) => {
      const ws = state.getWebSockets()[0];
      return { at: state.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0, messageAt: (ws.deserializeAttachment() as Att).messageAt };
    });
    expect(seen.at).toBeGreaterThan(Date.now() - 10_000);
    expect(seen.messageAt).toBeUndefined();
    d.ws.close();
  });

  it("rebuilds each socket's state from its attachment after hibernation (hello features, legacy recorders without hello)", async () => {
    const acct = await seedAccount();
    const legacy = await seedDevice(acct.accountId, "old pc");
    const modern = await connectDevice(acct.deviceToken!);
    modern.ws.send(JSON.stringify(HELLO));
    await until(acct.accountId, (a) => a.some((x) => x.version === "0.5.5"));
    const old = await connectDevice(legacy.token); // never says hello
    await until(acct.accountId, (a) => a.length === 2);

    await hibernate(acct.accountId);

    const hub = deviceHub(env, acct.accountId);
    expect(await hub.recorderInfo(acct.accountId, acct.deviceId)).toEqual({ device_id: acct.deviceId, version: "0.5.5", features: HELLO.features });
    expect(await hub.recorderInfo(acct.accountId, legacy.deviceId)).toEqual({ device_id: legacy.deviceId, version: null, features: [] });
    // Commands still reach both, each fitted to what it announced: scope only for the multi_account recorder.
    expect((await hub.sendCommand(acct.accountId, { type: "uninstall", recording_id: "r".repeat(20), scope: "account" }, acct.deviceId)).ok).toBe(true);
    expect((await hub.sendCommand(acct.accountId, { type: "uninstall", recording_id: "s".repeat(20), scope: "account" }, legacy.deviceId)).ok).toBe(true);
    await sleep(50);
    expect(modern.frames.at(-1)).toMatchObject({ type: "uninstall", scope: "account", device_id: acct.deviceId });
    expect(old.frames.at(-1)).toMatchObject({ type: "uninstall", device_id: legacy.deviceId });
    expect(old.frames.at(-1)).not.toHaveProperty("scope");
    modern.ws.close();
    old.ws.close();
  });

  it("an unsolicited uninstall_ack (no request_id, accounts_remaining 0) after hibernation revokes only that device and closes it", async () => {
    const acct = await seedAccount();
    const other = await seedDevice(acct.accountId, "other pc");
    const gone = await connectDevice(acct.deviceToken!);
    gone.ws.send(JSON.stringify(HELLO));
    const stays = await connectDevice(other.token);
    await until(acct.accountId, (a) => a.length === 2 && a.some((x) => x.version));
    await hibernate(acct.accountId);

    const closed = new Promise<number>((r) => gone.ws.addEventListener("close", (ev) => r(ev.code), { once: true }));
    gone.ws.send(JSON.stringify({ type: "uninstall_ack", accounts_remaining: 0 }));
    for (let i = 0; i < 100 && (await env.DB.prepare("SELECT 1 FROM devices WHERE id = ?").bind(acct.deviceId).first()); i++) await sleep(20);

    expect(await env.DB.prepare("SELECT 1 FROM devices WHERE id = ?").bind(acct.deviceId).first()).toBeNull();
    expect(await env.DB.prepare("SELECT scope FROM revoked_device_tokens WHERE device_id = ?").bind(acct.deviceId).first()).toEqual({ scope: "all" });
    expect(await env.DB.prepare("SELECT 1 AS ok FROM devices WHERE id = ?").bind(other.deviceId).first()).toEqual({ ok: 1 });
    expect(await Promise.race([closed, sleep(2000).then(() => "no close")])).toBe(4001);
    expect(await deviceHub(env, acct.accountId).online(acct.accountId)).toEqual([other.deviceId]);
    stays.ws.close();
  });

  it("an ack with accounts_remaining > 0, or one without a waiting request but some accounts left, changes nothing", async () => {
    const acct = await seedAccount();
    const d = await connectDevice(acct.deviceToken!);
    await hibernate(acct.accountId);
    d.ws.send(JSON.stringify({ type: "uninstall_ack", accounts_remaining: 1 }));
    d.ws.send(JSON.stringify({ type: "uninstall_ack", request_id: "nobody-waits", accounts_remaining: 2 }));
    await until(acct.accountId, (a) => a[0]?.messageAt !== undefined);
    await sleep(50);
    expect(await env.DB.prepare("SELECT 1 AS ok FROM devices WHERE id = ?").bind(acct.deviceId).first()).toEqual({ ok: 1 });
    expect(await deviceHub(env, acct.accountId).online(acct.accountId)).toEqual([acct.deviceId]);
    d.ws.close();
  });

  it("idle path: connect, hello, inventory, update report, ping and disconnect set no timer or alarm, and the hub can hibernate after each", async () => {
    const acct = await seedAccount();
    // Timers set from DeviceHub code (by stack); the test's own sleeps pass through.
    const timers: string[] = [];
    const wrap = <F extends (...args: any[]) => any>(orig: F) =>
      function (this: unknown, ...args: Parameters<F>) {
        const stack = new Error().stack ?? "";
        if (stack.includes("device-hub.ts")) timers.push(stack);
        return orig.apply(this, args);
      } as unknown as F;
    const [origTimeout, origInterval] = [globalThis.setTimeout, globalThis.setInterval];
    const st = vi.spyOn(globalThis, "setTimeout").mockImplementation(wrap(origTimeout));
    const si = vi.spyOn(globalThis, "setInterval").mockImplementation(wrap(origInterval));
    try {
      const d = await connectRaw(acct.deviceToken!);
      await hibernate(acct.accountId);
      d.ws.send(JSON.stringify(HELLO));
      d.ws.send(JSON.stringify(INVENTORY));
      d.ws.send(JSON.stringify({ type: "update", status: "installing", version: "0.5.6" }));
      await until(acct.accountId, (a) => a[0]?.version === "0.5.5");
      expect(await deviceHub(env, acct.accountId).lastDevices(acct.accountId, acct.deviceId!)).toMatchObject({ device_id: acct.deviceId });
      expect(await deviceHub(env, acct.accountId).lastUpdate(acct.accountId, acct.deviceId!)).toMatchObject({ status: "installing", version: "0.5.6" });
      await hibernate(acct.accountId);
      const pong = nextFrame(d.ws);
      d.ws.send("ping");
      expect(await pong).toBe("pong");
      await hibernate(acct.accountId);
      d.ws.close();
      await sleep(50);
      await hibernate(acct.accountId);
      expect(await runInDurableObject(deviceHub(env, acct.accountId), (_, state) => state.storage.getAlarm())).toBeNull();
    } finally {
      st.mockRestore();
      si.mockRestore();
    }
    expect(timers).toEqual([]);
  });

  it("a reconnect does not write into the abandoned socket: the hub still hibernates when the old peer reads nothing", async () => {
    const acct = await seedAccount();
    // The old connection's client end is never accepted, so nothing it is sent is ever read (a dead or wedged peer).
    // Before this fix the reconnect's close(4000) into it kept the hub from going idle (eviction timed out after 30 s).
    const wedged = await call("/device/ws", { headers: { upgrade: "websocket", authorization: `Bearer ${acct.deviceToken}` } });
    expect(wedged.status).toBe(101);
    const d = await connectDevice(acct.deviceToken!);
    await hibernate(acct.accountId);
    const a = await attachments(acct.accountId);
    expect(a.map((x) => !!x.replaced).sort()).toEqual([false, true]);
    // Commands go to the new socket only.
    expect((await deviceHub(env, acct.accountId).sendCommand(acct.accountId, { type: "stop", recording_id: "abcdefghij12" }, acct.deviceId)).ok).toBe(true);
    await sleep(50);
    expect(d.frames.at(-1)).toMatchObject({ type: "stop", recording_id: "abcdefghij12" });
    expect(await deviceHub(env, acct.accountId).online(acct.accountId)).toEqual([acct.deviceId]);
    d.ws.close();
  });

  it("a socket given up on for silence (stale, not closed) is online again once it pings", async () => {
    const acct = await seedAccount();
    const d = await connectRaw(acct.deviceToken!);
    await runInDurableObject(deviceHub(env, acct.accountId), (_, state) => {
      for (const ws of state.getWebSockets()) ws.serializeAttachment({ ...(ws.deserializeAttachment() as Att), connectedAt: Date.now() - 125_000 });
    });
    const hub = deviceHub(env, acct.accountId);
    expect(await hub.online(acct.accountId)).toEqual([]);
    expect((await attachments(acct.accountId))[0].stale).toBe(true);
    const pong = nextFrame(d.ws);
    d.ws.send("ping");
    expect(await pong).toBe("pong");
    expect(await hub.online(acct.accountId)).toEqual([acct.deviceId]);
    expect((await attachments(acct.accountId))[0].stale).toBe(false);
    d.ws.close();
  });

  it("disconnect last_seen_at: noted without I/O in the close handler, written to D1 by the next presence read", async () => {
    const acct = await seedAccount();
    const d = await connectDevice(acct.deviceToken!);
    const row = async () => (await env.DB.prepare("SELECT last_seen_at FROM devices WHERE id = ?").bind(acct.deviceId).first<{ last_seen_at: number }>())!.last_seen_at;
    // The connect is written by the Worker before the hub sees the socket.
    expect(await row()).toBeGreaterThanOrEqual(now() - 5);
    await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(now() - 3600, acct.deviceId).run();
    d.ws.close();
    for (let i = 0; i < 100; i++) {
      const pending = await runInDurableObject(deviceHub(env, acct.accountId), (_, state) => state.storage.kv.get<number>(`seen:${acct.deviceId}`));
      if (pending) break;
      await sleep(20);
    }
    expect(await row()).toBeLessThan(now() - 3000); // not written by the close event itself
    const listed = (await mcp("list_devices", {}, acct.key)).data.paired_devices.find((x: any) => x.id === acct.deviceId);
    expect(listed.online).toBe(false);
    expect(listed.last_seen_at).toBeGreaterThanOrEqual(now() - 5);
    expect(await row()).toBeGreaterThanOrEqual(now() - 5);
    expect(await runInDurableObject(deviceHub(env, acct.accountId), (_, state) => state.storage.kv.get(`seen:${acct.deviceId}`))).toBeUndefined();
  });
});
