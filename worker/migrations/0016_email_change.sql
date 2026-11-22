-- Sign-in email change from the bot (account-tools.ts request_email_change / confirm_email_change). One pending change
-- per account; a new request replaces it. code_hash = HMAC of the account, the new email and the 6-digit code (never the
-- code itself). attempts: wrong codes so far (5 = locked until a new request). Deleted when used, expired or replaced.
CREATE TABLE email_change_requests (
  account_id TEXT PRIMARY KEY,
  new_email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
