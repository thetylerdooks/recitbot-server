// online / last_seen_at in list_devices and device_status follow the device socket's heartbeat, not only the DeviceHub
// socket list: a socket that stopped pinging is offline, a live one reports its last heartbeat.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { deviceHub, heartbeatOf, isLive } from "../src/device-hub";
import { now } from "../src/util";
import { connectDevice, mcp, seedAccount } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// online comes from the DeviceHub socket; the recorders' 45 s "ping" is answered by the auto-response without waking it,
// so devices.last_seen_at (connect/disconnect only) went stale while a dead socket could still count as online.
describe("the liveness rule", () => {
  const T = 1_800_000_000_000;
  it("the heartbeat is the newest of connect, last message and last auto-responded ping", () => {
    expect(heartbeatOf({ connectedAt: T - 5_400_000 }, null)).toBe(T - 5_400_000);
    expect(heartbeatOf({ connectedAt: T - 5_400_000, messageAt: T - 60_000 }, null)).toBe(T - 60_000);
    expect(heartbeatOf({ connectedAt: T - 5_400_000, messageAt: T - 60_000 }, T - 30_000)).toBe(T - 30_000);
    expect(heartbeatOf({}, null)).toBe(0);
  });
  it("online while the heartbeat is at most 120 s old (the recorders ping every 45 s)", () => {
    expect(isLive(T, T)).toBe(true);
    expect(isLive(T - 45_000, T)).toBe(true);
    expect(isLive(T - 120_000, T)).toBe(true);
    expect(isLive(T - 120_001, T)).toBe(false);
    // Connected 90 min ago and silent since = a dead connection.
    expect(isLive(heartbeatOf({ connectedAt: T - 5_400_000 }, null), T)).toBe(false);
    // Connected 90 min ago, pinged 20 s ago = online.
    expect(isLive(heartbeatOf({ connectedAt: T - 5_400_000 }, T - 20_000), T)).toBe(true);
  });
});

describe("online and last_seen_at follow the heartbeat", () => {
  /** Makes every socket of the account look connected `ageSeconds` ago with no message since. */
  async function ageSockets(accountId: string, ageSeconds: number) {
    await runInDurableObject(deviceHub(env, accountId), async (_, state) => {
      for (const ws of state.getWebSockets()) {
        const { messageAt: _m, ...a } = ws.deserializeAttachment() as { messageAt?: number };
        ws.serializeAttachment({ ...a, connectedAt: Date.now() - ageSeconds * 1000 });
      }
    });
  }
  const lastSeenRow = async (id: string) =>
    (await env.DB.prepare("SELECT last_seen_at FROM devices WHERE id = ?").bind(id).first<{ last_seen_at: number }>())!.last_seen_at;

  it("a live socket reports its heartbeat as last_seen_at, not the 90-minute-old devices.last_seen_at", async () => {
    const acct = await seedAccount();
    const d = await connectDevice(acct.deviceToken!);
    await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(now() - 5400, acct.deviceId).run();
    // The inventory a recorder reports on connect, so list_devices does not ask this (silent) test client.
    await runInDurableObject(deviceHub(env, acct.accountId), async (_, state) => {
      await state.storage.put(`devices:${acct.deviceId}`, { device_id: acct.deviceId, at: now(), monitors: [], mics: [], cameras: [] });
    });
    const st = (await mcp("device_status", {}, acct.key)).data;
    expect(st.online).toBe(true);
    expect(st.device.last_seen_at).toBeGreaterThanOrEqual(now() - 5);
    const listed = (await mcp("list_devices", {}, acct.key)).data.paired_devices.find((x: any) => x.id === acct.deviceId);
    expect(listed.online).toBe(true);
    expect(listed.last_seen_at).toBeGreaterThanOrEqual(now() - 10);
    d.ws.close();
  });

  it("a socket with no ping for over 120 s is offline: last_seen_at is its last heartbeat; the hub does not close it", async () => {
    const acct = await seedAccount();
    const d = await connectDevice(acct.deviceToken!);
    // Connected 125 s ago (last_seen_at written then) and silent since.
    await ageSockets(acct.accountId, 125);
    const connected = now() - 125;
    await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(connected, acct.deviceId).run();
    // No close frame into a peer that has stopped answering: a write it never reads keeps the hub from hibernating.
    const closeSpy = vi.spyOn(WebSocket.prototype, "close");
    try {
      const listed = (await mcp("list_devices", {}, acct.key)).data.paired_devices.find((x: any) => x.id === acct.deviceId);
      expect(listed.online).toBe(false);
      expect(Math.abs(listed.last_seen_at - connected)).toBeLessThanOrEqual(1);
      const st = (await mcp("device_status", {}, acct.key)).data;
      expect(st.online).toBe(false);
      expect(st.device.last_seen_at).toBe(listed.last_seen_at);
      expect(Math.abs((await lastSeenRow(acct.deviceId!)) - connected)).toBeLessThanOrEqual(1);
      expect(closeSpy).not.toHaveBeenCalled();
      // Given up on (stale), even though it is still open.
      const stale = await runInDurableObject(deviceHub(env, acct.accountId), (_, state) =>
        state.getWebSockets().map((ws) => (ws.deserializeAttachment() as { stale?: boolean }).stale),
      );
      expect(stale).toEqual([true]);
      // Commands do not go to it.
      expect((await mcp("start_recording", { max_seconds: 10 }, acct.key)).isError).toBe(true);
    } finally {
      closeSpy.mockRestore();
    }
    // A close the dead socket may still report does not refresh last_seen_at.
    d.ws.close();
    await sleep(50);
    await mcp("list_devices", {}, acct.key);
    expect(Math.abs((await lastSeenRow(acct.deviceId!)) - connected)).toBeLessThanOrEqual(1);
  });
});
