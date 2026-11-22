-- Owner plan as a DB flag: accounts.plan = 'owner' is a permanent free admin plan (env.ts accountPlan / tierLimits:
-- every paid feature, no watermark, unlimited devices, kept until deleted). Stripe never sets or overwrites it (stripe.ts).
-- No account is named here: owners come from OWNER_ACCOUNT_IDS (SELFHOST_CONFIG.md), or from an operator setting the flag.
-- Recordings an owner made before the flag (7-day expiry) are kept until deleted too (share.ts KEEP_FOREVER, 9999-12-31).
-- Idempotent.
UPDATE recordings SET expires_at = 253402300799
WHERE expires_at <> 253402300799
  AND account_id IN (SELECT id FROM accounts WHERE plan = 'owner');
