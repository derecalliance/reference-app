-- `actors.seq` is registration order, assigned as MAX(seq) + 1 inside the
-- inserting transaction (AUTOINCREMENT and SERIAL are both unavailable under
-- the portability rule in 0001). On SQLite `BEGIN IMMEDIATE` serialises
-- writers, so two inserts cannot read the same maximum. On Postgres two
-- concurrent READ COMMITTED transactions can, and the roster would then hold
-- two actors at one position and render them in an arbitrary order.
--
-- The registry also serialises inserts within one process; this index is what
-- makes a collision that slips past it — another process on the same database
-- — a refused insert instead of a silent duplicate. It replaces the plain
-- index from 0001, which it makes redundant.
--
-- Plain CREATE/DROP INDEX: spelled the same on both engines.
DROP INDEX actors_by_seq;
CREATE UNIQUE INDEX actors_by_seq_unique ON actors (seq);
