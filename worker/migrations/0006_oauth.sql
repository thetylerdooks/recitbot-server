-- OAuth 2.1 authorization server for the MCP endpoint, with magic-link sign-in. Secrets are stored only as SHA-256 hashes.

-- Dynamically registered clients (RFC 7591). redirect_uris / grant_types are JSON arrays. Never-used clients are ignored
-- after 7 days.
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  grant_types TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- Client ID Metadata Documents (client_id = https URL), cached for up to an hour.
CREATE TABLE oauth_cimd_cache (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- Emails proven by a magic link or code, and the account they sign in to. Accounts are only ever matched by email here,
-- never by accounts.email (which signup accepted unverified).
CREATE TABLE oauth_identities (
  email TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- One browser sign-in in progress (10 min, renewed at each step). cookie_hash binds it to the browser that started it
-- (the form CSRF token is derived from that cookie). magic_hash / code_hash are the emailed link and 6-digit code (the
-- code is hashed together with the id). kind 'oauth' = /oauth/authorize (the client_id .. issuer columns are set);
-- kind 'web' = /signin, which ends in a web session and a redirect to next (a same-origin path). via_session = signed in
-- with an existing web session instead of an email.
CREATE TABLE oauth_pending (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  cookie_hash TEXT NOT NULL,
  client_id TEXT,
  client_name TEXT,
  redirect_uri TEXT,
  state TEXT,
  code_challenge TEXT,
  resource TEXT,
  scope TEXT,
  issuer TEXT,
  next TEXT,
  email TEXT,
  magic_hash TEXT,
  code_hash TEXT,
  code_attempts INTEGER NOT NULL DEFAULT 0,
  magic_expires_at INTEGER,
  verified_at INTEGER,
  via_session INTEGER NOT NULL DEFAULT 0,
  account_id TEXT,
  done_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_pending_magic ON oauth_pending(magic_hash);
CREATE INDEX oauth_pending_expires ON oauth_pending(expires_at);

-- Authorization codes: single use, 60 s. family_id = the token family issued from it (revoked if the code is replayed).
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  account_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  family_id TEXT
);

-- Access (rbat_<id>_<secret>) and refresh (rbrt_<id>_<secret>) tokens. aud = the resource URI the token is bound to.
-- A refresh token is rotated on use; replaying a used one revokes its whole family.
CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  family_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  aud TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX oauth_tokens_family ON oauth_tokens(family_id);
CREATE INDEX oauth_tokens_expires ON oauth_tokens(expires_at);

-- Browser sign-in sessions (cookie __Host-rb_session). Only the SHA-256 of the cookie token is stored. expires_at is the
-- absolute end of the sign-in (30 days, kept across rotations); a session idle for 7 days (last_seen_at) is dead too.
-- A rotated token gets revoked_at = rotation time + 60 s, so requests already in flight with it still pass.
CREATE TABLE web_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  rotated_from TEXT,
  revoked_at INTEGER
);
CREATE INDEX web_sessions_account ON web_sessions(account_id);
CREATE INDEX web_sessions_expires ON web_sessions(expires_at);
