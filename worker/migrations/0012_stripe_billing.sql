-- Recitbot Pro billing through Stripe (stripe.ts). Additive: existing accounts get plan 'free'.
-- plan: 'free' | 'pro' | 'teams' (teams reserved). Owners (OWNER_ACCOUNT_IDS) are unlimited regardless of plan.
-- plan_status: the Stripe subscription status (active, trialing, past_due, canceled, ...); null = never subscribed.
-- current_period_end: unix seconds the paid period ends (renewal date); cancel_at_period_end keeps pro until then.
-- stripe_customer_id: only customers Recitbot created (metadata app=recitbot); billing (the portal) requires one.
ALTER TABLE accounts ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE accounts ADD COLUMN plan_status TEXT;
ALTER TABLE accounts ADD COLUMN current_period_end INTEGER;
ALTER TABLE accounts ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE accounts ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE accounts ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX accounts_stripe_customer ON accounts(stripe_customer_id);

-- Webhook idempotency: one row per processed Stripe event id.
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
