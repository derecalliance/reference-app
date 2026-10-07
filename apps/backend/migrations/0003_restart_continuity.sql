-- Two things a restart used to forget, both needed to keep a node reachable
-- across one. Same portability rules as 0001: plain types, nothing engine
-- specific. `ALTER TABLE … ADD COLUMN … NOT NULL DEFAULT` is spelled the same
-- on SQLite and Postgres.

-- Every address this node has advertised to peers, so a message still sent to
-- an old one is recognised as meant for this node and delivered locally rather
-- than dialled. A Docker republish on another port is the case that needs it:
-- the old public port is gone, but a peer paired before the move — a browser
-- tab above all — still holds it.
--
-- `kind` is the listener the address belongs to: `http` rows are a base URL
-- (`http://host:port`), `grpc` rows an authority (`host:port`). Only ever
-- added to; an address stays recognisable for as long as the database lives.
CREATE TABLE advertised_addresses (
    kind    TEXT NOT NULL CHECK (kind IN ('http', 'grpc')),
    address TEXT NOT NULL,
    PRIMARY KEY (kind, address)
);

-- When each secret row was written, in Unix seconds. A minted contact lives
-- only here until its peer's first message arrives, so this is what lets a
-- restart restore the routes for contacts still inside their lifetime and
-- leave expired ones alone. Rows written before this column existed read as 0
-- — older than any lifetime — which is the honest answer for them.
ALTER TABLE secrets ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
