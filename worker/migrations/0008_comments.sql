-- Viewer comments on shared videos (src/comments.ts). They exist only while the video is shared: deleting the video
-- (delete_recording, the 24 h free-tier cleanup) and revoke_share hard-delete its rows.
-- author_kind: 'viewer' (anyone with the shared link, under display_name) or 'owner' (the signed-in owner; shown under
-- their live Recitbot name, display_name is only a snapshot).
-- t_seconds: optional point in the video the comment is pinned to.
-- viewer_token_hash / ip_hash: HMAC(IP_HASH_KEY, ...) of the viewer cookie and IP, for rate limits, duplicates and the
-- viewer's own 10-minute delete. Never the raw values. NULL on owner comments.
-- deleted_at: set when deleted (body cleared); the row stays so it still counts toward the rate limits.
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('viewer', 'owner')),
  display_name TEXT NOT NULL,
  body TEXT NOT NULL,
  t_seconds REAL,
  created_at INTEGER NOT NULL,
  viewer_token_hash TEXT,
  ip_hash TEXT,
  deleted_at INTEGER
);
CREATE INDEX comments_video ON comments(video_id, created_at);
CREATE INDEX comments_viewer ON comments(viewer_token_hash, created_at);
CREATE INDEX comments_ip ON comments(ip_hash, created_at);
