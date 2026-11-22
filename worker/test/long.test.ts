// Long recordings: per-account max_seconds, the chunked (R2 multipart) upload, its cleanup, and windowed transcription.
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalCommand, deviceCommandKey, deviceHub, RECORDER_FEATURES } from "../src/device-hub";
import type { Env } from "../src/env";
import { LIMITS } from "../src/env";
import worker from "../src/index";
import { issueUploadToken } from "../src/upload";
import { hmacHex, now, randomId } from "../src/util";
import { call, connectDevice, mcp, MP4, seedAccount, withEnv } from "./helpers";
import { box, cat, fragmentedFile, ftyp, mdhd, mehd, moof, mvhd, stts, tfhd, tkhd, traf, trak, trex, trun } from "./mp4-fixture";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MiB = 1024 * 1024;

// Let the DeviceHubs finish their close handling (and logging) before the file tears down.
afterAll(() => sleep(200));

/** A paired recorder that said hello with `features` (null = older than 0.4), on an owner or a free account. */
async function recorder(opts: { owner?: boolean; plan?: string; features?: string[] | null } = {}) {
  const acct = await seedAccount();
  if (opts.plan) await env.DB.prepare("UPDATE accounts SET plan = ? WHERE id = ?").bind(opts.plan, acct.accountId).run();
  const e: Env = opts.owner ? withEnv({ OWNER_ACCOUNT_IDS: acct.accountId }) : env;
  const dev = await connectDevice(acct.deviceToken!);
  const features = opts.features === undefined ? [...RECORDER_FEATURES] : opts.features;
  if (features) {
    dev.ws.send(JSON.stringify({ type: "hello", version: "0.5.0", features }));
    for (let i = 0; i < 50; i++) {
      if ((await deviceHub(env, acct.accountId).recorderInfo(acct.accountId))?.version) break;
      await sleep(10);
    }
  }
  return { ...acct, ...dev, e };
}

async function startFrame(frames: any[], deviceId: string) {
  for (let i = 0; i < 100 && !frames.some((x) => x.type === "start"); i++) await sleep(10);
  const f = frames.find((x) => x.type === "start");
  const { mac, ...rest } = f;
  expect(mac).toBe(await hmacHex(await deviceCommandKey(env, deviceId), canonicalCommand(rest)));
  return f;
}

/** A started recording plus helpers for its upload endpoints. */
async function started(opts: { owner?: boolean; plan?: string; max_seconds?: number } = {}) {
  const r = await recorder({ owner: opts.owner, plan: opts.plan });
  const s = await mcp("start_recording", { mic: true, max_seconds: opts.max_seconds ?? 30 }, r.key, r.e);
  expect(s.isError).toBe(false);
  const id: string = s.data.recording_id;
  const token = await issueUploadToken(env, id, r.deviceId!, now() + 600);
  const req = (path: string, method: string, body?: BodyInit, tok = token, headers: Record<string, string> = {}) =>
    call(
      `/upload/${id}/${path}`,
      {
        method,
        body,
        headers: {
          authorization: `Bearer ${tok}`,
          ...(body instanceof Uint8Array && { "content-length": String(body.length) }),
          ...headers,
        },
      },
      r.e,
    );
  return {
    ...r,
    id,
    token,
    req,
    create: (kind = "video", body: unknown = {}, tok = token) => req(`${kind}/mp`, "POST", JSON.stringify(body), tok),
    part: (n: number, data: Uint8Array, kind = "video", tok = token) => req(`${kind}/mp/${n}`, "PUT", data, tok),
    finish: (parts: number, kind = "video", tok = token) => req(`${kind}/mp/complete`, "POST", JSON.stringify({ parts }), tok),
    abort: (kind = "video", tok = token) => req(`${kind}/mp`, "DELETE", undefined, tok),
    complete: () => req("complete", "POST", JSON.stringify({ duration_s: 1500 })),
  };
}

const mpRow = (id: string, kind = "video") =>
  env.DB.prepare("SELECT upload_id, parts, bytes, closed FROM multipart_uploads WHERE recording_id = ? AND kind = ?")
    .bind(id, kind)
    .first<{ upload_id: string; parts: string; bytes: number; closed: number }>();

/** 16 MiB first part (the smallest non-final part size) starting with the MP4 magic. */
const bigPart = () => MP4(LIMITS.minPartBytes);
const tail = (n = 1024) => new Uint8Array(n).fill(7);

/** PCM16 mono WAV at `rate` Hz, `seconds` long, loud (never silent). */
function wav(rate: number, seconds: number): Uint8Array {
  const n = rate * seconds;
  const b = new Uint8Array(44 + n * 2);
  const v = new DataView(b.buffer);
  const put = (o: number, s: string) => b.set(new TextEncoder().encode(s), o);
  put(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  put(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  put(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, i % 2 ? 12000 : -12000, true);
  return b;
}

describe("per-account max_seconds", () => {
  it("owner: 1800 accepted, default is 1800, and the start command carries the signed part size", async () => {
    const r = await recorder({ owner: true });
    const s = await mcp("start_recording", { max_seconds: 1800 }, r.key, r.e);
    expect(s.isError).toBe(false);
    expect(s.data.max_seconds).toBe(1800);
    expect(s.data.unsupported).toBeUndefined();
    const f = await startFrame(r.frames, r.deviceId!);
    expect(f).toMatchObject({ max_seconds: 1800, upload_part_bytes: LIMITS.uploadPartBytes });
    expect(canonicalCommand(f).endsWith(`|mp|${LIMITS.uploadPartBytes}`)).toBe(true);
    const rec = await env.DB.prepare("SELECT max_seconds FROM recordings WHERE id = ?").bind(s.data.recording_id).first<{ max_seconds: number }>();
    expect(rec?.max_seconds).toBe(1800);

    // No time limit per recording: the default is the start command's ceiling, and only past it is the input refused.
    const d = await mcp("start_recording", {}, r.key, r.e);
    expect(d.data.max_seconds).toBe(LIMITS.recordingCeilingSeconds);
    expect((await mcp("start_recording", { max_seconds: 3600 }, r.key, r.e)).data.max_seconds).toBe(3600);
    expect((await mcp("start_recording", { max_seconds: LIMITS.recordingCeilingSeconds + 1 }, r.key, r.e)).data.error).toBe("INVALID_ARGUMENTS");
    r.ws.close();
  });

  it("pro and teams: up to 4 hours per recording (past the old 1800 s); the default is 4 h, sent as the start's max_seconds", async () => {
    expect(LIMITS.paidMaxSeconds).toBe(4 * 3600);
    for (const plan of ["pro", "teams"]) {
      const r = await recorder({ plan });
      const s = await mcp("start_recording", { max_seconds: 2 * 3600 }, r.key, r.e);
      expect(s.isError, JSON.stringify(s.data)).toBe(false);
      expect(s.data.max_seconds).toBe(2 * 3600);
      expect(await startFrame(r.frames, r.deviceId!)).toMatchObject({ max_seconds: 2 * 3600 });
      r.frames.length = 0;
      const d = await mcp("start_recording", {}, r.key, r.e);
      expect(d.data.max_seconds).toBe(14400);
      expect(await startFrame(r.frames, r.deviceId!)).toMatchObject({ max_seconds: 14400 });
      const row = await env.DB.prepare("SELECT max_seconds FROM recordings WHERE id = ?").bind(d.data.recording_id).first<{ max_seconds: number }>();
      expect(row!.max_seconds).toBe(14400);
      // Over 4 h is refused before anything is sent.
      r.frames.length = 0;
      const over = await mcp("start_recording", { max_seconds: 14401 }, r.key, r.e);
      expect(over.isError).toBe(true);
      expect(r.frames.filter((f) => f.type === "start")).toEqual([]);
      r.ws.close();
    }
  });

  it("pro and teams: the plan's limits say 4 hours (account_info, get_plan)", async () => {
    const r = await recorder({ plan: "pro" });
    expect((await mcp("account_info", {}, r.key)).data.limits).toMatchObject({ max_recording_minutes: 240 });
    const plan = JSON.stringify((await mcp("get_plan", {}, r.key)).data);
    expect(plan).toContain("recordings up to 4 hours");
    expect(plan).not.toContain("no time limit");
    r.ws.close();
  });

  it("pro: a recording over 4 h is refused at upload complete too (the MP4's own length)", async () => {
    const r = await recorder({ plan: "pro" });
    const s = await mcp("start_recording", {}, r.key, r.e);
    const id: string = s.data.recording_id;
    const token = await issueUploadToken(env, id, r.deviceId!, now() + 600);
    const up = (path: string, method: string, body: BodyInit, headers: Record<string, string> = {}) =>
      call(`/upload/${id}/${path}`, { method, body, headers: { authorization: `Bearer ${token}`, ...headers } }, r.e);
    const mp4 = MP4(4096, 14400 + 60);
    expect((await up("video", "PUT", mp4, { "content-type": "video/mp4", "content-length": String(mp4.length) })).status).toBe(200);
    const done = await up("complete", "POST", JSON.stringify({ duration_s: 14460 }));
    expect(done.status).toBe(413);
    expect(await done.json()).toMatchObject({ error: "LIMIT_EXCEEDED", limit: "max_seconds", max: 14400, tier: "pro" });
    r.ws.close();
  });

  it("free: 301 rejected with a limit error (upgrade_url reserved, unset); 300 accepted and the default, chunked", async () => {
    const r = await recorder();
    const s = await mcp("start_recording", { max_seconds: 301 }, r.key);
    expect(s.isError).toBe(true);
    expect(s.data).toMatchObject({ error: "LIMIT_EXCEEDED", limit: "max_seconds", max: 300, requested: 301, tier: "free" });
    expect(s.data.message).toMatch(/300 seconds/);
    expect("upgrade_url" in s.data).toBe(false);
    expect(r.frames.some((f) => f.type === "start")).toBe(false);

    const ok = await mcp("start_recording", { max_seconds: 300 }, r.key);
    expect(ok.isError).toBe(false);
    expect(ok.data.max_seconds).toBe(300);
    expect(ok.data.unsupported).toBeUndefined();
    // Free recordings past one part go through the chunked upload too: the signed start carries the part size.
    const f = await startFrame(r.frames, r.deviceId!);
    expect(f).toMatchObject({ max_seconds: 300, upload_part_bytes: LIMITS.uploadPartBytes });
    expect(canonicalCommand(f).endsWith(`|mp|${LIMITS.uploadPartBytes}`)).toBe(true);
    const def = await mcp("start_recording", {}, r.key);
    expect(def.data.max_seconds).toBe(300);
    r.ws.close();
  });

  it("free on a recorder without chunked_upload: shortened to the single-PUT 120 s, told why", async () => {
    const r = await recorder({ features: null });
    const s = await mcp("start_recording", { max_seconds: 300 }, r.key);
    expect(s.isError).toBe(false);
    expect(s.data.max_seconds).toBe(LIMITS.singleUploadMaxSeconds);
    expect(s.data.unsupported).toContain("chunked_upload");
    expect(s.data.notes.join(" ")).toMatch(/at most 120 s/);
    r.ws.close();
  });

  it("owner on a recorder without chunked_upload: shortened to 120 s, told why, no part size sent", async () => {
    for (const features of [null, ["system_audio", "webcam_shape", "webcam_pct", "ready_push"]]) {
      const r = await recorder({ owner: true, features });
      const s = await mcp("start_recording", { max_seconds: 600 }, r.key, r.e);
      expect(s.isError).toBe(false);
      expect(s.data.max_seconds).toBe(120);
      expect(s.data.unsupported).toContain("chunked_upload");
      const f = await startFrame(r.frames, r.deviceId!);
      expect(f.max_seconds).toBe(120);
      expect(f.upload_part_bytes).toBeUndefined();
      r.ws.close();
    }
  });
});

describe("chunked upload", () => {
  it("happy path: video in 2 parts, audio in 1, then the recording becomes ready", async () => {
    const r = await started({ owner: true, max_seconds: 1800 });
    const c = await r.create("video", { total_bytes: LIMITS.minPartBytes + 1024 });
    expect(c.status).toBe(200);
    expect(await c.json()).toMatchObject({
      part_bytes: LIMITS.uploadPartBytes,
      min_part_bytes: LIMITS.minPartBytes,
      max_part_bytes: LIMITS.maxPartBytes,
      max_parts: LIMITS.maxParts,
      max_bytes: LIMITS.ownerMaxVideoBytes,
    });
    expect((await r.part(1, bigPart())).status).toBe(200);
    // Re-sending the last part replaces it.
    expect((await r.part(1, bigPart())).status).toBe(200);
    const p2 = await r.part(2, tail());
    expect(await p2.json()).toMatchObject({ ok: true, part: 2, bytes: LIMITS.minPartBytes + 1024, last: true });
    const done = await r.finish(2);
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ ok: true, parts: 2, bytes: LIMITS.minPartBytes + 1024 });
    expect(await mpRow(r.id)).toBeNull();
    const head = await env.MEDIA.head(`v/${r.id}.mp4`);
    expect(head?.size).toBe(LIMITS.minPartBytes + 1024);
    expect(head?.httpMetadata?.contentType).toBe("video/mp4");

    expect((await r.create("audio")).status).toBe(200);
    expect((await r.part(1, wav(16000, 2), "audio")).status).toBe(200);
    expect((await r.finish(1, "audio")).status).toBe(200);
    expect(await env.MEDIA.head(`a/${r.id}.wav`)).not.toBeNull();

    expect((await r.complete()).status).toBe(200);
    const v = await mcp("get_video", { recording_id: r.id, wait_seconds: 5 }, r.key, r.e);
    expect(v.data).toMatchObject({ status: "ready", transcript_status: "ready", duration_s: 1500 });
    r.ws.close();
  });

  it("rejects out-of-order and missing parts, parts after the last, and oversized parts", async () => {
    const r = await started({ owner: true, max_seconds: 600 });
    expect((await r.part(1, bigPart())).status).toBe(409); // no upload created
    expect((await r.create()).status).toBe(200);
    const skip = await r.part(2, tail());
    expect(skip.status).toBe(409);
    expect(await skip.json()).toMatchObject({ error: "PART_OUT_OF_ORDER", expected: 1 });
    expect((await r.part(1, tail(64))).status).toBe(415); // part 1 must start like an MP4
    expect((await r.part(1, bigPart())).status).toBe(200);
    expect(await (await r.part(3, tail())).json()).toMatchObject({ error: "PART_OUT_OF_ORDER", expected: 2 });
    // Part 2 larger than part 1 breaks R2's equal-size rule.
    expect((await r.part(2, new Uint8Array(LIMITS.minPartBytes + 1))).status).toBe(413);
    // Complete must name every part received: 2 claimed, 1 received.
    const missing = await r.finish(2);
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ error: "PARTS_MISSING", received: 1, expected: 2 });
    expect(await env.MEDIA.head(`v/${r.id}.mp4`)).toBeNull();
    expect((await r.part(2, tail())).status).toBe(200); // short = last part
    expect(await (await r.part(3, tail())).json()).toMatchObject({ error: "PART_AFTER_LAST" });
    expect((await r.finish(2)).status).toBe(200);
    r.ws.close();
  });

  it("enforces the per-recording total: free 250 MiB video, owner 8 GiB", async () => {
    const free = await started();
    const f = await free.create("video", { total_bytes: LIMITS.maxVideoBytes + 1 });
    expect(f.status).toBe(413);
    expect(await f.json()).toMatchObject({ error: "LIMIT_EXCEEDED", limit: "video_bytes", max: LIMITS.maxVideoBytes, tier: "free" });
    expect((await free.create("audio", { total_bytes: LIMITS.maxAudioBytes + 1 })).status).toBe(413);
    // Counted from the parts too, not just the declared total: 16 MiB of audio is over the free 8 MB.
    expect((await free.create("audio")).status).toBe(200);
    const big = new Uint8Array(LIMITS.minPartBytes);
    big.set(wav(16000, 1).slice(0, 44));
    expect(await (await free.part(1, big, "audio")).json()).toMatchObject({ error: "LIMIT_EXCEEDED", limit: "audio_bytes" });
    free.ws.close();

    const owner = await started({ owner: true, max_seconds: 1800 });
    expect((await owner.create("video", { total_bytes: LIMITS.ownerMaxVideoBytes })).status).toBe(200);
    const o = await owner.create("video", { total_bytes: LIMITS.ownerMaxVideoBytes + 1 });
    expect(await o.json()).toMatchObject({ error: "LIMIT_EXCEEDED", limit: "video_bytes", max: LIMITS.ownerMaxVideoBytes, tier: "owner" });
    owner.ws.close();
  });

  it("Pro, Teams and owners: 8 GiB of video in one recording, through more than 100 parts; one byte more is refused", async () => {
    expect(LIMITS.ownerMaxVideoBytes).toBe(8 * 1024 ** 3);
    expect(LIMITS.maxParts * LIMITS.minPartBytes).toBeGreaterThanOrEqual(LIMITS.ownerMaxVideoBytes);
    for (const o of [{ plan: "pro" }, { plan: "teams" }, { owner: true }]) {
      const r = await started({ ...o, max_seconds: 14400 });
      const c = await r.create("video", { total_bytes: LIMITS.ownerMaxVideoBytes });
      expect(c.status).toBe(200);
      expect(await c.json()).toMatchObject({ max_bytes: LIMITS.ownerMaxVideoBytes, max_parts: LIMITS.maxParts });
      expect((await r.create("video", { total_bytes: 1.5 * 1024 ** 3 + 1 })).status).toBe(200); // past the old 1.5 GiB
      expect((await r.create("video", { total_bytes: LIMITS.ownerMaxVideoBytes + 1 })).status).toBe(413);
      // Part 1 for real, then as if 299 more 16 MiB parts had arrived (4.7 GiB): part 301 is past the old 100-part cap.
      const part = new Uint8Array(LIMITS.minPartBytes);
      part.set(MP4(512));
      expect((await r.part(1, part)).status).toBe(200);
      const fake = (n: number, bytes: number) =>
        env.DB.prepare("UPDATE multipart_uploads SET parts = ?, bytes = ? WHERE recording_id = ? AND kind = 'video'")
          .bind(JSON.stringify(Array.from({ length: n }, (_, i) => ({ n: i + 1, etag: "x", size: LIMITS.minPartBytes }))), bytes, r.id)
          .run();
      await fake(300, 300 * LIMITS.minPartBytes);
      const p301 = await r.part(301, new Uint8Array(LIMITS.minPartBytes));
      expect(p301.status).toBe(200);
      expect(await p301.json()).toMatchObject({ part: 301, bytes: 301 * LIMITS.minPartBytes });
      // Up to exactly 8 GiB: the part that reaches it is taken, one that passes it is refused.
      await fake(301, LIMITS.ownerMaxVideoBytes - LIMITS.minPartBytes);
      expect((await r.part(302, new Uint8Array(LIMITS.minPartBytes))).status).toBe(200);
      await fake(302, LIMITS.ownerMaxVideoBytes - LIMITS.minPartBytes + 1);
      expect(await (await r.part(303, new Uint8Array(LIMITS.minPartBytes))).json()).toMatchObject({
        error: "LIMIT_EXCEEDED",
        limit: "video_bytes",
        max: LIMITS.ownerMaxVideoBytes,
      });
      await fake(LIMITS.maxParts, LIMITS.minPartBytes);
      expect(await (await r.part(LIMITS.maxParts + 1, new Uint8Array(1024))).json()).toMatchObject({ error: "TOO_MANY_PARTS" });
      await r.abort();
      r.ws.close();
    }
  });

  it("Free stays at 250 MiB of video and 10 MiB of audio, whatever the chunked path allows", async () => {
    const free = await started({ max_seconds: 300 });
    expect((await free.create("video", { total_bytes: LIMITS.maxVideoBytes })).status).toBe(200);
    expect(await (await free.create("video", { total_bytes: LIMITS.maxVideoBytes + 1 })).json()).toMatchObject({ max: 250 * MiB, tier: "free" });
    expect(await (await free.create("audio", { total_bytes: LIMITS.maxAudioBytes + 1 })).json()).toMatchObject({ max: 10 * MiB, tier: "free" });
    free.ws.close();
  });

  it("audio: Pro, Teams and owners up to 480 MiB (4 h of the 16 kHz WAV, ~461 MB) through the chunked upload", async () => {
    expect(LIMITS.ownerMaxAudioBytes).toBeGreaterThanOrEqual((14400 + 30) * 32000 + 44);
    const r = await started({ plan: "pro", max_seconds: 14400 });
    expect((await r.create("audio", { total_bytes: (14400 + 30) * 32000 + 44 })).status).toBe(200);
    expect(await (await r.create("audio", { total_bytes: LIMITS.ownerMaxAudioBytes + 1 })).json()).toMatchObject({
      error: "LIMIT_EXCEEDED",
      limit: "audio_bytes",
      max: 480 * MiB,
    });
    r.ws.close();
  });

  it("wrong device, other recording's token and expired token are rejected on every step", async () => {
    const r = await started({ owner: true, max_seconds: 600 });
    const otherDevice = await issueUploadToken(env, r.id, randomId(128), now() + 600);
    const otherRec = await issueUploadToken(env, randomId(128), r.deviceId!, now() + 600);
    const expired = await issueUploadToken(env, r.id, r.deviceId!, now() - 1);
    for (const tok of [otherDevice, otherRec, expired, "1.bad"]) {
      expect((await r.create("video", {}, tok)).status).toBe(401);
    }
    expect((await r.create()).status).toBe(200);
    for (const tok of [otherDevice, otherRec, expired]) {
      expect((await r.part(1, bigPart(), "video", tok)).status).toBe(401);
      expect((await r.finish(1, "video", tok)).status).toBe(401);
      expect((await r.abort("video", tok)).status).toBe(401);
    }
    expect(await mpRow(r.id)).not.toBeNull();
    r.ws.close();
  });

  it("abort (explicit, delete tool, and the hourly cron) removes the upload", async () => {
    const r = await started({ owner: true, max_seconds: 600 });
    expect((await r.create()).status).toBe(200);
    expect((await r.part(1, bigPart())).status).toBe(200);
    const { upload_id } = (await mpRow(r.id))!;
    expect((await r.abort()).status).toBe(200);
    expect(await mpRow(r.id)).toBeNull();
    // R2 no longer accepts the aborted upload.
    await expect(env.MEDIA.resumeMultipartUpload(`v/${r.id}.mp4`, upload_id).uploadPart(2, "x")).rejects.toThrow();
    expect((await r.finish(1)).status).toBe(409);
    expect((await r.part(2, tail())).status).toBe(409);

    // Creating again aborts the earlier upload.
    expect((await r.create()).status).toBe(200);
    const first = (await mpRow(r.id))!.upload_id;
    expect((await r.create()).status).toBe(200);
    expect((await mpRow(r.id))!.upload_id).not.toBe(first);

    // delete tool
    expect((await mcp("delete", { recording_id: r.id }, r.key, r.e)).data.deleted).toBe(true);
    expect(await mpRow(r.id)).toBeNull();

    // cron: uploads older than 24 h are aborted, fresh ones stay
    const s = await started({ owner: true, max_seconds: 600 });
    const fresh = await started({ owner: true, max_seconds: 600 });
    expect((await s.create()).status).toBe(200);
    expect((await fresh.create()).status).toBe(200);
    await env.DB.prepare("UPDATE multipart_uploads SET created_at = ? WHERE recording_id = ?").bind(now() - 25 * 3600, s.id).run();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "0 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await mpRow(s.id)).toBeNull();
    expect(await mpRow(fresh.id)).not.toBeNull();
    r.ws.close();
    s.ws.close();
    fresh.ws.close();
  });

  it("an R2 failure while storing a part aborts the upload", async () => {
    const r = await started({ owner: true, max_seconds: 600 });
    expect((await r.create()).status).toBe(200);
    const { upload_id } = (await mpRow(r.id))!;
    const broken = new Proxy(env.MEDIA, {
      get(target, p) {
        if (p === "resumeMultipartUpload") {
          return (key: string, uploadId: string) => {
            const real = target.resumeMultipartUpload(key, uploadId);
            return { ...real, abort: () => real.abort(), uploadPart: () => Promise.reject(new Error("R2 down")) };
          };
        }
        const v = Reflect.get(target, p);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const res = await call(
      `/upload/${r.id}/video/mp/1`,
      { method: "PUT", body: bigPart(), headers: { authorization: `Bearer ${r.token}`, "content-length": String(LIMITS.minPartBytes) } },
      withEnv({ ...r.e, MEDIA: broken }),
    );
    expect(res.status).toBe(502);
    expect(await mpRow(r.id)).toBeNull();
    await expect(env.MEDIA.resumeMultipartUpload(`v/${r.id}.mp4`, upload_id).uploadPart(2, "x")).rejects.toThrow();
    r.ws.close();
  });
});

describe("single upload (older recorders) is unchanged", () => {
  it("free and owner: one PUT up to 80 MB of video still works and still caps there", async () => {
    for (const owner of [false, true]) {
      const r = await started({ owner });
      const put = (body: Uint8Array, len = body.length) =>
        r.req("video", "PUT", body, r.token, { "content-type": "video/mp4", "content-length": String(len) });
      expect((await put(MP4(), 81 * MiB)).status).toBe(413);
      expect((await put(MP4())).status).toBe(200);
      expect((await r.complete()).status).toBe(200);
      const v = await mcp("get_video", { recording_id: r.id, wait_seconds: 5 }, r.key, r.e);
      expect(v.data.status).toBe("ready");
      // duration is clamped to the recording's own max_seconds (30 here), not a global constant
      expect(v.data.duration_s).toBe(30);
      r.ws.close();
    }
  });

  it("audio: a free 5-minute WAV (~9.6 MB) fits the free 10 MiB; owners may send more in one PUT, up to its 80 MB", async () => {
    const free = await started();
    const owner = await started({ owner: true, max_seconds: 1800 });
    const head = (r: typeof free, len: number) =>
      r.req("audio", "PUT", wav(16000, 1), r.token, { "content-type": "audio/wav", "content-length": String(len) });
    expect((await head(free, 11 * MiB)).status).toBe(413);
    expect((await head(owner, LIMITS.singleUploadMaxBytes + 1)).status).toBe(413);
    const ok = wav(16000, 300); // 9.6 MB
    expect((await free.req("audio", "PUT", ok, free.token, { "content-type": "audio/wav" })).status).toBe(200);
    const res = await owner.req("audio", "PUT", ok, owner.token, { "content-type": "audio/wav" });
    expect(res.status).toBe(200);
    free.ws.close();
    owner.ws.close();
  });

});

describe("complete checks the video's own length (mvhd)", () => {
  const putVideo = (r: Awaited<ReturnType<typeof started>>, body: Uint8Array) =>
    r.req("video", "PUT", body, r.token, { "content-type": "video/mp4" });
  const row = (id: string) =>
    env.DB.prepare("SELECT status, error FROM recordings WHERE id = ?").bind(id).first<{ status: string; error: string | null }>();
  /** An MP4 whose moov size runs past the end of the file. */
  const unreadable = () => {
    const b = MP4();
    new DataView(b.buffer).setUint32(24, 0xffffffff);
    return b;
  };

  it("free, 400 s against max_seconds 300: refused, video and audio deleted, recording failed, nothing transcribed", async () => {
    const r = await started({ max_seconds: 300 });
    expect((await putVideo(r, MP4(4096, 400))).status).toBe(200);
    expect((await r.req("audio", "PUT", wav(16000, 1), r.token, { "content-type": "audio/wav" })).status).toBe(200);
    const res = await r.complete();
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "LIMIT_EXCEEDED", limit: "max_seconds", max: 300, requested: 400, tier: "free" });
    expect(await env.MEDIA.head(`v/${r.id}.mp4`)).toBeNull();
    expect(await env.MEDIA.head(`a/${r.id}.wav`)).toBeNull();
    expect(await row(r.id)).toEqual({ status: "failed", error: "TOO_LONG" });
    expect((await r.complete()).status).toBe(409);
    r.ws.close();
  });

  it("free, 305 s against max_seconds 300 (within the 10 s slack): accepted", async () => {
    const r = await started({ max_seconds: 300 });
    expect((await putVideo(r, MP4(4096, 305))).status).toBe(200);
    expect((await r.complete()).status).toBe(200);
    expect((await mcp("get_video", { recording_id: r.id, wait_seconds: 5 }, r.key, r.e)).data.status).toBe("ready");
    r.ws.close();
  });

  it("unreadable length: free fails closed, an owner account is accepted", async () => {
    const free = await started({ max_seconds: 300 });
    expect((await putVideo(free, unreadable())).status).toBe(200);
    const res = await free.complete();
    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "LIMIT_EXCEEDED", limit: "max_seconds", max: 300, tier: "free" });
    expect(body.message).toMatch(/could not read the video length/i);
    expect(await env.MEDIA.head(`v/${free.id}.mp4`)).toBeNull();
    expect(await row(free.id)).toEqual({ status: "failed", error: "UNREADABLE_LENGTH" });
    free.ws.close();

    const owner = await started({ owner: true, max_seconds: 1800 });
    expect((await putVideo(owner, unreadable())).status).toBe(200);
    expect((await owner.complete()).status).toBe(200);
    expect((await mcp("get_video", { recording_id: owner.id, wait_seconds: 5 }, owner.key, owner.e)).data.status).toBe("ready");
    owner.ws.close();
  });
  it("pro: unreadable and fragmented lengths are refused; over the recording's own max_seconds is refused; within slack is accepted", async () => {
    const unread = await started({ plan: "pro", max_seconds: 1800 });
    expect((await putVideo(unread, unreadable())).status).toBe(200);
    const res = await unread.complete();
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "LIMIT_EXCEEDED", limit: "max_seconds", max: 1800, tier: "pro" });
    expect(await row(unread.id)).toEqual({ status: "failed", error: "UNREADABLE_LENGTH" });
    unread.ws.close();

    const frag = await started({ plan: "pro", max_seconds: 1800 });
    const mvex = box("mvex", box("mehd", new Uint8Array(8)));
    const fragmented = cat(ftyp(), box("moov", cat(mvhd(0, 1000, 0), trak({ mdhd: mdhd(0, 1000, 0), stts: stts([]) }), mvex)), box("moof", new Uint8Array(16)), box("mdat", new Uint8Array(4096)));
    expect((await putVideo(frag, fragmented)).status).toBe(200);
    expect((await frag.complete()).status).toBe(413);
    expect(await row(frag.id)).toEqual({ status: "failed", error: "UNREADABLE_LENGTH" });
    frag.ws.close();

    const long = await started({ plan: "pro", max_seconds: 1800 });
    expect((await putVideo(long, MP4(4096, 1815))).status).toBe(200);
    const res2 = await long.complete();
    expect(res2.status).toBe(413);
    expect(await res2.json()).toMatchObject({ error: "LIMIT_EXCEEDED", max: 1800, requested: 1815, tier: "pro" });
    long.ws.close();

    const ok = await started({ plan: "pro", max_seconds: 1800 });
    expect((await putVideo(ok, MP4(4096, 1805))).status).toBe(200);
    expect((await ok.complete()).status).toBe(200);
    ok.ws.close();
  });

  describe("fragmented MP4 with an mvhd of 0", () => {
    const run = (n: number, d: number) => trun(Array.from({ length: n }, () => d));

    it("free: a mehd of 400 s is refused as too long", async () => {
      const r = await started({ max_seconds: 300 });
      expect((await putVideo(r, fragmentedFile({ mvexKids: [mehd(400_000), trex(1)] }))).status).toBe(200);
      const res = await r.complete();
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: "LIMIT_EXCEEDED", max: 300, requested: 400, tier: "free" });
      expect(await env.MEDIA.head(`v/${r.id}.mp4`)).toBeNull();
      expect(await row(r.id)).toEqual({ status: "failed", error: "TOO_LONG" });
      r.ws.close();
    });

    it("free: trun samples summing to 400 s across moofs (no mehd) are refused as too long", async () => {
      const r = await started({ max_seconds: 300 });
      const moofs = [moof(traf(tfhd(1), run(200, 1000))), moof(traf(tfhd(1), run(200, 1000)))];
      expect((await putVideo(r, fragmentedFile({ mvexKids: [trex(1)], moofs }))).status).toBe(200);
      const res = await r.complete();
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: "LIMIT_EXCEEDED", max: 300, requested: 400, tier: "free" });
      expect(await row(r.id)).toEqual({ status: "failed", error: "TOO_LONG" });
      r.ws.close();
    });

    it("free: 200 s of fragments is accepted", async () => {
      const r = await started({ max_seconds: 300 });
      const moofs = [moof(traf(tfhd(1), run(100, 1000))), moof(traf(tfhd(1), run(100, 1000)))];
      expect((await putVideo(r, fragmentedFile({ mvexKids: [trex(1)], moofs }))).status).toBe(200);
      expect((await r.complete()).status).toBe(200);
      expect((await mcp("get_video", { recording_id: r.id, wait_seconds: 5 }, r.key, r.e)).data.status).toBe("ready");
      r.ws.close();
    });

    it("undeterminable (samples with no duration anywhere): free is refused, an owner account is accepted", async () => {
      const blind = () => fragmentedFile({ mvexKids: [trex(1)], moofs: [moof(traf(tfhd(1), trun({ count: 400 })))] });
      const free = await started({ max_seconds: 300 });
      expect((await putVideo(free, blind())).status).toBe(200);
      const res = await free.complete();
      expect(res.status).toBe(413);
      expect(((await res.json()) as { message: string }).message).toMatch(/could not read the video length/i);
      expect(await row(free.id)).toEqual({ status: "failed", error: "UNREADABLE_LENGTH" });
      free.ws.close();

      const owner = await started({ owner: true, max_seconds: 1800 });
      expect((await putVideo(owner, blind())).status).toBe(200);
      expect((await owner.complete()).status).toBe(200);
      expect((await mcp("get_video", { recording_id: owner.id, wait_seconds: 5 }, owner.key, owner.e)).data.status).toBe("ready");
      owner.ws.close();
    });
  });

  it("free: an mvhd (and track headers) of 0 s over 400 s of samples is refused as too long", async () => {
    const r = await started({ max_seconds: 300 });
    const zero = cat(ftyp(), box("moov", cat(mvhd(0, 1000, 0), trak({ tkhd: tkhd(0, 0), mdhd: mdhd(0, 1000, 0), stts: stts([[400, 1000]]) }))), box("mdat", new Uint8Array(4096)));
    expect((await putVideo(r, zero)).status).toBe(200);
    const res = await r.complete();
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "LIMIT_EXCEEDED", max: 300, requested: 400, tier: "free" });
    expect(await row(r.id)).toEqual({ status: "failed", error: "TOO_LONG" });
    r.ws.close();
  });
});

describe("long audio transcription", () => {
  it("is transcribed in windows with segment times shifted to the window", async () => {
    const r = await started({ owner: true, max_seconds: 1800 });
    expect((await r.req("video", "PUT", MP4(), r.token, { "content-type": "video/mp4" })).status).toBe(200);
    // 100 Hz keeps the file small: 700 s = 3 windows of 300 / 300 / 100 s.
    expect((await r.req("audio", "PUT", wav(100, 700), r.token, { "content-type": "audio/wav" })).status).toBe(200);
    expect((await r.complete()).status).toBe(200);
    const v = await mcp("get_video", { recording_id: r.id, wait_seconds: 5 }, r.key, r.e);
    expect(v.data.transcript_status).toBe("ready");
    const t = await mcp("get_transcript", { recording_id: r.id }, r.key, r.e);
    const starts = (t.data.transcript as string).split("\n").map((l) => l.slice(1, 6));
    expect(starts).toEqual(["00:00", "00:02", "05:00", "05:02", "10:00", "10:02"]);
    r.ws.close();
  });
});

describe("timeouts follow the recording's own length", () => {
  it("a 30-minute recording is not timed out after 32 minutes; a 30-second one is", async () => {
    const long = await started({ owner: true, max_seconds: 1800 });
    const short = await started();
    const ago = now() - 32 * 60;
    await env.DB.prepare("UPDATE recordings SET created_at = ?, status = 'recording' WHERE id IN (?, ?)").bind(ago, long.id, short.id).run();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "0 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    const status = async (id: string) =>
      (await env.DB.prepare("SELECT status FROM recordings WHERE id = ?").bind(id).first<{ status: string }>())?.status;
    expect(await status(long.id)).toBe("recording");
    expect(await status(short.id)).toBe("failed");
    long.ws.close();
    short.ws.close();
  });
});
