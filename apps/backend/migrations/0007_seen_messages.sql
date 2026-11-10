-- The envelopes each provisioned actor sent or accepted, kept for one inbound
-- window. Same portability rules as 0001: plain types, nothing engine specific.
--
-- From SDK 0.0.11 recognising a replayed or reflected message is the
-- application's job: keep `message_id` of every envelope sent and of every one
-- `process` accepted until `max(sent or received at, its timestamp) + the
-- inbound window`, across restarts, and drop an inbound envelope whose id is
-- kept. The actor checks a copy of these rows in memory; this table is what
-- survives a restart.
--
-- `message_id` is the SHA-256 id as lowercase hex; `expires_at` is Unix
-- seconds, after which the row is pruned.
CREATE TABLE seen_messages (
    actor_id   TEXT NOT NULL,
    message_id TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    PRIMARY KEY (actor_id, message_id)
);
