-- Operator pause of the Free auto-delete for one account (worker/src/retention-hold.ts; tool admin_retention_hold):
-- 1 = its recordings never count as past their expires_at (the hourly cleanup skips them, they stay watchable),
-- 0 = the default. recordings.expires_at is never changed by it, so clearing the hold resumes the stored expiry.
-- Not a takedown hold (admin_actions, 0031).
ALTER TABLE accounts ADD COLUMN retention_hold INTEGER NOT NULL DEFAULT 0;
