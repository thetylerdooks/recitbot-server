import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { issueUploadToken } from "../src/upload";
import { now, randomId } from "../src/util";
import { call, connectDevice, mcp, MP4, seedAccount, seedReady, videoLinkOf, withEnv } from "./helpers";

const WAV = () => {
  const b = new Uint8Array(1044);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WAVE"), 8);
  return b;
};

async function startedRecording(e: Env = env) {
  const acct = await seedAccount();
  const { ws } = await connectDevice(acct.deviceToken!);
  const r = await mcp("start_recording", { mic: true, max_seconds: 30 }, acct.key, e);
  expect(r.isError).toBe(false);
  const id: string = r.data.recording_id;
  const token = await issueUploadToken(env, id, acct.deviceId!, now() + 600);
  return { ...acct, id, token, ws };
}

const put = (id: string, part: string, token: string, body: Uint8Array, type: string, e: Env = env, len = body.length) =>
  call(
    `/upload/${id}/${part}`,
    { method: "PUT", body, headers: { authorization: `Bearer ${token}`, "content-type": type, "content-length": String(len) } },
    e,
  );
const complete = (id: string, token: string, e: Env = env) =>
  call(`/upload/${id}/complete`, { method: "POST", body: JSON.stringify({ duration_s: 8 }), headers: { authorization: `Bearer ${token}` } }, e);

describe("upload", () => {
  it("full flow: video + audio -> ready with share_url and (dev stub) transcript", async () => {
    const r = await startedRecording();
    expect((await put(r.id, "video", r.token, MP4(), "video/mp4")).status).toBe(200);
    expect((await put(r.id, "audio", r.token, WAV(), "audio/wav")).status).toBe(200);
    expect((await complete(r.id, r.token)).status).toBe(200);
    const v = await mcp("get_video", { recording_id: r.id, wait_seconds: 5 }, r.key);
    expect(v.data).toMatchObject({ status: "ready", transcript_status: "ready", duration_s: 8 });
    expect(v.data.share_url).toBe(v.data.url);
    expect(v.data.share_url).toMatch(/\/[a-z0-9-]+\/v\/[A-Za-z0-9]{14}$/);
    expect(v.data.visibility).toBe("private");
    const t = await mcp("get_transcript", { recording_id: r.id, format: "vtt" }, r.key);
    expect(t.data.transcript).toMatch(/^WEBVTT/);
    r.ws.close();
  });

  it("rejects wrong token, wrong magic bytes, wrong type and oversize", async () => {
    const r = await startedRecording();
    expect((await put(r.id, "video", "123.bad", MP4(), "video/mp4")).status).toBe(401);
    const other = await issueUploadToken(env, randomId(128), r.deviceId!, now() + 600);
    expect((await put(r.id, "video", other, MP4(), "video/mp4")).status).toBe(401);
    expect((await put(r.id, "video", r.token, new Uint8Array(4096), "video/mp4")).status).toBe(415);
    expect((await put(r.id, "video", r.token, MP4(), "text/html")).status).toBe(415);
    expect((await put(r.id, "video", r.token, MP4(), "video/mp4", env, 81 * 1024 * 1024)).status).toBe(413);
    expect((await complete(r.id, r.token)).status).toBe(409); // no video stored
    const expired = await issueUploadToken(env, r.id, r.deviceId!, now() - 1);
    expect((await put(r.id, "video", expired, MP4(), "video/mp4")).status).toBe(401);
    r.ws.close();
  });
});

describe("SERVICE_MODE", () => {
  it("OFF refuses everything, including viewing", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    expect((await mcp("share", { recording_id: id }, key)).isError).toBe(false);
    const url = await videoLinkOf(id);
    const off = withEnv({ SERVICE_MODE: "OFF" });
    expect((await mcp("list", {}, key, off)).status).toBe(503);
    expect((await call(new URL(url).pathname + new URL(url).search, {}, off)).status).toBe(503);
  });

  it("unknown values fail closed to OFF", async () => {
    const { key } = await seedAccount();
    expect((await mcp("list", {}, key, withEnv({ SERVICE_MODE: "maybe" }))).status).toBe(503);
  });

  it("READ_ONLY refuses new activity but existing links keep playing", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    expect((await mcp("share", { recording_id: id }, key)).isError).toBe(false);
    const url = new URL(await videoLinkOf(id));
    const ro = withEnv({ SERVICE_MODE: "READ_ONLY" });
    expect((await mcp("start_recording", {}, key, ro)).data.error).toBe("SERVICE_PAUSED");
    expect((await mcp("get_installer", {}, key, ro)).data.error).toBe("SERVICE_PAUSED");
    expect((await mcp("get_video", { recording_id: id }, key, ro)).data.status).toBe("ready");
    expect((await call(url.pathname + url.search, {}, ro)).status).toBe(200);
    expect((await call("/device/enroll", { method: "POST", body: "{}" }, ro)).status).toBe(503);
  });

  it("NO_TRANSCRIBE: recordings still become ready, transcript unavailable", async () => {
    const nt = withEnv({ SERVICE_MODE: "NO_TRANSCRIBE" });
    const r = await startedRecording(nt);
    expect((await put(r.id, "video", r.token, MP4(), "video/mp4", nt)).status).toBe(200);
    expect((await put(r.id, "audio", r.token, WAV(), "audio/wav", nt)).status).toBe(200);
    expect((await complete(r.id, r.token, nt)).status).toBe(200);
    const v = await mcp("get_video", { recording_id: r.id, wait_seconds: 5 }, r.key, nt);
    expect(v.data).toMatchObject({ status: "ready", transcript_status: "unavailable" });
    r.ws.close();
  });

  it("ON: normal operation", async () => {
    const { key } = await seedAccount();
    expect((await mcp("list", {}, key, withEnv({ SERVICE_MODE: "ON" }))).isError).toBe(false);
  });
});

describe("cron cleanup", () => {
  it("deletes R2 objects and rows older than 24 h, keeps recent ones", async () => {
    const { accountId } = await seedAccount();
    const old = await seedReady(accountId, { createdAt: now() - 25 * 3600 });
    const fresh = await seedReady(accountId);
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "0 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.MEDIA.head(`v/${old}.mp4`)).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM recordings WHERE id = ?").bind(old).first()).toBeNull();
    expect(await env.MEDIA.head(`v/${fresh}.mp4`)).not.toBeNull();
    expect(await env.DB.prepare("SELECT id FROM recordings WHERE id = ?").bind(fresh).first()).not.toBeNull();
  });

  it("delete tool removes the recording and its media", async () => {
    const { accountId, key } = await seedAccount();
    const id = await seedReady(accountId);
    expect((await mcp("delete", { recording_id: id }, key)).data.deleted).toBe(true);
    expect(await env.MEDIA.head(`v/${id}.mp4`)).toBeNull();
    expect((await mcp("get_video", { recording_id: id }, key)).data.error).toBe("NOT_FOUND");
  });

  it("accounts cannot see each other's recordings", async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    const id = await seedReady(a.accountId);
    expect((await mcp("get_video", { recording_id: id }, b.key)).data.error).toBe("NOT_FOUND");
    expect((await mcp("list", {}, b.key)).data.recordings).toEqual([]);
  });
});
