-- One mailbox, one account: the canonical form of each sign-in email (lowercase, no +tag, Gmail without dots in the local
-- part, googlemail.com = gmail.com; canonicalEmail in oauth/accounts.ts) is unique. oauth_identities.email stays the
-- address as typed, which is where mail goes. Backfill: when existing rows share a canonical form, only the oldest gets
-- it; the later ones stay NULL (never merged or deleted) and still sign in by their exact address.
ALTER TABLE oauth_identities ADD COLUMN email_canonical TEXT;
WITH s AS (
  SELECT email, created_at, substr(lower(email), 1, instr(email, '@') - 1) AS l, substr(lower(email), instr(email, '@') + 1) AS d
  FROM oauth_identities WHERE instr(email, '@') > 0
), t AS (
  SELECT email, created_at, CASE WHEN instr(l, '+') > 1 THEN substr(l, 1, instr(l, '+') - 1) ELSE l END AS l,
    CASE WHEN d = 'googlemail.com' THEN 'gmail.com' ELSE d END AS d
  FROM s
), c AS (
  SELECT email, created_at, CASE WHEN d = 'gmail.com' THEN replace(l, '.', '') ELSE l END || '@' || d AS canon FROM t
)
UPDATE oauth_identities SET email_canonical = (SELECT canon FROM c WHERE c.email = oauth_identities.email)
WHERE NOT EXISTS (
  SELECT 1 FROM c a JOIN c b ON b.canon = a.canon
  WHERE a.email = oauth_identities.email AND (b.created_at < a.created_at OR (b.created_at = a.created_at AND b.email < a.email))
);
CREATE UNIQUE INDEX oauth_identities_email_canonical ON oauth_identities(email_canonical);
