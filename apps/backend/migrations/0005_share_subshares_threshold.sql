-- SDK 0.0.9 records, on each share the owner side stores, how many Shamir
-- subshares it carries and the threshold its version was split with. Both are
-- owner-side only (NULL on a helper's stored share) and NULL on every row
-- written before this migration: the library never backfills them, and NULL
-- means "not recorded", which is not 0.
--
-- The user-secret snapshot's threshold lives in the `user_secrets.payload`
-- JSON, so it needs no column.
ALTER TABLE shares ADD COLUMN subshares INTEGER;
ALTER TABLE shares ADD COLUMN threshold INTEGER;
