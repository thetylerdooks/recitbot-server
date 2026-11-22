-- upgrade (billing-tools.ts): the account's last Checkout Session and when it was created. A second upgrade within 24 h
-- reuses it while Stripe still has it open, instead of creating another.
ALTER TABLE accounts ADD COLUMN checkout_session_id TEXT;
ALTER TABLE accounts ADD COLUMN checkout_session_created_at INTEGER;
