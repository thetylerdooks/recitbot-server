-- What an uninstall asked the recorder to remove, kept for a device that was offline: 'account' (only this account's
-- pairing; the install stays for its other accounts) or 'all' (Recitbot completely). The recorder gets it with its
-- 410 device_revoked. Rows from before scopes were full removals: 'all'.
ALTER TABLE revoked_device_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('account', 'all'));
