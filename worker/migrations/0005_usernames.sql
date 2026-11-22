-- One link per video: https://example.com/<username>/v/<slug>, private until shared.
-- username: lowercase [a-z0-9-], 3-30 chars, unique (rules and reserved words in src/username.ts). Existing accounts get
-- one on first use (assignUsername), derived from the email local part or bot name.
-- display_name: optional, shown as "Recorded by <display_name>" on the page (falls back to the username).
ALTER TABLE accounts ADD COLUMN username TEXT;
ALTER TABLE accounts ADD COLUMN display_name TEXT;
CREATE UNIQUE INDEX accounts_username ON accounts(username);

-- slug: random and unguessable, the only id in the video's URL. revoke_share replaces it, so the old URL dies at once.
-- shared_at: NULL = private (only the signed-in owner can open it), set = public to anyone with the URL.
ALTER TABLE recordings ADD COLUMN slug TEXT;
ALTER TABLE recordings ADD COLUMN shared_at INTEGER;
UPDATE recordings SET slug = lower(hex(randomblob(10))) WHERE slug IS NULL;
-- Recordings whose link was already handed out (they have a shares row) stay viewable through it: their old /v/<id>
-- links now 301 to the new URL. Everything recorded from now on starts private.
UPDATE recordings SET shared_at = CAST(strftime('%s', 'now') AS INTEGER) WHERE id IN (SELECT recording_id FROM shares);
CREATE UNIQUE INDEX recordings_slug ON recordings(slug);
