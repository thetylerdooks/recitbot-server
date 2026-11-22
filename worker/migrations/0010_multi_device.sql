-- Several paired devices per account (Free: up to 2 at once, owners unlimited). Pairing no longer revokes the account's
-- other devices. Additive: no existing row is changed.
-- last_seen_at: last connect or disconnect of the device's WebSocket (null = never connected since this migration).
-- platform: what the recorder said it runs on at enroll ("windows", "macos"); null = not reported (older recorders).
ALTER TABLE devices ADD COLUMN last_seen_at INTEGER;
ALTER TABLE devices ADD COLUMN platform TEXT;
-- The device a pairing code enrolled: lets one batch consume the code and insert that device atomically.
ALTER TABLE pairing_codes ADD COLUMN device_id TEXT;
