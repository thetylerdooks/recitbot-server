-- Page branding (Pro, Teams, owner): one row per account, set through the set_branding MCP tool (branding.ts).
-- Colours are lowercase #rrggbb; *_hash point at brand_assets rows of the same account. NULL = not set.
CREATE TABLE branding (
  account_id TEXT PRIMARY KEY,
  brand_name TEXT,
  accent TEXT,
  background TEXT,
  logo_hash TEXT,
  favicon_hash TEXT,
  og_hash TEXT,
  updated_at INTEGER NOT NULL
);

-- Uploaded brand images, stored per account in R2 at brand/<account_id>/<hash>.<ext> and served at /b/<hash>.
-- hash = sha256 hex of the bytes. Two accounts uploading identical bytes get a row (and an R2 object) each, so
-- deleting one never touches the other; /b/<hash> serves any account's row since the bytes are identical.
-- Not counted toward recording storage.
CREATE TABLE brand_assets (
  account_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('logo', 'favicon', 'og')),
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, hash)
);
CREATE INDEX brand_assets_account ON brand_assets(account_id);
CREATE INDEX brand_assets_hash ON brand_assets(hash);
