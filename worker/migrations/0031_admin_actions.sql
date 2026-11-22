-- Operator takedown evidence log (worker/src/takedown.ts; tools admin_takedown, admin_restore, admin_actions). One row per
-- takedown of a recording, an account or a custom hostname, and one per restore. It is also the takedown state itself:
-- a recording is removed and an account suspended while an un-reversed 'takedown' row targets it (no state columns to
-- drift), and a 'csam' takedown keeps its recordings' files held for good (never deleted, even after a restore).
-- Append-only, enforced by the triggers below: no DELETE, and the only UPDATE sets reversed_at and reversed_by once
-- (NULL -> value) on a 'takedown' row. Hostname takedowns also go through domain-takedown.ts (custom_domain_actions,
-- 0029, linked by domain_action_id); that table stays the domain's own log.
-- action: 'takedown' | 'restore'. target_type: 'recording' | 'account' | 'hostname'. target_id: recordings.id,
-- accounts.id or custom_domains.hostname. account_id: the account the target belongs to (null if none).
-- reason_code: csam | phishing | malware | impersonation | other (a restore carries its takedown's code).
-- note: operator free text, length-capped, never shown to users or viewers. before_state: JSON snapshot of the target
-- when the row was written (no keys, tokens, signed URLs or transcripts). restores: the takedown a restore row reverses.
-- actor_account_id: the operator (OWNER_ACCOUNT_IDS) who did it.
-- IF NOT EXISTS throughout: this was 0030_admin_actions before 0030 went to billing_interval, so a database that ever
-- applied the old file already has these objects; re-running here is then a no-op instead of "already exists".
CREATE TABLE IF NOT EXISTS admin_actions (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('takedown', 'restore')),
  target_type TEXT NOT NULL CHECK (target_type IN ('recording', 'account', 'hostname')),
  target_id TEXT NOT NULL,
  account_id TEXT,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('csam', 'phishing', 'malware', 'impersonation', 'other')),
  note TEXT,
  before_state TEXT NOT NULL,
  actor_account_id TEXT NOT NULL,
  domain_action_id TEXT,
  restores TEXT,
  created_at INTEGER NOT NULL,
  reversed_at INTEGER,
  reversed_by TEXT
);
CREATE INDEX IF NOT EXISTS admin_actions_target ON admin_actions (target_type, target_id, action, reversed_at);
CREATE INDEX IF NOT EXISTS admin_actions_account ON admin_actions (account_id, created_at);
CREATE INDEX IF NOT EXISTS admin_actions_created ON admin_actions (created_at);

-- INSERT OR REPLACE on an existing id would delete the old row without firing the delete trigger.
CREATE TRIGGER IF NOT EXISTS admin_actions_no_replace BEFORE INSERT ON admin_actions
WHEN EXISTS (SELECT 1 FROM admin_actions WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'admin_actions is append-only');
END;

CREATE TRIGGER IF NOT EXISTS admin_actions_no_delete BEFORE DELETE ON admin_actions
BEGIN
  SELECT RAISE(ABORT, 'admin_actions is append-only');
END;

CREATE TRIGGER IF NOT EXISTS admin_actions_reverse_only BEFORE UPDATE ON admin_actions
WHEN OLD.action <> 'takedown'
  OR OLD.reversed_at IS NOT NULL
  OR OLD.reversed_by IS NOT NULL
  OR NEW.reversed_at IS NULL
  OR NEW.reversed_by IS NULL
  OR NEW.id IS NOT OLD.id
  OR NEW.action IS NOT OLD.action
  OR NEW.target_type IS NOT OLD.target_type
  OR NEW.target_id IS NOT OLD.target_id
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.reason_code IS NOT OLD.reason_code
  OR NEW.note IS NOT OLD.note
  OR NEW.before_state IS NOT OLD.before_state
  OR NEW.actor_account_id IS NOT OLD.actor_account_id
  OR NEW.domain_action_id IS NOT OLD.domain_action_id
  OR NEW.restores IS NOT OLD.restores
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'admin_actions is append-only');
END;
