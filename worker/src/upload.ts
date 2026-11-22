// Device uploads (streamed straight to private R2) and transcription.
import { Buffer } from "node:buffer";
import { getConfig } from "./config";
import { deviceHub } from "./device-hub";
import type { Env } from "./env";
import { accountLimits, limitError, LIMITS, publicBase, serviceMode } from "./env";
import { governor } from "./governor";
import { mp4DurationSeconds } from "./mp4-duration";
import { finishRecording, readyThenTranscribe } from "./ready";
import type { Segment } from "./share";
import { mmss } from "./share";
import { hmacB64, json, log, now, safeEqual } from "./util";
import { isSilent, keepSegment, wavFile, wavInfo, wavLevel } from "./silence";
import { transcriptDone } from "./storage";
import { recordingRemoved } from "./takedown-state";

export async function issueUploadToken(env: Env, recId: string, deviceId: string, exp: number): Promise<string> {
  return `${exp}.${await hmacB64(env.UPLOAD_HMAC_KEY, `upload.${recId}.${deviceId}.${exp}`)}`;
}

async function verifyUploadToken(env: Env, req: Request, recId: string, deviceId: string): Promise<boolean> {
  const m = /^Bearer\s+(\d+)\.([A-Za-z0-9_-]+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m || Number(m[1]) < now()) return false;
  return safeEqual(`${m[1]}.${m[2]}`, await issueUploadToken(env, recId, deviceId, Number(m[1])));
}

/** Re-emits the stream after checking its first bytes, without buffering the body. */
async function checkedStream(
  body: ReadableStream<Uint8Array>,
  length: number,
  check: (head: Uint8Array) => boolean,
): Promise<ReadableStream<Uint8Array> | null> {
  const reader = body.getReader();
  let head = new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  while (head.length < 12) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    const merged = new Uint8Array(head.length + value.length);
    merged.set(head);
    merged.set(value, head.length);
    head = merged;
  }
  if (!check(head)) {
    await reader.cancel();
    return null;
  }
  const fixed = new FixedLengthStream(length);
  (async () => {
    const w = fixed.writable.getWriter();
    try {
      for (const c of chunks) await w.write(c);
    } catch (e) {
      await w.abort(e).catch(() => {});
      await reader.cancel(e).catch(() => {});
      return;
    }
    // The rest goes through without JavaScript touching it: a 32 MiB part costs next to no CPU time.
    w.releaseLock();
    reader.releaseLock();
    await body.pipeTo(fixed.writable).catch(() => {});
  })();
  return fixed.readable;
}

const ascii = (u: Uint8Array, from: number, to: number) => String.fromCharCode(...u.subarray(from, to));
const isMp4 = (h: Uint8Array) => h.length >= 8 && ascii(h, 4, 8) === "ftyp";
const isWav = (h: Uint8Array) => h.length >= 12 && ascii(h, 0, 4) === "RIFF" && ascii(h, 8, 12) === "WAVE";
const isJpeg = (h: Uint8Array) => h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff;

type RecRow = {
  id: string;
  account_id: string;
  device_id: string;
  status: string;
  has_audio: number;
  duration_s: number | null;
  max_seconds: number;
};

type Kind = "video" | "audio";
const mediaKey = (id: string, kind: Kind) => (kind === "video" ? `v/${id}.mp4` : `a/${id}.wav`);
const mediaType = (kind: Kind) => (kind === "video" ? "video/mp4" : "audio/wav");
/** Seconds a video may run past its recording's max_seconds (recorder stop latency, container rounding). */
const DURATION_SLACK_S = 10;

/**
 * Marks a stored video (status uploading) or audio (has_audio) on the recording, with its size in R2 (bytes /
 * audio_bytes: the account's storage use, storage.ts).
 */
const stored = (env: Env, id: string, kind: Kind, size: number) =>
  env.DB.prepare(
    kind === "video"
      ? "UPDATE recordings SET status = 'uploading', bytes = ? WHERE id = ?"
      : "UPDATE recordings SET has_audio = 1, audio_bytes = ? WHERE id = ?",
  )
    .bind(size, id)
    .run();

/**
 * PUT /upload/:id/(video|audio), POST /upload/:id/complete, and the chunked upload under /upload/:id/(video|audio)/mp
 * (`step` = "" for create/abort, a part number, or "complete").
 */
export async function handleUpload(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  id: string,
  part: string,
  step?: string,
): Promise<Response> {
  const mode = serviceMode(env);
  if (mode === "OFF" || mode === "READ_ONLY") return json({ error: "SERVICE_PAUSED" }, 503);
  const rec = await env.DB.prepare("SELECT id, account_id, device_id, status, has_audio, duration_s, max_seconds FROM recordings WHERE id = ?")
    .bind(id)
    .first<RecRow>();
  if (!rec || !(await verifyUploadToken(env, req, id, rec.device_id))) return json({ error: "UNAUTHORIZED" }, 401);
  if (!["starting", "recording", "uploading"].includes(rec.status)) return json({ error: "BAD_STATE" }, 409);

  if (step !== undefined && (part === "video" || part === "audio")) return handleMultipart(req, env, rec, part, step);

  if (part === "complete" && req.method === "POST") {
    const head = await env.MEDIA.head(`v/${id}.mp4`);
    if (!head) return json({ error: "NO_VIDEO" }, 409);
    const body = (await req.json().catch(() => ({}))) as { duration_s?: unknown; has_system_audio?: unknown };
    const dur = Math.min(Math.max(Number(body.duration_s) || 0, 0), rec.max_seconds);
    await abortMultipartUploads(env, "recording_id = ?", [id]);
    // The real length, from the stored MP4 (mvhd and every track: mp4-duration.ts, bounded ranged reads): over the
    // recording's limit (the plan's maxSeconds at most, when it has one) + slack is refused. A length that can't be read (including a
    // fragmented MP4 with no mehd or trun durations; the recorders never write fragments) is refused too, except for
    // the Owner tier (logged).
    const limits = await accountLimits(env, rec.account_id);
    const max = limits.maxSeconds === null ? rec.max_seconds : Math.min(rec.max_seconds, limits.maxSeconds);
    const seconds = await mp4DurationSeconds(async (offset, length) => {
      const part = await env.MEDIA.get(`v/${id}.mp4`, { range: { offset, length } });
      return part ? new Uint8Array(await part.arrayBuffer()) : new Uint8Array(0);
    }, head.size).catch(() => null);
    if (seconds === null && limits.tier === "owner") log("warn", "video length unreadable, accepted (owner)", { id });
    else if (seconds === null || seconds > max + DURATION_SLACK_S) {
      await env.MEDIA.delete([`v/${id}.mp4`, `a/${id}.wav`]);
      await env.DB.prepare("UPDATE recordings SET status = 'failed', error = ?, bytes = 0, audio_bytes = 0 WHERE id = ?")
        .bind(seconds === null ? "UNREADABLE_LENGTH" : "TOO_LONG", id)
        .run();
      const err = limitError("max_seconds", max, Math.ceil(seconds ?? 0), limits.tier);
      if (seconds !== null) return json(err, 413);
      return json({ ...err, requested: undefined, message: `Could not read the video length. This account can record at most ${max} seconds per recording.` }, 413);
    }
    await env.DB.prepare("UPDATE recordings SET status = 'transcribing', duration_s = ?, bytes = ?, has_system_audio = ? WHERE id = ?")
      .bind(dur, head.size, body.has_system_audio === true ? 1 : 0, id)
      .run();
    const base = publicBase(env, new URL(req.url).origin);
    const run = () => transcribe(env, id, rec.account_id, rec.has_audio === 1);
    ctx.waitUntil(getConfig(env).workers.readyBeforeTranscript ? readyThenTranscribe(env, id, base, run) : finishRecording(env, id, base, run()));
    // The recorder is idle again: an automatic update held during the recording can go now (auto-update.ts).
    ctx.waitUntil(
      deviceHub(env, rec.account_id)
        .recordingEnded(rec.account_id, rec.device_id)
        .catch((e) => log("warn", "auto-update after recording failed", { id, err: String(e) })),
    );
    return json({ ok: true });
  }

  if (req.method !== "PUT" || (part !== "video" && part !== "audio")) return json({ error: "NOT_FOUND" }, 404);
  const isVideo = part === "video";
  const limits = await accountLimits(env, rec.account_id);
  const max = Math.min(isVideo ? limits.maxVideoBytes : limits.maxAudioBytes, LIMITS.singleUploadMaxBytes);
  const len = Number(req.headers.get("content-length"));
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim();
  if (type !== (isVideo ? "video/mp4" : "audio/wav")) return json({ error: "BAD_CONTENT_TYPE" }, 415);
  if (!Number.isInteger(len) || len <= 0 || len > max || !req.body) return json({ error: "TOO_LARGE_OR_NO_LENGTH" }, 413);

  // Governor gate before any storage spend; unreachable => refuse.
  let allowed = false;
  try {
    allowed = await governor(env).checkUpload(len, max);
  } catch {
    allowed = false;
  }
  if (!allowed) return json({ error: "CAP_REACHED" }, 503);

  const stream = await checkedStream(req.body, len, isVideo ? isMp4 : isWav);
  if (!stream) return json({ error: "BAD_MAGIC" }, 415);
  await env.MEDIA.put(mediaKey(id, part), stream, { httpMetadata: { contentType: mediaType(part) } });
  await stored(env, id, part, len);
  return json({ ok: true, bytes: len });
}

/** R2 key of a recording's keyframe in slot n. */
export const keyframeKey = (id: string, n: number) => `k/${id}/${n}.jpg`;
/** Every keyframe key a recording can have (slots 1..maxKeyframes): deletes need no R2 list. */
export const keyframeKeys = (id: string) => Array.from({ length: LIMITS.maxKeyframes }, (_, i) => keyframeKey(id, i + 1));

/**
 * PUT /upload/:id/keyframes/:n?t=<ms> (recorder 0.6.1 "keyframes"): one JPEG still taken from the uploaded MP4, sent
 * after /complete, so the recording is uploading, transcribing or ready by then. Same upload token as the MP4. Stored
 * at R2 k/<id>/<n>.jpg with its time in recording_keyframes; a PUT to a slot that has one replaces it. The recorder
 * stops at the first refusal and never retries (status codes per its contract: 401, 409, 413, 415).
 */
export async function handleKeyframe(req: Request, env: Env, id: string, slot: string): Promise<Response> {
  const mode = serviceMode(env);
  if (mode === "OFF" || mode === "READ_ONLY") return json({ error: "SERVICE_PAUSED" }, 503);
  if (req.method !== "PUT") return json({ error: "NOT_FOUND" }, 404);
  const rec = await env.DB.prepare("SELECT device_id, status FROM recordings WHERE id = ?").bind(id).first<{ device_id: string; status: string }>();
  if (!rec || !(await verifyUploadToken(env, req, id, rec.device_id))) return json({ error: "UNAUTHORIZED" }, 401);
  if (!["uploading", "transcribing", "ready"].includes(rec.status)) return json({ error: "BAD_STATE" }, 409);

  const n = Number(slot);
  if (n < 1) return json({ error: "BAD_REQUEST", message: `n must be 1-${LIMITS.maxKeyframes}` }, 400);
  if (n > LIMITS.maxKeyframes) return json({ error: "TOO_MANY_KEYFRAMES", max_keyframes: LIMITS.maxKeyframes }, 413);
  const t = new URL(req.url).searchParams.get("t") ?? "";
  if (!/^\d{1,8}$/.test(t)) return json({ error: "BAD_REQUEST", message: "t must be a whole number of milliseconds" }, 400);
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim();
  if (type !== "image/jpeg") return json({ error: "BAD_CONTENT_TYPE" }, 415);
  const len = Number(req.headers.get("content-length"));
  if (!Number.isInteger(len) || len <= 0 || len > LIMITS.keyframeMaxBytes || !req.body) return json({ error: "TOO_LARGE_OR_NO_LENGTH" }, 413);

  let allowed = false;
  try {
    allowed = await governor(env).checkUpload(len, LIMITS.keyframeMaxBytes);
  } catch {
    allowed = false;
  }
  if (!allowed) return json({ error: "CAP_REACHED" }, 503);

  const stream = await checkedStream(req.body, len, isJpeg);
  if (!stream) return json({ error: "BAD_MAGIC" }, 415);
  const key = keyframeKey(id, n);
  await env.MEDIA.put(key, stream, { httpMetadata: { contentType: "image/jpeg" }, customMetadata: { t_ms: t } });
  await env.DB.prepare(
    "INSERT INTO recording_keyframes (recording_id, n, t_ms, bytes, created_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT (recording_id, n) DO UPDATE SET t_ms = excluded.t_ms, bytes = excluded.bytes, created_at = excluded.created_at",
  )
    .bind(id, n, Number(t), len, now())
    .run();
  // Deleted (or failed) while the still was on its way: take it back out, so nothing outlives the recording.
  const still = await env.DB.prepare("SELECT status FROM recordings WHERE id = ?").bind(id).first<{ status: string }>();
  if (!still || still.status === "failed") {
    await env.MEDIA.delete(key);
    await env.DB.prepare("DELETE FROM recording_keyframes WHERE recording_id = ? AND n = ?").bind(id, n).run();
    return json({ error: "BAD_STATE" }, 409);
  }
  return json({ ok: true, n, t_ms: Number(t), bytes: len });
}

type MpRow = { upload_id: string; part_bytes: number; parts: string; bytes: number; closed: number };
type MpPart = { n: number; etag: string; size: number };

/**
 * Aborts the R2 multipart uploads matching `where` (on multipart_uploads) and forgets them. R2 errors are logged, not
 * thrown: an upload R2 no longer knows is already gone (and R2 drops unfinished uploads by itself after 7 days).
 */
export async function abortMultipartUploads(env: Env, where: string, binds: unknown[], limit = 500): Promise<number> {
  const rows = await env.DB.prepare(`SELECT recording_id, kind, upload_id FROM multipart_uploads WHERE ${where} LIMIT ${Math.trunc(limit)}`)
    .bind(...binds)
    .all<{ recording_id: string; kind: Kind; upload_id: string }>();
  for (const r of rows.results) {
    try {
      await env.MEDIA.resumeMultipartUpload(mediaKey(r.recording_id, r.kind), r.upload_id).abort();
    } catch (e) {
      log("warn", "multipart abort failed", { id: r.recording_id, kind: r.kind, err: String(e) });
    }
    await env.DB.prepare("DELETE FROM multipart_uploads WHERE recording_id = ? AND kind = ? AND upload_id = ?")
      .bind(r.recording_id, r.kind, r.upload_id)
      .run();
  }
  return rows.results.length;
}

/**
 * Chunked upload of one file (video or audio) through an R2 multipart upload, for files over one request body:
 *   POST   mp           create (aborts an earlier one for this file); optional body {total_bytes} is checked up front
 *   PUT    mp/:n        part n, strictly in order (n = last + 1; re-sending the last part replaces it). Every part but the
 *                       last has part 1's size (16-50 MiB); a smaller part is the last one
 *   POST   mp/complete  body {parts: N}: N must be the number of parts received, else nothing is assembled
 *   DELETE mp           abort
 * Any R2 failure aborts the whole upload: the recorder starts over with a new create.
 */
async function handleMultipart(req: Request, env: Env, rec: RecRow, kind: Kind, step: string): Promise<Response> {
  const id = rec.id;
  const limits = await accountLimits(env, rec.account_id);
  const maxTotal = kind === "video" ? limits.maxVideoBytes : limits.maxAudioBytes;
  const tooBig = (requested: number) =>
    json(limitError(kind === "video" ? "video_bytes" : "audio_bytes", maxTotal, requested, limits.tier), 413);
  const where = "recording_id = ? AND kind = ?";

  if (step === "" && req.method === "DELETE") {
    await abortMultipartUploads(env, where, [id, kind]);
    return json({ ok: true });
  }

  if (step === "" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { total_bytes?: unknown };
    const total = Number(body.total_bytes ?? 0);
    if (!Number.isFinite(total) || total < 0) return json({ error: "BAD_REQUEST" }, 400);
    if (total > maxTotal) return tooBig(total);
    await abortMultipartUploads(env, where, [id, kind]);
    const mp = await env.MEDIA.createMultipartUpload(mediaKey(id, kind), { httpMetadata: { contentType: mediaType(kind) } });
    await env.DB.prepare("INSERT INTO multipart_uploads (recording_id, kind, upload_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(id, kind, mp.uploadId, now())
      .run();
    return json({
      ok: true,
      part_bytes: LIMITS.uploadPartBytes,
      min_part_bytes: LIMITS.minPartBytes,
      max_part_bytes: LIMITS.maxPartBytes,
      max_parts: LIMITS.maxParts,
      max_bytes: maxTotal,
    });
  }

  const row = await env.DB.prepare(`SELECT upload_id, part_bytes, parts, bytes, closed FROM multipart_uploads WHERE ${where}`)
    .bind(id, kind)
    .first<MpRow>();
  const parts = row ? (JSON.parse(row.parts) as MpPart[]) : [];
  const fail = async (e: unknown) => {
    log("error", "multipart upload failed", { id, kind, err: String(e) });
    await abortMultipartUploads(env, where, [id, kind]);
    return json({ error: "UPLOAD_ABORTED" }, 502);
  };

  if (step === "complete" && req.method === "POST") {
    if (!row) return json({ error: "NO_UPLOAD" }, 409);
    const body = (await req.json().catch(() => ({}))) as { parts?: unknown };
    if (!parts.length || body.parts !== parts.length) {
      return json({ error: "PARTS_MISSING", received: parts.length, expected: body.parts ?? null }, 409);
    }
    try {
      await env.MEDIA.resumeMultipartUpload(mediaKey(id, kind), row.upload_id).complete(
        parts.map((p) => ({ partNumber: p.n, etag: p.etag })),
      );
    } catch (e) {
      return fail(e);
    }
    await env.DB.prepare(`DELETE FROM multipart_uploads WHERE ${where} AND upload_id = ?`).bind(id, kind, row.upload_id).run();
    await stored(env, id, kind, row.bytes);
    return json({ ok: true, parts: parts.length, bytes: row.bytes });
  }

  if (req.method !== "PUT" || !/^\d{1,3}$/.test(step)) return json({ error: "NOT_FOUND" }, 404);
  if (!row) return json({ error: "NO_UPLOAD" }, 409);
  const n = Number(step);
  const retry = n === parts.length && n > 0;
  if (n !== parts.length + 1 && !retry) return json({ error: "PART_OUT_OF_ORDER", expected: parts.length + 1 }, 409);
  if (!retry && row.closed) return json({ error: "PART_AFTER_LAST", parts: parts.length }, 409);
  if (n > LIMITS.maxParts) return json({ error: "TOO_MANY_PARTS", max_parts: LIMITS.maxParts }, 413);
  const len = Number(req.headers.get("content-length"));
  if (!Number.isInteger(len) || len <= 0 || len > LIMITS.maxPartBytes || !req.body) return json({ error: "BAD_PART_SIZE" }, 413);
  // R2 wants every part but the last to be the same size: part 1 sets it, a smaller part ends the upload.
  const partBytes = n === 1 ? (len >= LIMITS.minPartBytes ? len : 0) : row.part_bytes;
  if (n > 1 && len > partBytes) return json({ error: "BAD_PART_SIZE", part_bytes: partBytes }, 413);
  const closed = n === 1 ? partBytes === 0 : len < partBytes;
  const before = row.bytes - (retry ? parts[n - 1].size : 0);
  if (before + len > maxTotal) return tooBig(before + len);

  let allowed = false;
  try {
    allowed = await governor(env).checkUpload(len, LIMITS.maxPartBytes);
  } catch {
    allowed = false;
  }
  if (!allowed) return json({ error: "CAP_REACHED" }, 503);

  const stream = await checkedStream(req.body, len, n === 1 ? (kind === "video" ? isMp4 : isWav) : () => true);
  if (!stream) return json({ error: "BAD_MAGIC" }, 415);
  let uploaded: R2UploadedPart;
  try {
    uploaded = await env.MEDIA.resumeMultipartUpload(mediaKey(id, kind), row.upload_id).uploadPart(n, stream);
  } catch (e) {
    await stream.cancel().catch(() => {});
    return fail(e);
  }
  const next = [...parts.slice(0, n - 1), { n, etag: uploaded.etag, size: len }];
  // Guarded on the parts we read: a concurrent PUT for the same upload loses instead of corrupting the list.
  const upd = await env.DB.prepare(
    `UPDATE multipart_uploads SET parts = ?, bytes = ?, part_bytes = ?, closed = ? WHERE ${where} AND upload_id = ? AND parts = ?`,
  )
    .bind(JSON.stringify(next), before + len, partBytes, closed ? 1 : 0, id, kind, row.upload_id, row.parts)
    .run();
  if (!upd.meta.changes) return json({ error: "CONFLICT" }, 409);
  return json({ ok: true, part: n, bytes: before + len, last: closed });
}

export interface Transcriber {
  run(audio: ArrayBuffer): Promise<{ segments: Segment[]; text: string }>;
}

/** Dev stub: Workers AI isn't available in local Miniflare. */
const stubTranscriber: Transcriber = {
  async run() {
    return {
      text: "(dev stub transcript) Hello from Agent Recorder.",
      segments: [
        { start: 0, end: 2, text: "(dev stub transcript)" },
        { start: 2, end: 4, text: "Hello from Agent Recorder." },
      ],
    };
  },
};

function aiTranscriber(ai: Ai): Transcriber {
  return {
    async run(audio) {
      // whisper-large-v3-turbo takes base64 audio; returns { text, segments[{start,end,text}], vtt }.
      const b64 = Buffer.from(audio).toString("base64");
      const out = (await ai.run("@cf/openai/whisper-large-v3-turbo" as never, { audio: b64 } as never)) as {
        text?: string;
        segments?: (Segment & { no_speech_prob?: number; avg_logprob?: number })[];
      };
      const kept = (out.segments ?? []).filter(keepSegment);
      return {
        text: out.segments ? kept.map((s) => s.text.trim()).join(" ").trim() : (out.text ?? ""),
        segments: kept.map((s) => ({ start: s.start, end: s.end, text: s.text })),
      };
    },
  };
}

export function transcriberFor(env: Env): Transcriber | null {
  if (env.DEV_MODE === "true") return stubTranscriber;
  return env.AI ? aiTranscriber(env.AI) : null;
}

/**
 * Minutes a stored transcription WAV is charged: its PCM16 16 kHz mono bytes (32000 per second; the object size less a
 * 44-byte WAV header), rounded up, at least 1. Never the client's duration_s or the WAV header's fields.
 */
export const transcribeMinutes = (objectBytes: number) => Math.max(1, Math.ceil(Math.max(0, objectBytes - 44) / 32000 / 60));

/**
 * Transcribes the recording's WAV and marks it ready. No WAV uploaded (mic off; newer recorders then send none): ready
 * with no transcript and no error (transcript_status none), never tried again. Once transcription succeeds (a
 * transcript, or silent audio) the WAV is deleted from R2 on every plan: only the MP4 is kept. A failed or refused
 * transcription keeps it. A recording that is taken down, or whose account is suspended (takedown-state.ts), is marked
 * ready without transcribing (no ASR minutes, no transcript of removed content); its WAV is kept like a refused one.
 */
export async function transcribe(env: Env, id: string, accountId: string, hasAudio: boolean): Promise<void> {
  let status = "none";
  let transcript: string | null = null;
  try {
    if (hasAudio && (await recordingRemoved(env, id, accountId))) {
      status = "unavailable";
      log("warn", "transcription skipped: taken down", { id, account_id: accountId });
    } else if (hasAudio) {
      status = "unavailable";
      const t = transcriberFor(env);
      const audio = serviceMode(env) === "ON" && t !== null ? await env.MEDIA.head(`a/${id}.wav`) : null;
      const check = audio
        ? await governor(env).checkTranscribe({
            accountId,
            minutes: transcribeMinutes(audio.size),
            accountMaxPerDay: (await accountLimits(env, accountId)).transcribeMinPerDay,
            globalMaxPerDay: Number(env.GLOBAL_MAX_TRANSCRIBE_MIN_PER_DAY),
            now: now(),
          })
        : null;
      if (check && !check.ok) log("info", "transcription refused", { id, refused: check.refused });
      const r = check?.ok && t ? await transcribeWav(env, id, t) : null;
      if (r === "silent") status = "silent";
      else if (r) {
        transcript = JSON.stringify(r);
        status = "ready";
      }
    }
  } catch (e) {
    log("error", "transcription failed", { id, err: String(e) });
    status = "unavailable";
  }
  await env.DB.prepare("UPDATE recordings SET status = 'ready', transcript = ?, transcript_status = ? WHERE id = ?")
    .bind(transcript, status, id)
    .run();
  if (hasAudio && transcriptDone(status)) {
    try {
      await env.MEDIA.delete(`a/${id}.wav`);
      await env.DB.prepare("UPDATE recordings SET audio_bytes = 0 WHERE id = ?").bind(id).run();
    } catch (e) {
      log("warn", "wav delete failed", { id, err: String(e) });
    }
  }
}

/**
 * Transcribes a/<id>.wav: in one piece when it is at most transcribeChunkSeconds long (or its header is not plain PCM16),
 * else window by window through R2 range reads, so a 30-minute WAV never sits in memory whole. Silent windows are
 * skipped; segment times are shifted to the window's place in the file. null = no audio stored.
 */
async function transcribeWav(env: Env, id: string, t: Transcriber): Promise<{ segments: Segment[]; text: string } | "silent" | null> {
  const key = `a/${id}.wav`;
  const head = await env.MEDIA.get(key, { range: { offset: 0, length: 4096 } });
  if (!head) return null;
  const info = wavInfo(await head.arrayBuffer());
  const pcmBytes = info ? Math.max(0, Math.min(info.dataSize, head.size - info.dataOffset)) : 0;
  const window = info ? Math.floor((info.byteRate * LIMITS.transcribeChunkSeconds) / info.blockAlign) * info.blockAlign : 0;

  if (!info || pcmBytes <= window) {
    if (head.size > LIMITS.wholeWavMaxBytes) return null;
    const audio = await env.MEDIA.get(key);
    if (!audio) return null;
    const buf = await audio.arrayBuffer();
    const level = wavLevel(buf);
    if (isSilent(level)) {
      log("info", "silent audio, transcription skipped", { id, rms: level?.rmsDbfs, peak: level?.peakDbfs });
      return "silent";
    }
    const r = await t.run(buf);
    return r.segments.length === 0 && !r.text.trim() ? "silent" : r;
  }

  const segments: Segment[] = [];
  const texts: string[] = [];
  for (let off = 0; off < pcmBytes; off += window) {
    const part = await env.MEDIA.get(key, { range: { offset: info.dataOffset + off, length: Math.min(window, pcmBytes - off) } });
    if (!part) return null;
    const wav = wavFile(info, new Uint8Array(await part.arrayBuffer()));
    if (isSilent(wavLevel(wav))) continue;
    const at = off / info.byteRate;
    const r = await t.run(wav);
    segments.push(...r.segments.map((s) => ({ start: s.start + at, end: s.end + at, text: s.text })));
    if (r.text.trim()) texts.push(r.text.trim());
  }
  if (!segments.length && !texts.length) return "silent";
  return { segments, text: texts.join(" ") };
}

export function toVtt(segments: Segment[]): string {
  const ts = (t: number) => `${mmss(t)}.${String(Math.round((t % 1) * 1000)).padStart(3, "0")}`;
  return ["WEBVTT", "", ...segments.flatMap((s) => [`00:${ts(s.start)} --> 00:${ts(s.end)}`, s.text.trim(), ""])].join("\n");
}
