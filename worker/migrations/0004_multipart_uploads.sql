-- Chunked uploads (R2 multipart) for long recordings: one open upload per recording and kind.
-- parts = JSON [{n, etag, size}] in order; part_bytes = size of every non-final part (part 1's size);
-- closed = 1 once a short (final) part arrived. The hourly cron aborts uploads older than 24 h.
CREATE TABLE multipart_uploads (
  recording_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  part_bytes INTEGER NOT NULL DEFAULT 0,
  parts TEXT NOT NULL DEFAULT '[]',
  bytes INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (recording_id, kind)
);
CREATE INDEX multipart_uploads_created ON multipart_uploads(created_at);
