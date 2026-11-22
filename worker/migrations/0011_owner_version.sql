-- Owner links (owner-link.ts): owner tokens and per-recording owner cookies carry the recording's owner_version; any
-- mismatch = not the owner. revoke_share (and share with rotate=true) bumps it, so old owner links and the owner cookies
-- they set stop working at once. Additive: existing rows get 0.
ALTER TABLE recordings ADD COLUMN owner_version INTEGER NOT NULL DEFAULT 0;
