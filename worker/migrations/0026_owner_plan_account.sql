-- Deliberately changes nothing: no account is named in a migration (owners: OWNER_ACCOUNT_IDS, SELFHOST_CONFIG.md). Kept
-- because D1 tracks applied migrations by file name.
UPDATE accounts SET plan = 'owner' WHERE 0;
