-- Device tokens of uninstalled devices (uninstall_recorder). The device row is deleted; its token hash stays here so the
-- recorder gets 410 device_revoked (instead of 401) and removes itself the next time it connects. 0012 is left free.
CREATE TABLE revoked_device_tokens (
  token_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  revoked_at INTEGER NOT NULL
);
