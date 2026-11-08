# Backlog

Local, untracked. Items queued after "one round at a time" (SDK 0.0.10
gating, 2026-10-27), in the order given.

## 1. Does the app run a round of sharing when a helper or replica is paired or unpaired? — answered 2026-10-27

| Trigger | Round? | Who starts it | Weights / threshold used | App gate |
| --- | --- | --- | --- | --- |
| Helper pairing completes (owner side, channel `Paired`: inline/hashed keys) | Yes, if a secret exists | Library, inside `process()`/`accept()` | Library's stored ones (new helper at 1) — not the Channels tab's | Can't defer (handoff #2); app avoids *starting* pairings while a round is open |
| Gated helper confirmed (`NoKeys` fingerprint) | Yes, if a secret exists | Library, inside `verify_fingerprint` | Library's stored ones | Confirmation refused while a round is open |
| Replica destination confirmed (source side) | Yes, even with no secret (roster only) | Library, inside `verify_fingerprint` | Library's stored ones | Confirmation refused while a round is open |
| Replica first sync (app's automatic trigger) | Never fires today (no peer reports confirmation) | App | Channels tab | Defers while a round is open |
| Replica "Sync now" | Yes | App, on request | Channels tab | Gated |
| Helper unpaired (owner side; a helper cannot start one) | Yes, if it held a share, the secret has items and the rest meet the threshold | App (`SecretRuntime.publishAfterUnpair`): after `start(Unpair)` without ack, else after the drain/tick that delivers `Unpaired` | Channels tab | Unpair refused while a round is open; a pending unpair (state kind 2) holds publishes back |
| Helper forgotten (local only) | No | — | — | — (Help says to Republish) |
| Replica evicted (Remove from group) | Yes, if the secret has items; otherwise only announced, completing with the first publish | App (`SecretRuntime.evictReplica`), after `start(UnpairReplica)` | Channels tab | Gated |
| Identity change in a replica group | Yes, if a secret exists | App | Channels tab | Gated |

Decided 2026-10-27: unpairing must run a sharing round. The library's own
publish (lib-derec `886db12`) never shipped: published SDK 0.0.10 leaves it to
the application, so since 2026-11-05 the app runs it, gated like any publish.
Below the threshold it publishes nothing and says so — the current version
then stays with one helper fewer.

Forget this channel (2026-10-27): it removes a channel outside the protocol.
The user's fix is at the source — the app must not let a paired participant
be deleted without unpairing first. Done: `DELETE /api/v1/helpers/{id}`
answers `409 PARTICIPANT_PAIRED` while the helper holds a Paired/Unpairing
channel (read from its channel rows), and the Participants pane disables
Delete. Forget stays, as an escape hatch for channels whose peer is already
gone (user's decision, 2026-10-27).

## 2. Threshold as a percentage of helpers — done 2026-10-27

Decided: at least % of total subshares (weights included), rounded up, floor 2,
raised to heaviest weight + 1 so no helper recovers alone (tooltip explains);
default 50% for new secrets; existing secrets stay Fixed; Channels tab only
(wizard / `min_participants` become the Fixed starting value). Restore/join
takes the group's number as Fixed. Library-started rounds still reuse the
last published number (handoff #4).


Turn the threshold from an absolute number into a percentage of the total
helpers (subshares, with weights), always honouring the minimum (2, and never
a single helper able to recover alone). Decide rounding (up), how it shows
(e.g. "60% → 3 of 5"), and how existing secrets' absolute thresholds migrate.

## 3. Threshold and weights move to the Channels tab — done 2026-10-27

Remove the threshold and helper weights from the publish dialogs (Add Secret,
Remove Secret, Republish). Both are set on the Channels tab, which gains a
threshold control; every publish uses those values.

## 4. Terminology: Vault → Secret, Secret → Item — done 2026-10-28

The app now uses DeRec's names: a vault is a **secret** (`Secret`, local UUID
`localSecretId`, DeRec's `secretId` unchanged) and a secret in the bag is an
**item** (`Item`, `ItemBag`, `BagVersion.items`). The SDK and its wire
formats are the boundary and keep their names. Storage moved from
`derec:vault:` to `derec:secret:` (boot migration in `src/secretStorage.ts`);
records in the old shape load through `fromLegacyRecord`; `#/vault/<id>`
still routes.

## 5. Protocol settings per secret, on a Settings tab — done 2026-10-28

A secret's protocol settings (timeout, unpair acknowledgement, the three
auto-accept choices, authentication method) moved from the general Settings
page to a **Settings** tab on the owner page, which also took over the old
Secret Settings dialog. They start from defaults the app defines
(`SECRET_CONFIG_DEFAULTS` in `src/protocolDefaults.ts`), not from the node or
a browser-wide override; the general page keeps only the helper pool. The
node's config no longer has protocol keys either (retired keys in a file are
ignored with a boot warning); the backend's fallback for a provisioning
request without settings is fixed at 30 s / `not_required`
(`models/protocol_settings.rs`). Defaults: 30 s timeout, unpair ack not
required, all three incoming requests accepted automatically.

**Open — verify the backend.** The backend part was written while it could not
compile against the in-progress lib-derec (`DeRecChannelStore::remove_many`
missing in `SqlChannelStore`); run `cargo test` and the e2e suite once it
builds.

**Open — apply at once.** The timeout and unpair acknowledgement are fixed into
the protocol instance when it is built, so a change waits for the secret to
start again (the tab says so; `SecretRuntime.settingsAwaitingRestart`). Ideally
a saved setting is always the one in effect: rebuild the instance when no
round, pairing or recovery is in flight. TODO in `src/secret/runtime.ts`.
