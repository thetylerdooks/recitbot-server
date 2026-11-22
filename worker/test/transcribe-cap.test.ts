// Transcription minutes: charged from the stored audio bytes (16 kHz mono PCM16), never duration_s or the WAV header,
// against a per-account daily cap from the plan (Free 60, Pro/Teams 600, owner none) and the global daily budget.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { accountLimits, tierLimits } from "../src/env";
import { governor } from "../src/governor";
import { issueUploadToken, transcribe, transcribeMinutes } from "../src/upload";
import { now, randomId } from "../src/util";
import { brokenGovernor, call, connectDevice, mcp, MP4, seedAccount, suspendAccount, withEnv } from "./helpers";

const DAY = 86400;
const g = () => governor(env);
const charge = (accountId: string, minutes: number, accountMaxPerDay: number | null, t: number, globalMaxPerDay = 1_000_000) =>
  g().checkTranscribe({ accountId, minutes, accountMaxPerDay, globalMaxPerDay, now: t });
const charged = (accountId: string, t = now()) =>
  runInDurableObject(g(), (_i, s) =>
    Number(s.storage.sql.exec<{ n: number }>("SELECT n FROM daily WHERE k = ? AND day = ?", `transcribe_min:${accountId}`, Math.floor(t / DAY)).toArray()[0]?.n ?? 0),
  );

/** A 44-byte WAV header that lies (says 1 s of 8 kHz stereo) followed by `pcm` zero bytes. */
function lyingWav(pcm: number): Uint8Array {
  const b = new Uint8Array(44 + pcm);
  const v = new DataView(b.buffer);
  const tag = (at: number, s: string) => b.set(new TextEncoder().encode(s), at);
  tag(0, "RIFF");
  v.setUint32(4, 36 + 32000, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, 32000, true);
  return b;
}

/** A recording row with duration_s 10 and its audio object, ready for transcribe(). */
async function stored(accountId: string, wav: Uint8Array): Promise<string> {
  const id = randomId(128);
  await env.DB.prepare(
    "INSERT INTO recordings (id, account_id, device_id, status, duration_s, max_seconds, created_at, expires_at) VALUES (?, ?, 'dev', 'transcribing', 10, 300, ?, ?)",
  )
    .bind(id, accountId, now(), now() + DAY)
    .run();
  await env.MEDIA.put(`a/${id}.wav`, wav);
  return id;
}
const transcriptStatus = async (id: string) =>
  (await env.DB.prepare("SELECT transcript_status FROM recordings WHERE id = ?").bind(id).first<{ transcript_status: string }>())!.transcript_status;

describe("transcription minutes come from the audio bytes", () => {
  it("ceil(bytes / 32000 / 60) after the 44-byte header, at least 1", () => {
    expect(transcribeMinutes(44 + 9_600_000)).toBe(5);
    expect(transcribeMinutes(44 + 9_600_001)).toBe(6);
    expect(transcribeMinutes(44 + 1)).toBe(1);
    expect(transcribeMinutes(44)).toBe(1);
  });

  it("an upload whose client says duration_s=10 but whose audio is 5 minutes of PCM16 (lying header) is charged 5 minutes", async () => {
    const acct = await seedAccount();
    const { ws } = await connectDevice(acct.deviceToken!);
    const r = await mcp("start_recording", { mic: true, max_seconds: 30 }, acct.key);
    expect(r.isError).toBe(false);
    const id: string = r.data.recording_id;
    const auth = { authorization: `Bearer ${await issueUploadToken(env, id, acct.deviceId!, now() + 600)}` };
    const put = (part: string, b: Uint8Array, type: string) =>
      call(`/upload/${id}/${part}`, { method: "PUT", body: b, headers: { ...auth, "content-type": type, "content-length": String(b.length) } });
    expect((await put("video", MP4(), "video/mp4")).status).toBe(200);
    expect((await put("audio", lyingWav(9_600_000), "audio/wav")).status).toBe(200);
    expect((await call(`/upload/${id}/complete`, { method: "POST", body: JSON.stringify({ duration_s: 10 }), headers: auth })).status).toBe(200);
    const v = await mcp("get_video", { recording_id: id, wait_seconds: 5 }, acct.key);
    expect(v.data).toMatchObject({ status: "ready", duration_s: 10 });
    expect(v.data.transcript_status).not.toBe("unavailable");
    expect(await charged(acct.accountId)).toBe(5);
    ws.close();
  });
});

describe("per-account daily transcription cap", () => {
  it("plan limits: Free 60, Pro and Teams 600, owner none (OWNER_ACCOUNT_IDS or accounts.plan 'owner')", async () => {
    expect(tierLimits("free").transcribeMinPerDay).toBe(60);
    expect(tierLimits("teams").transcribeMinPerDay).toBe(600);
    const free = await seedAccount(false);
    expect((await accountLimits(env, free.accountId)).transcribeMinPerDay).toBe(60);
    const pro = await seedAccount(false);
    await env.DB.prepare("UPDATE accounts SET plan = 'pro' WHERE id = ?").bind(pro.accountId).run();
    expect((await accountLimits(env, pro.accountId)).transcribeMinPerDay).toBe(600);
    const owner = await seedAccount(false);
    await env.DB.prepare("UPDATE accounts SET plan = 'owner' WHERE id = ?").bind(owner.accountId).run();
    expect((await accountLimits(env, owner.accountId)).transcribeMinPerDay).toBeNull();
    expect((await accountLimits(withEnv({ OWNER_ACCOUNT_IDS: free.accountId }), free.accountId)).transcribeMinPerDay).toBeNull();
  });

  it("Free: 60 minutes pass, the next minute is refused; another Free account is unaffected", async () => {
    const t = now() + 10 * DAY;
    const a = randomId(128);
    expect(await charge(a, 59, 60, t)).toEqual({ ok: true });
    expect(await charge(a, 1, 60, t)).toEqual({ ok: true });
    expect(await charge(a, 1, 60, t)).toEqual({ ok: false, refused: "account" });
    expect(await charged(a, t)).toBe(60);
    expect(await charge(randomId(128), 60, 60, t)).toEqual({ ok: true });
    // Next UTC day starts over.
    expect(await charge(a, 1, 60, t + DAY)).toEqual({ ok: true });
  });

  it("a refused account reserves nothing globally", async () => {
    const t = now() + 20 * DAY;
    const a = randomId(128);
    expect(await charge(a, 61, 60, t, 100)).toEqual({ ok: false, refused: "account" });
    expect(await charge(randomId(128), 100, null, t, 100)).toEqual({ ok: true });
  });

  it("Pro: allowed past 60, refused past 600", async () => {
    const t = now() + 30 * DAY;
    const a = randomId(128);
    expect(await charge(a, 61, 600, t)).toEqual({ ok: true });
    expect(await charge(a, 539, 600, t)).toEqual({ ok: true });
    expect(await charge(a, 1, 600, t)).toEqual({ ok: false, refused: "account" });
  });

  it("owner: no per-account cap, still refused by the global cap (400 as in production)", async () => {
    const t = now() + 40 * DAY;
    const a = randomId(128);
    expect(await charge(a, 399, null, t, 400)).toEqual({ ok: true });
    expect(await charge(a, 1, null, t, 400)).toEqual({ ok: true });
    expect(await charge(a, 1, null, t, 400)).toEqual({ ok: false, refused: "global" });
    expect(await charge(randomId(128), 1, 60, t, 400)).toEqual({ ok: false, refused: "global" });
  });

  it("transcribe(): a Free account at its cap gets no transcript (recording still ready); another Free account does", async () => {
    const full = await seedAccount(false);
    expect(await charge(full.accountId, 60, 60, now())).toEqual({ ok: true });
    const id = await stored(full.accountId, lyingWav(32000));
    await transcribe(env, id, full.accountId, true);
    expect(await transcriptStatus(id)).toBe("unavailable");
    expect(await charged(full.accountId)).toBe(60);

    const other = await seedAccount(false);
    const id2 = await stored(other.accountId, lyingWav(32000));
    await transcribe(env, id2, other.accountId, true);
    expect(await transcriptStatus(id2)).not.toBe("unavailable");
    expect(await charged(other.accountId)).toBe(1);
  });

  it("transcribe(): an owner past 60 minutes is still transcribed", async () => {
    const o = await seedAccount(false);
    const e: Env = withEnv({ OWNER_ACCOUNT_IDS: o.accountId });
    expect(await charge(o.accountId, 600, null, now())).toEqual({ ok: true });
    const id = await stored(o.accountId, lyingWav(32000));
    await transcribe(e, id, o.accountId, true);
    expect(await transcriptStatus(id)).not.toBe("unavailable");
    expect(await charged(o.accountId)).toBe(601);
  });

  it("transcribe(): fails closed when the Governor is unreachable", async () => {
    const a = await seedAccount(false);
    const id = await stored(a.accountId, lyingWav(32000));
    await transcribe(withEnv({ GOVERNOR: brokenGovernor }), id, a.accountId, true);
    expect(await transcriptStatus(id)).toBe("unavailable");
  });
});

describe("taken down: no transcription", () => {
  it("/complete on a suspended account accepts the upload, marks it ready, transcribes nothing and keeps the WAV", async () => {
    const acct = await seedAccount();
    const { ws } = await connectDevice(acct.deviceToken!);
    const r = await mcp("start_recording", { mic: true, max_seconds: 30 }, acct.key);
    expect(r.isError).toBe(false);
    const id: string = r.data.recording_id;
    const auth = { authorization: `Bearer ${await issueUploadToken(env, id, acct.deviceId!, now() + 600)}` };
    const put = (part: string, b: Uint8Array, type: string) =>
      call(`/upload/${id}/${part}`, { method: "PUT", body: b, headers: { ...auth, "content-type": type, "content-length": String(b.length) } });
    expect((await put("video", MP4(), "video/mp4")).status).toBe(200);
    expect((await put("audio", lyingWav(32000), "audio/wav")).status).toBe(200);
    // Suspended mid-recording: the bytes still land (evidence), the transcript doesn't.
    await suspendAccount(acct.accountId);
    expect((await call(`/upload/${id}/complete`, { method: "POST", body: JSON.stringify({ duration_s: 1 }), headers: auth })).status).toBe(200);
    const row = await env.DB.prepare("SELECT status, transcript, transcript_status FROM recordings WHERE id = ?").bind(id).first<any>();
    expect(row).toEqual({ status: "ready", transcript: null, transcript_status: "unavailable" });
    expect(await charged(acct.accountId)).toBe(0);
    expect(await env.MEDIA.head(`a/${id}.wav`)).not.toBeNull();
    expect(await env.MEDIA.head(`v/${id}.mp4`)).not.toBeNull();
    ws.close();
  });

  it("transcribe(): a recording taken down by itself isn't transcribed; another of the account is", async () => {
    const a = await seedAccount(false);
    const id = await stored(a.accountId, lyingWav(32000));
    await env.DB.prepare(
      "INSERT INTO admin_actions (id, action, target_type, target_id, account_id, reason_code, before_state, actor_account_id, created_at) " +
        "VALUES (?, 'takedown', 'recording', ?, ?, 'other', '{}', 'test-operator', ?)",
    )
      .bind(randomId(128), id, a.accountId, now())
      .run();
    await transcribe(env, id, a.accountId, true);
    expect(await transcriptStatus(id)).toBe("unavailable");
    expect(await charged(a.accountId)).toBe(0);
    const id2 = await stored(a.accountId, lyingWav(32000));
    await transcribe(env, id2, a.accountId, true);
    expect(await transcriptStatus(id2)).not.toBe("unavailable");
  });
});
