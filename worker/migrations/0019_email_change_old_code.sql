-- request_email_change (account-tools.ts): a second code goes to the CURRENT address; confirm_email_change needs both.
-- HMAC like code_hash, never the code. Requests from before this migration have none and can't be confirmed.
ALTER TABLE email_change_requests ADD COLUMN old_code_hash TEXT;
