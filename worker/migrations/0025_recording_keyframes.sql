-- Recording keyframes (recorder 0.6.1, "keyframes"): up to 6 JPEG stills the recorder takes from the uploaded MP4 and
-- PUTs to /upload/<id>/keyframes/<n>?t=<ms> (upload.ts handleKeyframe). The image is R2 k/<id>/<n>.jpg; this row has
-- its slot and time. n: 1..6, may have gaps (a frame the recorder could not grab is left out). t_ms: milliseconds from
-- the start of the MP4. A PUT to a slot that has one replaces it. Deleted with the recording (mcp.ts deleteRecordings).
CREATE TABLE recording_keyframes (
  recording_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  t_ms INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (recording_id, n)
);
