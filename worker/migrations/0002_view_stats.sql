-- View stats (additive only). Totals are counters on the recording row; one video_views row per counted view.
-- A view is counted when the player page's script sends its first beacon (POST /v/:id/b), never for link-preview bots,
-- HEAD requests, media (Range) requests or the owner. No raw IP or user agent is stored anywhere.
ALTER TABLE recordings ADD COLUMN views INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recordings ADD COLUMN unique_views INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recordings ADD COLUMN previews INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recordings ADD COLUMN last_viewed_at INTEGER;

-- HMAC(IP_HASH_KEY, ip) of the paired PC's last connection: views from that address are the owner's.
ALTER TABLE devices ADD COLUMN ip_hash TEXT;

-- id = random view id signed into the player page. viewer_hash = HMAC(IP_HASH_KEY, daily salt + recording + IP + UA),
-- truncated. max_pct = furthest point reached in the video (0-100).
CREATE TABLE video_views (
  id TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL,
  viewer_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  max_pct INTEGER NOT NULL DEFAULT 0
);
-- One index serves unique-viewer dedupe, per-video stats and deletion.
CREATE INDEX video_views_recording ON video_views(recording_id, viewer_hash);

-- Random per-UTC-day salt for viewer hashes. The cron deletes old days, after which hashes can't be linked to an IP.
CREATE TABLE view_salts (
  day INTEGER PRIMARY KEY,
  salt TEXT NOT NULL
);
