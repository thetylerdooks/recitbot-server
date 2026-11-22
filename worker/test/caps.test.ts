import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canonicalCommand, deviceCommandKey, deviceHub } from "../src/device-hub";
import { governor } from "../src/governor";
import { issueUploadToken } from "../src/upload";
import { hmacHex, now, randomId } from "../src/util";
import { brokenGovernor, call, connectDevice, mcp, MP4, seedAccount, withEnv } from "./helpers";

const DAY = 86400;
const g = () => governor(env);
const start = (accountId: string, t: number, opts: { paired?: boolean; max?: number } = {}) =>
  g().checkStart({ accountId, paired: opts.paired ?? true, accountMaxPerDay: null, tier: "free", globalMaxPerDay: opts.max ?? 3500, now: t });

describe("Governor caps", () => {
  it("no per-account rate limit: 20 starts in a minute and 40 in 30 days all go through", async () => {
    const acct = randomId(128);
    const t0 = now() - 60 * DAY;
    for (let i = 0; i < 20; i++) expect(await start(acct, t0 + i)).toEqual({ ok: true });
    for (let i = 1; i <= 20; i++) expect(await start(acct, t0 + i * DAY)).toEqual({ ok: true });
  });

  it("refuses unpaired accounts (0 recordings until a device is paired)", async () => {
    expect(await start(randomId(128), now(), { paired: false })).toMatchObject({ ok: false, code: "DEVICE_NOT_PAIRED" });
    const { key } = await seedAccount(false);
    expect((await mcp("start_recording", {}, key)).data.error).toBe("DEVICE_NOT_PAIRED");
  });

  it("refuses when the global daily ceiling is reached", async () => {
    expect(await start(randomId(128), now(), { max: 0 })).toMatchObject({ ok: false, code: "CAP_REACHED" });
  });

  it("caps global transcription minutes", async () => {
    expect(await g().checkTranscribe({ accountId: randomId(128), minutes: 5, accountMaxPerDay: null, globalMaxPerDay: 4, now: now() })).toEqual({ ok: false, refused: "global" });
  });

  it("fails closed when the Governor is unreachable", async () => {
    const { accountId, key, deviceToken } = await seedAccount();
    const broken = withEnv({ GOVERNOR: brokenGovernor });
    expect((await mcp("start_recording", {}, key, broken)).status).toBe(503);
    // Upload path also refuses.
    const id = randomId(128);
    await env.DB.prepare(
      "INSERT INTO recordings (id, account_id, device_id, status, max_seconds, created_at, expires_at) VALUES (?, ?, 'x', 'recording', 60, ?, ?)",
    )
      .bind(id, accountId, now(), now() + DAY)
      .run();
    void deviceToken;
    const tok = await issueUploadToken(env, id, "x", now() + 600);
    const res = await call(
      `/upload/${id}/video`,
      { method: "PUT", body: MP4(), headers: { authorization: `Bearer ${tok}`, "content-type": "video/mp4", "content-length": "4096" } },
      broken,
    );
    expect(res.status).toBe(503);
  });
});

describe("device channel", () => {
  it("start_recording sends an HMAC-signed, account-bound command to the paired device", async () => {
    const { accountId, key, deviceId, deviceToken } = await seedAccount();
    const { ws, frames } = await connectDevice(deviceToken!);
    expect((await mcp("device_status", {}, key)).data).toMatchObject({ paired: true, online: true });

    const r = await mcp("start_recording", { title: "t", max_seconds: 10 }, key);
    expect(r.isError).toBe(false);
    await new Promise((res) => setTimeout(res, 50));
    const f = frames[0];
    expect(f).toMatchObject({ type: "start", recording_id: r.data.recording_id, account_id: accountId, device_id: deviceId, max_seconds: 10 });
    const secret = await deviceCommandKey(env, deviceId!);
    expect(f.mac).toBe(await hmacHex(secret, canonicalCommand(f)));
    expect(f.exp).toBeGreaterThan(now());
    // Without webcam options the frame carries no webcam fields: the device config decides (v1 canonical form).
    expect(f).not.toHaveProperty("webcam");
    expect(f).not.toHaveProperty("camera");
    expect(f).not.toHaveProperty("webcam_size");

    // Second command has a strictly larger nonce (replay protection on the device).
    await mcp("stop_recording", { recording_id: r.data.recording_id }, key);
    await new Promise((res) => setTimeout(res, 50));
    expect(frames[1].type).toBe("stop");
    expect(frames[1].nonce).toBeGreaterThan(f.nonce);

    // Device status events update the recording.
    ws.send(JSON.stringify({ type: "status", recording_id: r.data.recording_id, status: "uploading" }));
    await new Promise((res) => setTimeout(res, 100));
    expect((await mcp("get_video", { recording_id: r.data.recording_id }, key)).data.status).toBe("uploading");
    ws.close();
  });

  it("start_recording forwards signed webcam options and validates them", async () => {
    const { key, deviceId, deviceToken } = await seedAccount();
    const { ws, frames } = await connectDevice(deviceToken!);
    const r = await mcp("start_recording", { max_seconds: 10, webcam: true, camera: "Full HD webcam", webcam_size: "large" }, key);
    expect(r.isError).toBe(false);
    await new Promise((res) => setTimeout(res, 50));
    const f = frames[0];
    expect(f).toMatchObject({ type: "start", webcam: true, camera: "Full HD webcam", webcam_size: "large" });
    const secret = await deviceCommandKey(env, deviceId!);
    expect(f.mac).toBe(await hmacHex(secret, canonicalCommand(f)));
    // Stripping or changing a webcam field breaks the signature.
    const { webcam: _w, ...stripped } = f;
    expect(await hmacHex(secret, canonicalCommand(stripped))).not.toBe(f.mac);
    expect(await hmacHex(secret, canonicalCommand({ ...f, camera: "Evil cam" }))).not.toBe(f.mac);
    ws.close();

    expect((await mcp("start_recording", { webcam_size: "huge" }, key)).data.error).toBe("INVALID_ARGUMENTS");
    expect((await mcp("start_recording", { camera: 'cam" -i x' }, key)).data.error).toBe("INVALID_ARGUMENTS");
    expect((await mcp("start_recording", { camera: "a|b" }, key)).data.error).toBe("INVALID_ARGUMENTS");
    expect((await mcp("start_recording", { webcam: "yes" }, key)).data.error).toBe("INVALID_ARGUMENTS");
  });

  it("DeviceHub refuses commands for a different account", async () => {
    const a = await seedAccount();
    await connectDevice(a.deviceToken!);
    const r = await deviceHub(env, a.accountId).sendCommand(randomId(128), { type: "stop", recording_id: randomId(128) });
    expect(r.ok).toBe(false);
  });

  it("a device of another account cannot report status for my recording", async () => {
    const me = await seedAccount();
    const other = await seedAccount();
    const { ws } = await connectDevice(me.deviceToken!);
    const r = await mcp("start_recording", {}, me.key);
    const evil = await connectDevice(other.deviceToken!);
    evil.ws.send(JSON.stringify({ type: "status", recording_id: r.data.recording_id, status: "failed" }));
    await new Promise((res) => setTimeout(res, 100));
    expect((await mcp("get_video", { recording_id: r.data.recording_id }, me.key)).data.status).toBe("starting");
    ws.close();
    evil.ws.close();
  });

  it("rejects WebSocket connections without a valid device token", async () => {
    expect((await call("/device/ws", { headers: { upgrade: "websocket", authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("returns DEVICE_OFFLINE when the paired device is offline", async () => {
    const { key } = await seedAccount();
    expect((await mcp("start_recording", {}, key)).data.error).toBe("DEVICE_OFFLINE");
  });

  it("governor state is in SQLite storage", async () => {
    const n = await runInDurableObject(env.GOVERNOR.get(env.GOVERNOR.idFromName("global")), (_i, s) =>
      s.storage.sql.exec("SELECT count(*) AS n FROM starts").one(),
    );
    expect(Number(n.n)).toBeGreaterThan(0);
  });
});
