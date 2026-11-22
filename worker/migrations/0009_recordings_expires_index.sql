-- The hourly cleanup deletes recordings by their own stored expires_at (free tier: 24 h for older rows, 7 days for
-- new ones; owner tier never). Additive: no existing row is changed.
CREATE INDEX recordings_expires ON recordings(expires_at);
