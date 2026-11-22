// The per-account retention hold (accounts.retention_hold, migration 0032): an operator's reversible pause of the Free
// auto-delete and 7-day expiry. While it is 1 the account's recordings never count as past their expires_at: the hourly
// cleanup skips them and they stay watchable, listed, downloadable and shareable. recordings.expires_at itself is never
// changed (new Free recordings still get +7 days), so once the hold is cleared the stored expiry applies again.
// Every expiry check of a RECORDING goes through here; tokens, codes and sessions have their own expires_at and don't.
// Nothing to do with takedown holds (takedown-state.ts heldSql): the account's owner can still delete a video.
// Import-light on purpose. The tool is in admin-retention-tools.ts.

/** SQL: the account (id expression `acct`: a column name, never a value) is on retention hold. */
export const retentionHoldSql = (acct: string) => `EXISTS (SELECT 1 FROM accounts rh WHERE rh.id = ${acct} AND rh.retention_hold = 1)`;

/** SQL column for recordingExpired: 1 while the recording's account (`acct` as above) is on retention hold, else 0. */
export const retentionHoldCol = (acct = "recordings.account_id") => `${retentionHoldSql(acct)} AS retention_hold`;

/** SQL: a row of `recordings` is not expired at the time bound as parameter `t`. */
export const unexpiredSql = (t = "?") => `(recordings.expires_at > ${t} OR ${retentionHoldSql("recordings.account_id")})`;

/** The recording is past its expires_at and its account is not on retention hold. */
export const recordingExpired = (rec: { expires_at: number; retention_hold: number }, t: number): boolean =>
  rec.expires_at < t && !rec.retention_hold;
