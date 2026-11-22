-- Recorder 0.4: system audio, auto-open of the share link.
-- system_audio = requested at start (after the recorder's capability check); has_system_audio = the upload contained it.
ALTER TABLE recordings ADD COLUMN system_audio INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recordings ADD COLUMN has_system_audio INTEGER NOT NULL DEFAULT 0;
-- open_link = 0 for a one-off start_recording(open_link:false). ready_pushed_at = when the signed "ready" push went to
-- the recorder (set once, before sending, so a recording is never pushed twice).
ALTER TABLE recordings ADD COLUMN open_link INTEGER NOT NULL DEFAULT 1;
ALTER TABLE recordings ADD COLUMN ready_pushed_at INTEGER;
