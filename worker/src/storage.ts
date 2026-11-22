// Pro/Teams storage cap: LIMITS.storageBytesPerSeat (100 GB) per paid account (Teams: per seat, each member account has
// its own), plus LIMITS.storageAddonBytes per add-on (accounts.storage_addons, the webhook keeps it in sync with Stripe).
// Usage is the sum of the per-recording sizes stored at upload and finalize (recordings.bytes + audio_bytes, migration
// 0024): no R2 list calls, and deleting a recording (its row) frees its bytes at once. Free (its own 25-video limit) and
// owners have no storage cap.
import { LIMITS, type AccountLimits, type Env } from "./env";
import { heldSql } from "./takedown-state";
import { log } from "./util";

export type StorageStatus = {
  used: number;
  /** Bytes allowed (base + add-ons); null = no storage cap (free, owner). */
  limit: number | null;
  addons: number;
};

/** Bytes the account's recordings take in R2 (MP4s + transcription WAVs not yet deleted). */
export async function storageUsed(env: Env, accountId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT coalesce(sum(bytes + audio_bytes), 0) AS n FROM recordings WHERE account_id = ?")
    .bind(accountId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function storageStatus(env: Env, accountId: string, limits: AccountLimits): Promise<StorageStatus> {
  const [used, row] = await Promise.all([
    storageUsed(env, accountId),
    env.DB.prepare("SELECT storage_addons FROM accounts WHERE id = ?").bind(accountId).first<{ storage_addons: number }>(),
  ]);
  const addons = Math.max(0, row?.storage_addons ?? 0);
  const capped = limits.tier === "pro" || limits.tier === "teams";
  return { used, limit: capped ? LIMITS.storageBytesPerSeat + addons * LIMITS.storageAddonBytes : null, addons };
}

const GB = 1e9;
/** "92.3 GB": decimal GB, rounded down to one decimal (never overstates). */
const gbText = (bytes: number) => `${String(Math.floor((bytes / GB) * 10) / 10)} GB`;

/** start_recording at or over the cap (error storage_limit_reached). */
export const storageLimitMessage = (limit: number) =>
  `You've used your ${Math.round(limit / GB)} GB of Recitbot storage. Delete old videos to free space, or add ` +
  `${LIMITS.storageAddonBytes / GB} GB more for $3/mo: just ask me to add storage.`;

/** Relayed by the bot at LIMITS.storageWarnShare (90%) or more of the cap. */
export const storageWarningMessage = (used: number, limit: number) =>
  `You've used ${gbText(used)} of your ${Math.round(limit / GB)} GB of Recitbot storage.`;

export const atStorageLimit = (s: StorageStatus) => s.limit !== null && s.used >= s.limit;

/** The warning for start_recording / account_info, or null below 90% (or with no cap). */
export const storageWarning = (s: StorageStatus): string | null =>
  s.limit !== null && s.used >= s.limit * LIMITS.storageWarnShare ? storageWarningMessage(s.used, s.limit) : null;

/** storage_warning (the bot relays it to the user) at 90% or more of the cap; nothing below. */
export const withStorageWarning = (s: StorageStatus) => {
  const w = storageWarning(s);
  return w ? { storage_warning: w } : {};
};

/** Rows checked per cron run (each costs up to two R2 heads and one delete). */
const RECONCILE_BATCH = 150;

/**
 * Hourly: measures recordings whose sizes were only estimated (sizes_checked = 0, the rows that existed at migration
 * 0024). Heads v/<id>.mp4 and a/<id>.wav, deletes a WAV whose transcription already succeeded (ready or silent: the
 * same rule as new recordings; never of a held recording, takedown-state.ts), stores the real sizes and marks the row checked. A row that fails stays unchecked and
 * is tried again next hour.
 */
export async function reconcileStorage(env: Env, batch = RECONCILE_BATCH): Promise<{ checked: number; wavs_deleted: number }> {
  const rows = await env.DB.prepare(
    `SELECT r.id, r.has_audio, r.transcript_status, ${heldSql("r.id", "r.account_id")} AS held FROM recordings r WHERE r.sizes_checked = 0 LIMIT ?`,
  )
    .bind(batch)
    .all<{ id: string; has_audio: number; transcript_status: string; held: number }>();
  let checked = 0;
  let wavsDeleted = 0;
  for (const r of rows.results) {
    try {
      const video = await env.MEDIA.head(`v/${r.id}.mp4`);
      const wav = r.has_audio === 1 ? await env.MEDIA.head(`a/${r.id}.wav`) : null;
      let audioBytes = wav?.size ?? 0;
      // A held recording (takedown-state.ts) keeps every file.
      if (wav && transcriptDone(r.transcript_status) && !r.held) {
        await env.MEDIA.delete(`a/${r.id}.wav`);
        audioBytes = 0;
        wavsDeleted++;
      }
      await env.DB.prepare("UPDATE recordings SET bytes = ?, audio_bytes = ?, sizes_checked = 1 WHERE id = ?")
        .bind(video?.size ?? 0, audioBytes, r.id)
        .run();
      checked++;
    } catch (e) {
      log("warn", "storage reconcile failed", { id: r.id, err: String(e) });
    }
  }
  return { checked, wavs_deleted: wavsDeleted };
}

/** Transcription finished for good: a transcript, or audio found silent. The WAV is no longer needed. */
export const transcriptDone = (status: string) => status === "ready" || status === "silent";
