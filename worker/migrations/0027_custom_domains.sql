-- Custom video domains (Pro / Teams / owner): one live hostname per account, e.g. videos.example.com.
-- Shared by the host gate, the domain tools and the billing downgrade: change them together.
-- hostname: lowercase ASCII (IDN as punycode), no trailing dot. cf_id: Cloudflare for SaaS custom hostname id.
-- status: 'pending' (created, waiting for the CNAME / certificate), 'active' (Cloudflare hostname + SSL active),
--         'redirecting' (replaced or removed: 301 to redirect_to until redirect_until, then deleted by the cron),
--         'failed' (Cloudflare refused it or it stayed pending 7 days; the cron deletes it).
-- cf_status / ssl_status: Cloudflare's own result.status / result.ssl.status, as last seen.
-- verification_errors: JSON array of strings from Cloudflare (ssl.validation_errors + verification_errors), or null.
-- redirect_to: host to 301 to while redirecting (our own canonical host = back to the normal <canonical host>/<user>/v/<slug>).
-- disabled_at / disabled_reason: admin takedown; the host then answers 451 on every path.
CREATE TABLE custom_domains (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  cf_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  cf_status TEXT,
  ssl_status TEXT,
  verification_errors TEXT,
  redirect_to TEXT,
  redirect_until INTEGER,
  disabled_at INTEGER,
  disabled_reason TEXT,
  live_at INTEGER,
  checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX custom_domains_hostname ON custom_domains (hostname);
-- One pending-or-active hostname per account (redirecting rows don't count).
CREATE UNIQUE INDEX custom_domains_account_live ON custom_domains (account_id) WHERE status IN ('pending', 'active');
CREATE INDEX custom_domains_status ON custom_domains (status, updated_at);
