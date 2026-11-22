-- platform_reported: 1 = the recorder itself reported devices.platform when it paired; null = the platform was inferred
-- (the pairing code's, or 0017's backfill of null rows to 'windows', which also caught Macs paired by recorders that
-- sent none). Additive: no existing row is changed. A backfilled Mac and a real Windows PC both read 'windows' and cannot
-- be told apart here; an inferred platform is corrected when that recorder re-pairs with its device token and reports
-- its own platform (the device row is reused, not duplicated).
ALTER TABLE devices ADD COLUMN platform_reported INTEGER;
