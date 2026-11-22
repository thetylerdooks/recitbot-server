-- Agent Recorder schema. IDs are 128-bit random base62. Secrets are stored only as SHA-256 hashes.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT,
  bot_name TEXT,
  created_at INTEGER NOT NULL,
  paired_at INTEGER
);

-- API key format: ark_<id>_<secret>. `id` is a public lookup prefix; only the hash of the full key is stored.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX api_keys_account ON api_keys(account_id);

-- Device token format: ardt_<device id>_<secret>. Only the hash is stored.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX devices_account ON devices(account_id);

CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL,
  max_seconds INTEGER NOT NULL,
  mic INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  duration_s REAL,
  bytes INTEGER NOT NULL DEFAULT 0,
  has_audio INTEGER NOT NULL DEFAULT 0,
  transcript_status TEXT NOT NULL DEFAULT 'none',
  transcript TEXT,
  error TEXT
);
CREATE INDEX recordings_account ON recordings(account_id, created_at);
CREATE INDEX recordings_created ON recordings(created_at);

CREATE TABLE shares (
  recording_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  passcode_hash TEXT,
  passcode_salt TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER
);
