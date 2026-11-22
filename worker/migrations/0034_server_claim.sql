-- The one-time owner claim (worker/src/oauth/claim.ts): the single row (id 1) means this server was claimed, when, and by
-- which account. Written once, in the same transaction that creates that account, and never removed by the Worker: with
-- the row present no claim can succeed again. While OWNER_ACCOUNT_IDS is empty, account_id is the operator.
CREATE TABLE IF NOT EXISTS server_claim (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  account_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);
