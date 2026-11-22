-- The platform get_installer was asked for ("windows", "macos"); enroll copies it onto the device it pairs. null = windows.
ALTER TABLE pairing_codes ADD COLUMN platform TEXT;
