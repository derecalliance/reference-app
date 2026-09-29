-- The whole schema, in one migration that must run unmodified on SQLite and
-- Postgres. That rules out AUTOINCREMENT, SERIAL, backticks, BLOB, and any
-- type either engine lacks.
--
-- Every u64 id -- secret_id, channel_id, replica_id -- is decimal-encoded TEXT.
-- SQLite has no unsigned 64-bit integer and Postgres has no u64; an i64
-- bit-cast makes ordering wrong at the high end and stays invisible until it
-- bites. The HTTP layer already made this call: Actor::secret_id serialises as
-- a string because u64 exceeds JavaScript's exact integer range.
--
-- Binary is base64 TEXT rather than a portable blob type.
--
-- No table distinguishes a provisioned actor from a real one. Being a
-- provisioned fixture is node configuration and must never reach a row.
--
-- The schema is shared, not owned: node separation is ahead on the roadmap, so
-- no table may assume a single process holds all of them.
--
-- ── Why every store table is keyed by (actor_id, secret_id) ─────────────────
--
-- `secret_id` alone is NOT a sufficient partition. An actor runs its own
-- protocol instance plus one *replica* instance per owner it mirrors, and a
-- replica instance is bound to the mirrored owner's secret — so two different
-- actors can hold instances carrying the same `secret_id`. Two helpers acting
-- as replicas for one owner is the ordinary case, not a corner.
--
-- While every instance owned a private in-memory map, those were isolated by
-- being separate objects. Sharing one database removes that accident, and
-- listing methods are where it bites first: `helpers(secret_id, ..)` and
-- `latest_version(secret_id)` return every row for the secret regardless of
-- which instance wrote it, so two instances silently see each other's
-- channels and versions.
--
-- `actor_id` supplies the missing dimension: (actor_id, secret_id) identifies
-- an instance exactly, because an actor's instances are keyed by secret_id
-- within that actor. It is an identity, not a role — nothing here says whether
-- an actor is provisioned, which the uniformity constraint above forbids.

-- ── SDK store tables ────────────────────────────────────────────────────────

-- DeRecChannelStore. Helper channels and replica-group members live in one
-- table discriminated by `kind`, because the store loads them through a single
-- ChannelQuery -- but they are keyed differently, which `entity_id` carries:
-- a helper by channel_id, a group member by replica_id alone. A member moves
-- between channels during an admission handover while remaining the same
-- member, so keying on both would lose the row exactly when that move needs to
-- be observed.
CREATE TABLE channels (
    actor_id    TEXT NOT NULL,
    secret_id   TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('helper', 'replica')),
    entity_id   TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    record      TEXT NOT NULL,
    PRIMARY KEY (actor_id, secret_id, kind, entity_id)
);

-- The channel-link graph: channels belonging to the same Owner identity, e.g.
-- after a recovery re-pairing. Bidirectional, so both directions are stored
-- and `linked_channels` is a BFS over the rows.
CREATE TABLE channel_links (
    actor_id   TEXT NOT NULL,
    secret_id  TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    linked_id  TEXT NOT NULL,
    PRIMARY KEY (actor_id, secret_id, channel_id, linked_id)
);

-- DeRecSecretStore. Keyed by (secret_id, channel_id, kind) -- matching the
-- in-memory store's HashMap<(u64, u64, u8), SecretValue>. `kind` is the
-- SecretKind discriminant (0 SharedKey, 1 PairingSecret, 2 PairingContact),
-- stored as TEXT for readability since a developer will be reading these rows.
-- `value` is a serialised SecretValue, which derives serde behind the
-- library's `serde` feature.
CREATE TABLE secrets (
    actor_id   TEXT NOT NULL,
    secret_id  TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('shared_key', 'pairing_secret', 'pairing_contact')),
    value      TEXT NOT NULL,
    PRIMARY KEY (actor_id, secret_id, channel_id, kind)
);

-- DeRecUserSecretStore. One current snapshot per secret.
CREATE TABLE user_secrets (
    actor_id  TEXT NOT NULL,
    secret_id TEXT NOT NULL,
    payload   TEXT NOT NULL,
    PRIMARY KEY (actor_id, secret_id)
);

-- DeRecShareStore. Share has public scalar fields and maps straight to
-- columns; the channel comes from the method argument rather than the struct.
-- `bytes` is base64.
--
-- Keyed by (secret_id, channel_id, version), matching the in-memory store's
-- HashMap<(u64, u64, u32), Share>. There is deliberately no replica_id column:
-- the 0.0.4 `DeRecShareStore::save` signature is
-- `save(&mut self, secret_id, channel_id: ChannelId, share: Share)` and takes
-- no replica. Adding a column no trait method can populate would be a column
-- that is always '' and a key that is a lie.
CREATE TABLE shares (
    actor_id   TEXT NOT NULL,
    secret_id  TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    version    INTEGER NOT NULL,
    -- `Share.secret_id`, which is NOT the partition above. The SDK calls a
    -- Share "fully self-describing": its own secret_id names the secret the
    -- share belongs to, and on a helper that is the *owner's* secret while the
    -- partition is the helper's own instance. Reconstructing this from the
    -- partition instead corrupts every share a helper holds, which surfaces as
    -- recovery returning shares labelled with the wrong secret.
    share_secret_id TEXT NOT NULL,
    bytes      TEXT NOT NULL,
    PRIMARY KEY (actor_id, secret_id, channel_id, version)
);

-- `latest_version` scans every version for a secret across all channels.
CREATE INDEX shares_by_secret_version ON shares (actor_id, secret_id, version);

-- DeRecStateStore. Keyed by (secret_id, StateKey), matching the in-memory
-- store's HashMap<(u64, StateKey), StateItem>. `state_key` is the serialised
-- StateKeyRecord; `kind` is denormalised out of it because `load_all` filters
-- on kind alone and should not have to deserialise every row to do it.
--
-- StateItem has no serde of its own and round-trips through the SDK's
-- StateItemRecord, which does.
CREATE TABLE state_items (
    actor_id  TEXT NOT NULL,
    secret_id TEXT NOT NULL,
    state_key TEXT NOT NULL,
    kind      TEXT NOT NULL,
    item      TEXT NOT NULL,
    PRIMARY KEY (actor_id, secret_id, state_key)
);

CREATE INDEX state_items_by_kind ON state_items (actor_id, secret_id, kind);

-- ── Node registry tables ────────────────────────────────────────────────────
-- These replace the dashmaps in state.rs in Phase 4.

-- One flat, server-wide list of actors. `role` is owner or helper; a replica is
-- a pairing mode, not an actor kind, so it is deliberately not a role here.
--
-- `seq` carries registration order, which is part of the contract: the front
-- end polls GET /actors and renders the result as a list, so an unordered
-- result reshuffles the roster on every poll. It is assigned by the writer
-- inside the inserting transaction -- AUTOINCREMENT and SERIAL are both
-- unavailable under the portability rule, and `created_at` is too coarse
-- because two actors can share a second.
--
-- `transports` is the JSON-encoded endpoint list. `Actor` derives Serialize but
-- deliberately NOT Deserialize -- the relay's allowlist trusts those endpoints
-- by exact string match on the strength of no request body being able to
-- produce an Actor -- so the row is read back field by field rather than by
-- deserialising one. See `registry/actors.rs`.
CREATE TABLE actors (
    actor_id   TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'helper')),
    name       TEXT NOT NULL,
    secret_id  TEXT NOT NULL,
    transports TEXT NOT NULL,
    -- Protocol settings this actor runs with, kept so a restart rebuilds the
    -- same actor rather than a new one wearing its name.
    --
    -- `replica_id` matters most: it is the stable per-device id every stored
    -- ReplicaMember row references, so an actor rebuilt with a fresh one is a
    -- stranger to every replica group that already holds its old id. Decimal
    -- TEXT, like every other u64 here.
    --
    -- The other two are behavioural: a helper provisioned with a 60-second
    -- timeout should come back with one rather than silently reverting to the
    -- node default. Both are unused for a browser-run actor, whose protocol
    -- settings live in the page.
    replica_id   TEXT NOT NULL,
    timeout_secs INTEGER NOT NULL,
    unpair_ack   TEXT NOT NULL CHECK (unpair_ack IN ('required', 'not_required')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (actor_id)
);

CREATE INDEX actors_by_seq ON actors (seq);

-- Helper-side channel ids, one row per paired owner.
CREATE TABLE actor_channels (
    actor_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (actor_id, channel_id)
);

-- Helpers the operator has switched off to simulate being offline. A row means
-- disabled; absence means enabled.
CREATE TABLE disabled_helpers (
    actor_id TEXT NOT NULL,
    PRIMARY KEY (actor_id)
);

-- Contact messages posted by browser-managed participants for the owner to
-- fetch.
CREATE TABLE participant_contacts (
    actor_id TEXT NOT NULL,
    contact  TEXT NOT NULL,
    PRIMARY KEY (actor_id)
);

-- Store-and-forward mailbox. Ordering is by `seq`, which is assigned by the
-- writer rather than by the engine -- AUTOINCREMENT and SERIAL are both
-- unavailable under the portability rule.
CREATE TABLE mailbox (
    actor_id TEXT NOT NULL,
    seq      INTEGER NOT NULL,
    payload  TEXT NOT NULL,
    PRIMARY KEY (actor_id, seq)
);
