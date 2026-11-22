// Device commands to a recorder that is not connected (or drops mid-command): DEVICE_OFFLINE with the device's name,
// never INTERNAL.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceHub, deviceHub, RECORDER_FEATURES } from "../src/device-hub";
import { connectDevice, mcp, seedAccount } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OFFLINE = "test pc is offline. Make sure Recitbot is running on it and it's connected to the internet, then try again.";
const LOST = "test pc lost connection, try again.";

async function online(hello = true) {
  const acct = await seedAccount();
  const dev = await connectDevice(acct.deviceToken!);
  if (hello) dev.ws.send(JSON.stringify({ type: "hello", version: "0.0.1", features: RECORDER_FEATURES.filter((f) => f !== "signed_update") }));
  for (let i = 0; i < 50; i++) {
    if ((await deviceHub(env, acct.accountId).recorderInfo(acct.accountId))?.version) break;
    await sleep(10);
  }
  return { ...acct, ...dev };
}

async function goOffline(rec: { ws: WebSocket; accountId: string }) {
  rec.ws.close();
  for (let i = 0; i < 100 && (await deviceHub(env, rec.accountId).isOnline(rec.accountId)); i++) await sleep(10);
}

afterEach(() => vi.restoreAllMocks());

describe("DEVICE_OFFLINE: the device is not connected", () => {
  it("start_recording", async () => {
    const { key, deviceId } = await seedAccount();
    const r = await mcp("start_recording", {}, key);
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ error: "DEVICE_OFFLINE", message: OFFLINE, device: deviceId, device_name: "test pc" });
  });

  it("stop_recording", async () => {
    const rec = await online();
    const start = await mcp("start_recording", { max_seconds: 10 }, rec.key);
    expect(start.isError).toBe(false);
    await goOffline(rec);
    const r = await mcp("stop_recording", { recording_id: start.data.recording_id }, rec.key);
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ error: "DEVICE_OFFLINE", message: OFFLINE, device: rec.deviceId, recording_id: start.data.recording_id });
  });

  it("update_recorder", async () => {
    const { key, deviceId } = await seedAccount();
    const r = await mcp("update_recorder", {}, key);
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ error: "DEVICE_OFFLINE", message: OFFLINE, device: deviceId, platform: "windows" });
  });

  it("delete still deletes a recording whose device went offline", async () => {
    const rec = await online();
    const start = await mcp("start_recording", { max_seconds: 10 }, rec.key);
    await goOffline(rec);
    expect((await mcp("delete", { recording_id: start.data.recording_id }, rec.key)).data).toMatchObject({ deleted: true });
  });
});

describe("DEVICE_OFFLINE: the device drops mid-command (not INTERNAL)", () => {
  it("start_recording: the hub call fails -> lost connection, recording marked failed", async () => {
    const rec = await online();
    vi.spyOn(DeviceHub.prototype, "sendCommand").mockRejectedValueOnce(new Error("Network connection lost."));
    const r = await mcp("start_recording", { max_seconds: 10 }, rec.key);
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ error: "DEVICE_OFFLINE", message: LOST, device: rec.deviceId });
    const row = await env.DB.prepare("SELECT status, error FROM recordings WHERE device_id = ? ORDER BY created_at DESC").bind(rec.deviceId).first();
    expect(row).toMatchObject({ status: "failed", error: "DEVICE_OFFLINE" });
    rec.ws.close();
  });

  it("start_recording: the socket went away between the online check and the send -> lost connection", async () => {
    const rec = await online();
    vi.spyOn(DeviceHub.prototype, "sendCommand").mockResolvedValueOnce({ ok: false });
    const r = await mcp("start_recording", { max_seconds: 10 }, rec.key);
    expect(r.data).toMatchObject({ error: "DEVICE_OFFLINE", message: LOST });
    rec.ws.close();
  });

  it("stop_recording: the hub call times out -> lost connection", async () => {
    const rec = await online();
    const start = await mcp("start_recording", { max_seconds: 10 }, rec.key);
    vi.spyOn(DeviceHub.prototype, "sendCommand").mockRejectedValueOnce(new Error("Durable Object request timed out"));
    const r = await mcp("stop_recording", { recording_id: start.data.recording_id }, rec.key);
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({ error: "DEVICE_OFFLINE", message: LOST });
    rec.ws.close();
  });

  it("update_recorder: pushUpdate fails or finds the socket gone -> lost connection", async () => {
    const rec = await online();
    vi.spyOn(DeviceHub.prototype, "pushUpdate").mockRejectedValueOnce(new Error("WebSocket closed"));
    expect((await mcp("update_recorder", {}, rec.key)).data).toMatchObject({ error: "DEVICE_OFFLINE", message: LOST, device: rec.deviceId });
    vi.spyOn(DeviceHub.prototype, "pushUpdate").mockResolvedValueOnce({ ok: false, reason: "offline" });
    expect((await mcp("update_recorder", {}, rec.key)).data).toMatchObject({ error: "DEVICE_OFFLINE", message: LOST });
    rec.ws.close();
  });
});
