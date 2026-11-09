# SDK 0.0.11 — findings from the reference app

Findings the reference app hit while moving to the local, unreleased
lib-derec 0.0.11 (`fix/security_findings`: "Security fixed #8, #16 and #17",
"#18", "#19", "#9" plus staged changes). App-side changes are in the app; these
are the library's to decide. Nothing in lib-derec was changed.

None of these blocks the app: every item has an app-side workaround in place.
They are things every integrator will run into, so they are worth settling in
the library or its docs before 0.0.11 is published.

| # | Area | Severity | Status |
| --- | --- | --- | --- |
| 1 | Default `pairing` lifetime (30 s) is too short for human-paced pairing | Medium | Open — suggestion |
| 2 | `RecoveryIncomplete` does not say which secret it closes | Low | Open — question |
| 3 | A helper timeout is a `RecoverSecretFailed` with the magic error `"timeout"` | Low | Open — suggestion |
| 4 | `AutoAcceptPolicy::all()` still enables `update_channel_info`, which the docs now call unsafe | Medium | Open — question |
| 5 | Replay and reflection detection is left to every integrator | Medium | Open — suggestion |
| 6 | Contacts now need a timestamp: easy to lose in an app's own wire form | Low | Docs — suggestion |

## 1. Default `pairing` lifetime (30 s) is too short for human-paced pairing

**Where:** `library/src/protocol/types/mod.rs:287` (`pairing: Duration::from_secs(30)`),
`protocol/handlers/pairing/mod.rs` (`start` refuses a contact older than the
lifetime with `PairingError::Expired`; the creator refuses a request against
its own contact the same way).

**What happens:** the lifetime is measured from the contact's timestamp. A
contact shown as a QR code, copied between two windows, or published for
other devices to pick up is routinely older than 30 seconds by the time it is
used, and the pairing fails with `pairing_expired`. With the default, the
app's browser-to-browser pairing and its published browser contacts (picked
up minutes or hours after they are minted) would routinely fail.

**App workaround:** `Timeouts.pairing` is set to 30 minutes on both the web
(`PAIRING_LIFETIME_SECS` in `apps/web/src/owner/protocol.ts`) and backend
(`infrastructure/actors/mod.rs`) instances, and the browser re-mints its
published contact every 15 minutes.

**Suggestion:** a default sized for a person (several minutes at least), or a
prominent note in the migration entry that the default suits machine-to-machine
pairing only. The migration note already covers `expired_channels`; it could
say the same about the lifetime itself.

## 2. `RecoveryIncomplete` does not say which secret it closes

**Where:** `library/src/protocol/events/mod.rs` — `RecoveryIncomplete { version, shares_received }`.

**What happens:** `PendingRecovery` is keyed by `(secret_id, version)`, so
recoveries of two secrets at the same version can be open at once.
`SecretRecovered`, `RecoveryDisputed` and `RecoveryConflict` carry the
reconstructed `Secret`, and so its id, but `RecoveryIncomplete` carries only
`version`. When it fires, the app cannot tell which of the open recoveries
closed.

**App workaround:** the web app runs one recovery at a time per protocol
instance, so the version alone identifies it there.

**Suggestion:** add `secret_id` to `RecoveryIncomplete`.

## 3. A helper timeout is a `RecoverSecretFailed` with the magic error `"timeout"`

**Where:** `library/src/protocol/sweeps.rs:384` and `:443`.

**What happens:** when `get_share_response` elapses, `tick` reports each
silent helper as `RecoverSecretFailed { error: "timeout" }`. The same event
also means a real failure, so telling "did not answer in time" apart from a
refusal or a transport error means matching the error string. The same
literal appears as a `memo` and a `reason` at `sweeps.rs:716` and `:733`.

**App workaround:** the web fold compares `error === 'timeout'` and counts
those helpers separately in the "not enough shares" message.

**Suggestion:** a typed reason (an enum field on the event, or a dedicated
`RecoveryHelperTimedOut { channel_id, version }`), or at least a documented
constant exported from every binding.

## 4. `AutoAcceptPolicy::all()` still enables `update_channel_info`

**Where:** `library/src/protocol/events/mod.rs:276` (`all()` sets
`update_channel_info: true`); the doc comment above it (around line 231) now
says that accepting an update unchecked lets a reflected or replayed update
re-route the channel, and that catching it is the application's job.

**What happens:** with auto-accept, the update is applied inside `process`.
The app never sees an `ActionRequired`, so it has no point at which to reject
an update older than the last one accepted. Also, `ActionRequired` for
`UpdateChannelInfo` carries no timestamp, so even an app that gates the update
has to read the unauthenticated envelope timestamp via `message_id` to order
updates.

**App workaround:** the web app does not auto-accept channel updates, and
rejects one older than the last accepted (`apps/web/src/secret/channelUpdates.ts`),
ordering them by the envelope timestamp. The backend's provisioned fixtures
use `AutoAcceptPolicy::all()`, so for them only exact copies are caught (by
the replay guard, item 5); a held-back older update would still be applied.

**Question:** should `all()` leave `update_channel_info` off, or should the
library itself refuse an update older than the last applied one on the
channel? It has the channel record and the message timestamp, which the app
has only indirectly.

## 5. Replay and reflection detection is left to every integrator

**Where:** the 0.0.11 changelog entry for `message_id`; `library/src/derec_message/mod.rs`.

**What happens:** every integrator must now keep the id of every envelope it
sends and every one `process` accepts until `max(seen at, timestamp) +
inbound_message`, and drop an inbound envelope whose id is kept. Getting it
wrong is silent: a reflected message decrypts as the peer's.

**App workaround:** the web app keeps the ids in localStorage
(`apps/web/src/secret/replayGuard.ts`); the backend keeps them in memory per
actor (`apps/backend/src/infrastructure/replay.rs`), so a node restart forgets
them for one inbound window.

**Suggestion:** an optional store-backed id log in the library, with the
same store abstraction the other stores use, so `process` can drop copies
itself and sends are recorded where they are made.

## 6. Contacts now need a timestamp: easy to lose in an app's own wire form

**Where:** `library/src/protocol/handlers/pairing/mod.rs:334` —
`InvalidContactMessage("contact carries no timestamp")`. Documented in the
0.0.11 changelog's migration note.

**What happens:** the app moves contacts as its own JSON (QR payload, backend
DTO) and mapped the fields one by one. `timestamp` had always been optional and
unused, so it was not mapped, and after the upgrade every pasted or relayed
contact failed with `invalid_contact_message`. About 60 of 95 end-to-end tests
failed until the field was carried. This was an app bug, not a library one,
but any integrator with its own contact format will hit it the same way.

**App fix:** `timestamp: { seconds, nanos }` added to the contact DTO on web
and backend, and a readable message for a contact from an older build.

**Suggestion:** say in the migration note that apps which serialize contacts
themselves must now carry `timestamp`, and give the error for a missing one
its own code (e.g. `contact_without_timestamp`) so apps need not match text.
