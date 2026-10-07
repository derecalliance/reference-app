-- How each sharing round this instance ran as Owner ended. Same portability
-- rules as 0001: plain types, nothing engine specific.
--
-- The SDK asks the share store which versions helpers should keep
-- (`DeRecShareStore::keep_list`), and helpers delete every version not listed.
-- Only the application can answer, because only it sees `SharingComplete` —
-- the store records no outcome of its own. This table is that record: one row
-- per round this instance distributed, written when the round settled.
--
-- `committed` is 1 when the round met threshold, 0 when it settled short of
-- it. A version with no row was never distributed by this instance — mirrored
-- from another replica member, or restored by recovery — and its outcome is
-- unknown here, which `keep_list` treats as "keep everything".
CREATE TABLE sharing_rounds (
    actor_id  TEXT NOT NULL,
    secret_id TEXT NOT NULL,
    version   INTEGER NOT NULL,
    committed INTEGER NOT NULL CHECK (committed IN (0, 1)),
    PRIMARY KEY (actor_id, secret_id, version)
);
