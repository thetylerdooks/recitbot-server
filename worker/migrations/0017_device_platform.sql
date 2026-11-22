-- Every device has a platform. Rows without one were paired by recorders that did not report it, all Windows PCs; pairing
-- now records "windows" when the request has none. A token-less re-pair only replaces a device of the same platform.
-- 0012, 0014, 0015 and 0016 are taken on other branches.
UPDATE devices SET platform = 'windows' WHERE platform IS NULL;
-- Why a device was revoked: replaced_by_repair (a re-pair of the same PC took its place) or user_revoked (remove_device);
-- null while active, and for devices revoked before this migration.
ALTER TABLE devices ADD COLUMN revoke_reason TEXT;
-- Uninstalled devices lose their row: keep whose they were and what they were called, so device_status can report them.
ALTER TABLE revoked_device_tokens ADD COLUMN account_id TEXT;
ALTER TABLE revoked_device_tokens ADD COLUMN name TEXT;
ALTER TABLE revoked_device_tokens ADD COLUMN platform TEXT;
CREATE INDEX revoked_device_tokens_account ON revoked_device_tokens(account_id);
