// Pro/Teams storage cap (storage.ts): bytes tracked per recording at upload and finalize, the cap and the 90% warning on
// start_recording and account_info, the transcription WAV deleted once transcription succeeds, the backfill of
// migration 0024 and the hourly reconcile of the rows it could only estimate.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LIMITS, type Env } from "../src/env";
import { cleanup } from "../src/index";
import { reconcileStorage, storageLimitMessage, storageWarningMessage } from "../src/storage";
import { issueUploadToken } from "../src/upload";
import { now, randomId } from "../src/util";
import migration0024 from "../migrations/0024_storage.sql?raw";
import { call, connectDevice, mcp, MP4, seedAccount, seedReady, withEnv } from "./helpers";

const GB = 1e9;
const WAV = (size = 1044) => {
  const b = new Uint8Array(size);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WAVE"), 8);
  return b;
};
const settle = () => new Promise((res) => setTimeout(res, 100));
const setPlan = (id: string, plan: string, addons = 0) =>
  env.DB.prepare("UPDATE accounts SET plan = ?, storage_addons = ? WHERE id = ?").bind(plan, addons, id).run();
/** A finished recording taking `bytes` of storage (no R2 object needed: usage is the tracked columns). */
async function seedBytes(accountId: string, bytes: number, audioBytes = 0): Promise<string> {
  const id = await seedReady(accountId);
  await env.DB.prepare("UPDATE recordings SET bytes = ?, audio_bytes = ? WHERE id = ?").bind(bytes, audioBytes, id).run();
  return id;
}
const sizes = (id: string) =>
  env.DB.prepare("SELECT bytes, audio_bytes, has_audio, transcript_status, error, status, sizes_checked FROM recordings WHERE id = ?")
    .bind(id)
    .first<{ bytes: number; audio_bytes: number; has_audio: number; transcript_status: string; error: string | null; status: string; sizes_checked: number }>();

const put = (id: string, part: string, token: string, body: Uint8Array, type: string, e: Env = env) =>
  call(
    `/upload/${id}/${part}`,
    { method: "PUT", body, headers: { authorization: `Bearer ${token}`, "content-type": type, "content-length": String(body.length) } },
    e,
  );
const complete = (id: string, token: string, e: Env = env) =>
  call(`/upload/${id}/complete`, { method: "POST", body: JSON.stringify({ duration_s: 8 }), headers: { authorization: `Bearer ${token}` } }, e);

async function startedRecording(plan = "pro", e: Env = env) {
  const acct = await seedAccount();
  await setPlan(acct.accountId, plan);
  const { ws } = await connectDevice(acct.deviceToken!);
  const r = await mcp("start_recording", { max_seconds: 30 }, acct.key, e);
  expect(r.isError, JSON.stringify(r.data)).toBe(false);
  const id: string = r.data.recording_id;
  const token = await issueUploadToken(env, id, acct.deviceId!, now() + 600);
  return { ...acct, id, token, ws };
}

describe("storage limits", () => {
  it("100 GB per paid account, 100 GB per add-on, 90% warning", () => {
    expect(LIMITS.storageBytesPerSeat).toBe(100 * GB);
    expect(LIMITS.storageAddonBytes).toBe(100 * GB);
    expect(LIMITS.storageWarnShare).toBe(0.9);
  });

  it("exact user-facing messages", () => {
    expect(storageLimitMessage(100 * GB)).toBe(
      "You've used your 100 GB of Recitbot storage. Delete old videos to free space, or add 100 GB more for $3/mo: just ask me to add storage.",
    );
    expect(storageWarningMessage(92_370_000_000, 100 * GB)).toBe("You've used 92.3 GB of your 100 GB of Recitbot storage.");
    expect(storageWarningMessage(90 * GB, 100 * GB)).toBe("You've used 90 GB of your 100 GB of Recitbot storage.");
    // With add-ons the cap named is the account's own.
    expect(storageLimitMessage(200 * GB)).toMatch(/^You've used your 200 GB of Recitbot storage\./);
    expect(storageWarningMessage(185 * GB, 200 * GB)).toBe("You've used 185 GB of your 200 GB of Recitbot storage.");
  });
});

describe("start_recording storage cap", () => {
  it("Pro at the cap: storage_limit_reached with the exact message, nothing reaches the PC; deleting frees space", async () => {
    const me = await seedAccount();
    await setPlan(me.accountId, "pro");
    const { ws, frames } = await connectDevice(me.deviceToken!);
    const big = await seedBytes(me.accountId, 60 * GB);
    await seedBytes(me.accountId, 39 * GB, 1 * GB); // WAV bytes count too: 100 GB in all

    const r = await mcp("start_recording", { max_seconds: 10 }, me.key);
    expect(r.isError).toBe(true);
    expect(r.data).toMatchObject({
      error: "storage_limit_reached",
      message:
        "You've used your 100 GB of Recitbot storage. Delete old videos to free space, or add 100 GB more for $3/mo: just ask me to add storage.",
      storage_used_bytes: 100 * GB,
      storage_limit_bytes: 100 * GB,
      storage_addons: 0,
    });
    expect(r.data.add_storage).toMatch(/add_storage/);
    await settle();
    expect(frames.filter((f) => f.type === "start")).toHaveLength(0);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM recordings WHERE account_id = ?").bind(me.accountId).first<{ n: number }>())!.n).toBe(2);

    // Deleting a recording frees its bytes: 40 GB used, no warning.
    expect((await mcp("delete", { recording_id: big }, me.key)).data).toMatchObject({ deleted: true });
    const ok = await mcp("start_recording", { max_seconds: 10 }, me.key);
    expect(ok.isError, JSON.stringify(ok.data)).toBe(false);
    expect(ok.data.storage_warning).toBeUndefined();
    ws.close();
    await settle();
  });

  it("refused even with the PC offline (checked before the device); over the cap too", async () => {
    const me = await seedAccount();
    await setPlan(me.accountId, "teams");
    await seedBytes(me.accountId, 101 * GB);
    expect((await mcp("start_recording", {}, me.key)).data.error).toBe("storage_limit_reached");
  });

  it("90% or more: the start succeeds with storage_warning; account_info shows usage, limit, add-ons and the warning", async () => {
    const me = await seedAccount();
    await setPlan(me.accountId, "pro");
    const { ws } = await connectDevice(me.deviceToken!);
    await seedBytes(me.accountId, 92_370_000_000);
    const r = await mcp("start_recording", { max_seconds: 10 }, me.key);
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(r.data.storage_warning).toBe("You've used 92.3 GB of your 100 GB of Recitbot storage.");
    const info = await mcp("account_info", {}, me.key);
    expect(info.data).toMatchObject({
      plan: "Pro",
      storage_used_bytes: 92_370_000_000,
      storage_limit_bytes: 100 * GB,
      storage_addons: 0,
      storage_warning: "You've used 92.3 GB of your 100 GB of Recitbot storage.",
    });
    ws.close();
    await settle();
  });

  it("below 90%: no warning anywhere", async () => {
    const me = await seedAccount();
    await setPlan(me.accountId, "pro");
    await seedBytes(me.accountId, 89_900_000_000);
    const info = await mcp("account_info", {}, me.key);
    expect(info.data).toMatchObject({ storage_used_bytes: 89_900_000_000, storage_limit_bytes: 100 * GB });
    expect(info.data.storage_warning).toBeUndefined();
  });

  it("each add-on adds 100 GB: 150 GB used is fine with one, warned at 180 GB, refused at 200 GB", async () => {
    const me = await seedAccount();
    await setPlan(me.accountId, "pro", 1);
    const { ws } = await connectDevice(me.deviceToken!);
    const a = await seedBytes(me.accountId, 150 * GB);
    const ok = await mcp("start_recording", { max_seconds: 10 }, me.key);
    expect(ok.isError, JSON.stringify(ok.data)).toBe(false);
    expect(ok.data.storage_warning).toBeUndefined();
    await env.DB.prepare("UPDATE recordings SET bytes = ? WHERE id = ?").bind(180 * GB, a).run();
    const warned = await mcp("start_recording", { max_seconds: 10 }, me.key);
    expect(warned.data.storage_warning).toBe("You've used 180 GB of your 200 GB of Recitbot storage.");
    await env.DB.prepare("UPDATE recordings SET bytes = ? WHERE id = ?").bind(200 * GB, a).run();
    const refused = await mcp("start_recording", { max_seconds: 10 }, me.key);
    expect(refused.data).toMatchObject({ error: "storage_limit_reached", storage_limit_bytes: 200 * GB, storage_addons: 1 });
    expect(refused.data.message).toMatch(/^You've used your 200 GB of Recitbot storage\. /);
    expect((await mcp("account_info", {}, me.key)).data).toMatchObject({ storage_limit_bytes: 200 * GB, storage_addons: 1 });
    ws.close();
    await settle();
  });

  it("Free and owners have no storage cap and no warning (Free keeps its own 25-video limit)", async () => {
    const free = await seedAccount();
    const planOwner = await seedAccount();
    const envOwner = await seedAccount();
    await setPlan(planOwner.accountId, "owner");
    const e = withEnv({ OWNER_ACCOUNT_IDS: envOwner.accountId });
    for (const a of [free, planOwner, envOwner]) {
      await seedBytes(a.accountId, 500 * GB);
      const { ws } = await connectDevice(a.deviceToken!);
      const r = await mcp("start_recording", { max_seconds: 10 }, a.key, e);
      expect(r.isError, JSON.stringify(r.data)).toBe(false);
      expect(r.data.storage_warning).toBeUndefined();
      const info = await mcp("account_info", {}, a.key, e);
      expect(info.data).toMatchObject({ storage_used_bytes: 500 * GB, storage_limit_bytes: null });
      expect(info.data.storage_warning).toBeUndefined();
      ws.close();
    }
    await settle();
  });

  it("Teams is per seat: each member account has its own 100 GB", async () => {
    const a = await seedAccount();
    const b = await seedAccount();
    await setPlan(a.accountId, "teams");
    await setPlan(b.accountId, "teams");
    await seedBytes(a.accountId, 100 * GB);
    expect((await mcp("start_recording", {}, a.key)).data.error).toBe("storage_limit_reached");
    expect((await mcp("account_info", {}, b.key)).data).toMatchObject({ storage_used_bytes: 0, storage_limit_bytes: 100 * GB });
  });
});

describe("bytes tracking and WAV cleanup", () => {
  it("video and WAV sizes are stored at upload; the WAV is deleted once transcription succeeds and stops counting", async () => {
    const r = await startedRecording();
    const video = MP4(8192);
    const wav = WAV(2044);
    expect((await put(r.id, "video", r.token, video, "video/mp4")).status).toBe(200);
    expect(await sizes(r.id)).toMatchObject({ bytes: 8192, audio_bytes: 0 });
    expect((await put(r.id, "audio", r.token, wav, "audio/wav")).status).toBe(200);
    expect(await sizes(r.id)).toMatchObject({ bytes: 8192, audio_bytes: 2044, has_audio: 1 });
    expect((await mcp("account_info", {}, r.key)).data.storage_used_bytes).toBe(8192 + 2044);

    expect((await complete(r.id, r.token)).status).toBe(200);
    expect(await sizes(r.id)).toMatchObject({ status: "ready", transcript_status: "ready", bytes: 8192, audio_bytes: 0, error: null });
    expect(await env.MEDIA.head(`a/${r.id}.wav`)).toBeNull();
    expect(await env.MEDIA.head(`v/${r.id}.mp4`)).not.toBeNull();
    expect((await mcp("account_info", {}, r.key)).data.storage_used_bytes).toBe(8192);
    // The transcript itself is kept.
    expect((await mcp("get_transcript", { recording_id: r.id }, r.key)).isError).toBe(false);
    r.ws.close();
    await settle();
  });

  it("on every plan: Free too", async () => {
    const r = await startedRecording("free");
    expect((await put(r.id, "video", r.token, MP4(), "video/mp4")).status).toBe(200);
    expect((await put(r.id, "audio", r.token, WAV(), "audio/wav")).status).toBe(200);
    expect((await complete(r.id, r.token)).status).toBe(200);
    expect(await sizes(r.id)).toMatchObject({ transcript_status: "ready", audio_bytes: 0 });
    expect(await env.MEDIA.head(`a/${r.id}.wav`)).toBeNull();
    r.ws.close();
    await settle();
  });

  it("silent audio counts as done: the WAV goes too", async () => {
    const r = await startedRecording();
    // A real PCM16 header with all-zero samples: the level check finds it silent, Whisper never runs.
    const wav = new Uint8Array(44 + 32000);
    const dv = new DataView(wav.buffer);
    const s = (o: number, t: string) => wav.set(new TextEncoder().encode(t), o);
    s(0, "RIFF");
    dv.setUint32(4, wav.length - 8, true);
    s(8, "WAVE");
    s(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true);
    dv.setUint32(24, 16000, true);
    dv.setUint32(28, 32000, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    s(36, "data");
    dv.setUint32(40, 32000, true);
    expect((await put(r.id, "video", r.token, MP4(), "video/mp4")).status).toBe(200);
    expect((await put(r.id, "audio", r.token, wav, "audio/wav")).status).toBe(200);
    expect((await complete(r.id, r.token)).status).toBe(200);
    expect(await sizes(r.id)).toMatchObject({ transcript_status: "silent", audio_bytes: 0 });
    expect(await env.MEDIA.head(`a/${r.id}.wav`)).toBeNull();
    r.ws.close();
    await settle();
  });

  it("transcription refused or unavailable (NO_TRANSCRIBE): the WAV is kept and still counted", async () => {
    const nt = withEnv({ SERVICE_MODE: "NO_TRANSCRIBE" });
    const r = await startedRecording("pro", nt);
    expect((await put(r.id, "video", r.token, MP4(), "video/mp4", nt)).status).toBe(200);
    expect((await put(r.id, "audio", r.token, WAV(1500), "audio/wav", nt)).status).toBe(200);
    expect((await complete(r.id, r.token, nt)).status).toBe(200);
    expect(await sizes(r.id)).toMatchObject({ transcript_status: "unavailable", audio_bytes: 1500 });
    expect(await env.MEDIA.head(`a/${r.id}.wav`)).not.toBeNull();
    r.ws.close();
    await settle();
  });

  it("no WAV uploaded (mic off; newer recorders send none): ready, no transcript, no error, never retried", async () => {
    const r = await startedRecording();
    expect((await put(r.id, "video", r.token, MP4(), "video/mp4")).status).toBe(200);
    expect((await complete(r.id, r.token)).status).toBe(200);
    const row = await sizes(r.id);
    expect(row).toMatchObject({ status: "ready", transcript_status: "none", has_audio: 0, audio_bytes: 0, error: null });
    const v = await mcp("get_video", { recording_id: r.id }, r.key);
    expect(v.data).toMatchObject({ status: "ready", transcript_status: "none" });
    expect(v.data.error).toBeUndefined();
    // The hourly cron doesn't pick it up again: nothing about it changes.
    await cleanup(env);
    expect(await sizes(r.id)).toEqual(row);
    r.ws.close();
    await settle();
  });

  it("a video refused as too long frees its bytes", async () => {
    const r = await startedRecording();
    expect((await put(r.id, "video", r.token, MP4(4096, 120), "video/mp4")).status).toBe(200);
    expect((await put(r.id, "audio", r.token, WAV(), "audio/wav")).status).toBe(200);
    expect((await complete(r.id, r.token)).status).toBe(413);
    expect(await sizes(r.id)).toMatchObject({ status: "failed", bytes: 0, audio_bytes: 0 });
    r.ws.close();
    await settle();
  });
});

describe("migration 0024 backfill and the hourly reconcile", () => {
  /** The migration's last statement (the backfill), run again over one account's rows made to look like pre-0024 ones. */
  const backfill = (accountId: string) => {
    const sql = migration0024.replace(/--[^\n]*\n/g, "\n");
    const stmt = sql.slice(sql.lastIndexOf("UPDATE recordings SET")).trim().replace(/;$/, "");
    expect(stmt).not.toMatch(/WHERE/);
    return env.DB.prepare(`${stmt} WHERE account_id = ?`).bind(accountId).run();
  };

  it("keeps known MP4 sizes, estimates WAVs from the length, marks every existing row unchecked", async () => {
    const { accountId } = await seedAccount(false);
    const withWav = await seedReady(accountId);
    const noWav = await seedReady(accountId);
    await env.DB.batch([
      env.DB.prepare("UPDATE recordings SET bytes = 5000, has_audio = 1, duration_s = 10, audio_bytes = 0 WHERE id = ?").bind(withWav),
      env.DB.prepare("UPDATE recordings SET bytes = 7000, has_audio = 0, audio_bytes = 0 WHERE id = ?").bind(noWav),
    ]);
    await backfill(accountId);
    expect(await sizes(withWav)).toMatchObject({ bytes: 5000, audio_bytes: 10 * 32000 + 44, sizes_checked: 0 });
    expect(await sizes(noWav)).toMatchObject({ bytes: 7000, audio_bytes: 0, sizes_checked: 0 });
    // New rows are exact from the start.
    const { accountId: other } = await seedAccount(false);
    expect((await sizes(await seedReady(other)))!.sizes_checked).toBe(1);
    await env.DB.prepare("UPDATE recordings SET sizes_checked = 1 WHERE account_id = ?").bind(accountId).run();
  });

  it("reconcile: real sizes from R2, already-transcribed WAVs deleted, failed-transcription WAVs kept and counted", async () => {
    // Other tests' rows must not be reconciled here: only this account's are unchecked.
    await env.DB.prepare("UPDATE recordings SET sizes_checked = 1").run();
    const { accountId } = await seedAccount(false);
    const done = await seedReady(accountId, { transcript: { segments: [], text: "hi" } });
    const failed = await seedReady(accountId);
    const neverUploaded = randomId(128);
    await env.DB.prepare(
      "INSERT INTO recordings (id, account_id, device_id, status, max_seconds, created_at, expires_at, sizes_checked, bytes) VALUES (?, ?, 'dev', 'failed', 60, ?, ?, 0, 0)",
    )
      .bind(neverUploaded, accountId, now(), now() + 86400)
      .run();
    await env.MEDIA.put(`a/${done}.wav`, WAV(3000));
    await env.MEDIA.put(`a/${failed}.wav`, WAV(4000));
    await env.DB.batch([
      env.DB.prepare("UPDATE recordings SET has_audio = 1, bytes = 1, audio_bytes = 999999, sizes_checked = 0 WHERE id = ?").bind(done),
      env.DB.prepare(
        "UPDATE recordings SET has_audio = 1, bytes = 1, audio_bytes = 999999, sizes_checked = 0, transcript_status = 'unavailable' WHERE id = ?",
      ).bind(failed),
    ]);
    const mp4 = (await env.MEDIA.head(`v/${done}.mp4`))!.size;

    expect(await reconcileStorage(env)).toEqual({ checked: 3, wavs_deleted: 1 });
    expect(await sizes(done)).toMatchObject({ bytes: mp4, audio_bytes: 0, sizes_checked: 1 });
    expect(await env.MEDIA.head(`a/${done}.wav`)).toBeNull();
    expect(await sizes(failed)).toMatchObject({ bytes: mp4, audio_bytes: 4000, sizes_checked: 1 });
    expect(await env.MEDIA.head(`a/${failed}.wav`)).not.toBeNull();
    expect(await sizes(neverUploaded)).toMatchObject({ bytes: 0, audio_bytes: 0, sizes_checked: 1 });
    // Nothing left: the next run is a no-op.
    expect(await reconcileStorage(env)).toEqual({ checked: 0, wavs_deleted: 0 });
  });

  it("runs from the hourly cron, a batch at a time", async () => {
    await env.DB.prepare("UPDATE recordings SET sizes_checked = 1").run();
    const { accountId } = await seedAccount(false);
    const ids = [await seedReady(accountId), await seedReady(accountId), await seedReady(accountId)];
    await env.DB.prepare("UPDATE recordings SET sizes_checked = 0, bytes = 0 WHERE account_id = ?").bind(accountId).run();
    expect(await reconcileStorage(env, 2)).toEqual({ checked: 2, wavs_deleted: 0 });
    const r = await cleanup(env);
    expect(r.storage).toEqual({ checked: 1, wavs_deleted: 0 });
    for (const id of ids) expect((await sizes(id))!.sizes_checked).toBe(1);
  });
});
