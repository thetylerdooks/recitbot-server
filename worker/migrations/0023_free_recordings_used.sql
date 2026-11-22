-- Free plan: recordings the account has started while on Free, in its whole lifetime (LIMITS.freeRecordings = 25).
-- Taken at a successful start_recording, handed back only when the start fails; never reset, and deleting a recording
-- never gives one back (recordings rows are hard-deleted, so the count can't be derived from them). Pro, Teams and
-- owner starts don't count.
ALTER TABLE accounts ADD COLUMN free_recordings_used INTEGER NOT NULL DEFAULT 0;

-- Backfill from the recordings that still exist. Deleted and expired recordings leave no row anywhere, so they can't
-- be counted. A row was started on Free when its expiry is at most 7 days after its start (Free retention, or the
-- older 24 h); Pro-era rows are KEEP_FOREVER, or got a later expiry when the account went back to Free. Starts handed
-- back (failed before reaching the PC: DEVICE_OFFLINE) don't count. Owner-plan accounts never use the count.
UPDATE accounts SET free_recordings_used = (
  SELECT count(*) FROM recordings r
  WHERE r.account_id = accounts.id
    AND r.expires_at <= r.created_at + 604800
    AND NOT (r.status = 'failed' AND r.error IS 'DEVICE_OFFLINE')
)
WHERE plan <> 'owner';
