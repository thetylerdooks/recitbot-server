-- Custom domain takedown log (worker/src/domain-takedown.ts): one row per disable / enable / purge of a custom hostname,
-- by an operator (admin MCP tools) or an automated owner tool. Append-only: no code path updates or deletes these rows,
-- including retire, the cron, purge and deleting the custom_domains row itself (no foreign key, on purpose).
-- reason_code: csam | phishing | malware | impersonation | other (disable and purge carry the domain's code; enable null).
-- note: operator free text, length-capped, never shown to visitors. evidence: JSON text supplied by the caller, or null.
CREATE TABLE custom_domain_actions (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  account_id TEXT,
  action TEXT NOT NULL,
  reason_code TEXT,
  note TEXT,
  actor_account_id TEXT NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX custom_domain_actions_hostname ON custom_domain_actions (hostname, created_at);
CREATE INDEX custom_domain_actions_created ON custom_domain_actions (created_at);
