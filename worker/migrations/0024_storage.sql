-- Pro/Teams storage cap (storage.ts): an account's stored bytes = sum over its recordings of bytes (the MP4, v/<id>.mp4)
-- + audio_bytes (the transcription WAV, a/<id>.wav, while it exists; it is deleted once transcription succeeds). Both
-- are set at upload and finalize, never from an R2 list. Deleting a recording deletes its row, which frees its bytes.
ALTER TABLE recordings ADD COLUMN audio_bytes INTEGER NOT NULL DEFAULT 0;

-- 1 = bytes / audio_bytes match R2. Rows written from here on are exact (default 1). Rows that exist now are only
-- estimated below and set to 0: the hourly cron (storage.ts reconcileStorage) heads their objects in R2, writes the real
-- sizes, deletes the WAVs whose transcription already succeeded, and sets 1.
ALTER TABLE recordings ADD COLUMN sizes_checked INTEGER NOT NULL DEFAULT 1;
CREATE INDEX recordings_sizes_unchecked ON recordings(sizes_checked) WHERE sizes_checked = 0;

-- Storage add-ons (+100 GB each, $3/mo): quantity of the STRIPE_STORAGE_ADDON_PRICE_ID item on the account's Recitbot
-- subscription, as Stripe has it (set by the webhook only, stripe.ts). 0 = none.
ALTER TABLE accounts ADD COLUMN storage_addons INTEGER NOT NULL DEFAULT 0;

-- add_storage Checkout Sessions already applied to a subscription (one add-on each, never twice: webhook retries and
-- replays find the row). Kept, not pruned: one small row per purchase.
CREATE TABLE storage_addon_sessions (
  session_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Backfill. recordings.bytes already holds the MP4 size for every recording that finished uploading (set at
-- /upload/<id>/complete since 0001); rows that never finished have 0 there and are measured by the cron. WAV sizes were
-- never stored: estimate them from the recording length (16 kHz mono PCM16 = 32000 bytes/s, plus the 44-byte header)
-- until the cron replaces the estimate with the real size (or 0 once the WAV is deleted).
UPDATE recordings SET
  audio_bytes = CASE WHEN has_audio = 1 THEN CAST(coalesce(duration_s, max_seconds) * 32000 AS INTEGER) + 44 ELSE 0 END,
  sizes_checked = 0;
