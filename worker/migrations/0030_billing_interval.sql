-- How the account's plan subscription bills: 'monthly' or 'yearly' (set by the Stripe webhook from the plan item's
-- price, stripe.ts planPrice); NULL = no paid subscription. Same plan either way. Yearly prices are new: every
-- subscription before this migration is monthly.
ALTER TABLE accounts ADD COLUMN billing_interval TEXT;
UPDATE accounts SET billing_interval = 'monthly' WHERE plan IN ('pro', 'teams') AND stripe_subscription_id IS NOT NULL;
