# SDK 0.0.10 — findings from the reference app

Findings the reference app hit while moving to the local, unreleased
lib-derec 0.0.10 (`fix/replica-route-channel-binding`). App-side changes are
in the app; these are the library's to decide.

Context: 0.0.10 replaces `keepList` with a single `keepVersion`, so a helper
holds at most the version being shared and one other. The app's position is
that settling rounds is the application's job: it must not start version N+1
while N is still open, must tell the owner that N did not fully commit, and
should let them discard N before going on. Items 1 and 2 are where the library
leaves the app unable to do that on its own.

| # | Area | Severity | Status |
| --- | --- | --- | --- |
| 1 | No way to abandon an open sharing round | Medium | Open — question |
| 2 | Auto-publish on pair completion starts a round the app cannot defer | Medium | Open — question |
| 3 | `start(ProtectSecret)` does not say a round is already open | Low | Open — question |
| 4 | Publishes the library starts on its own ignore the app's weights and threshold | Medium | Open — question |
| 5 | Unpair / replica removal did not republish | Medium | Fixed in lib-derec (unreleased) — verified by the app |
| 6 | An unpair under `UnpairAck::Required` publishes from `process`/`tick`, which the app cannot defer | Low | Open — question |

## 1. No way to abandon an open sharing round

**Where:** `library/src/protocol/flows.rs` (`ProtectSecret` saves a
`StateItem::SharingRound`), `protocol/sweeps.rs` (`tick` settles it on
`Timeouts::sharing_round`, 60 s by default), `protocol/handlers/sharing.rs`.

**What happens:** a round closes only when every pending helper and replica
answers, or when its timeout expires during `tick`/`process`. There is no
public call to end it early. An app that wants to ask "v3 did not reach its
threshold — discard it and publish v4?" can only wait out the timeout, or
delete the library's own state row behind its back.

**Why it matters with 0.0.10:** under `keepList` the app could keep an open
round on the helpers while publishing a newer one. With one `keepVersion`, the
safe sequence is to settle (or discard) v3, then publish v4. Discarding needs
a library operation.

**Question / suggested fix:** a `DeRecProtocol::abandon_sharing_round(version)`
(or a flow) that closes the round as `SharingComplete { threshold_met: false }`
or a dedicated event, drops this device's proofs for that version as a failed
round does, and leaves the next `keepVersion` free to drop it from helpers.

## 2. Auto-publish on pair completion starts a round the app cannot defer

**Where:** `library/src/protocol/actions.rs` — `maybe_auto_publish_after_pair`,
called from `process()` (`protocol/process.rs:165`) and `accept()`
(`actions.rs:87`) on an Owner-side `PairingCompleted` for a `Paired` helper
channel. The promotion inside `verify_fingerprint` publishes the same way.

**What happens:** an owner can start a pairing, then publish v3. When the
helper's pair response arrives during v3's round, `process()` starts v4 at
once. The app gets the events afterwards and has no way to say "not now".
`verify_fingerprint` can be gated by the app, since the app decides when to
call it. A pair response cannot: it arrives whenever the peer answers.

With a single `keepVersion`, v4 then tells helpers to keep the newest
committed version, so v3's shares go from every helper that stores v4. If v3
was about to commit, it is gone from those helpers.

**Reproduce:** owner with two paired helpers. Start a pairing with a third.
Publish v3, and deliver the third helper's pair response before v3's round
closes. `process()` returns v4's `ShareRequested` events, and the
`keepVersion` asked for v4 is below v3.

**Question / suggested fix:** let the app opt out of the automatic publish
(a builder flag), or have the library defer it while a round is open and run
it when that round settles. Either way, document that the auto-publish can
overlap an open round.

## 3. `start(ProtectSecret)` does not say a round is already open

**Where:** `protocol/handlers/sharing.rs` `start`.

**What happens:** a second `ProtectSecret` while a round is open is accepted
and runs alongside it. The app can find open rounds only by reading the
library's `SharingRound` state rows (kind 3) from its own state store, which
is an internal format.

**Question:** keeping rounds settled is the app's job, but it needs a
supported way to know which rounds are open — a `DeRecProtocol` query, or an
event when a round opens — rather than decoding state rows. Optionally, a
`start` error such as `SharingRoundInProgress { version }` that the app can
choose to override.

## 4. Publishes the library starts on its own ignore the app's weights and threshold

**Where:** `protocol/actions.rs` `maybe_auto_publish_after_pair` and
`protocol/fingerprint.rs` (promotion inside `verify_fingerprint`) both call
`start_protect_secret(secrets, description, None, None, …)`.

**What happens:** `weights: None, threshold: None` reuse the weights and
threshold of the last publish, and a newly paired helper gets weight 1. The
reference app now keeps the threshold and every helper's weight as the
owner's settings (its Channels tab) and passes them on every round it starts.
A round the library starts on its own does not see them: if the owner raised
the threshold or weighted the new helper since the last publish, the
pair-completion publish splits with the old values, and the app's next
publish changes them again.

This got sharper once the app offered a **percentage** threshold (worked out
from the paired helpers' subshares at each publish): a pair or unpair changes
the subshare count, and the library's own round for it publishes the old
absolute number, e.g. 50% of 4 = 2 stays 2 after a fifth helper pairs instead
of becoming 3.

**Question / suggested fix:** a way for the app to supply them, e.g. a
`DeRecShareStore`-style callback (`round_parameters(secret_id) -> (threshold,
weights)`) asked for every round whoever starts it, as `keep_version` already
is; or the opt-out from #2, so the app publishes itself with its own values.

## 5. Unpair / replica removal did not republish — fixed

**Was:** `start(Unpair)` only tore the channel down, leaving the remaining
helpers on a split the removed helper held a share of; `start(UnpairReplica)`
only announced, and the app had to publish the roster itself (impossible with
no secret).

**Now (lib-derec `Unreleased`):** removing a share holder publishes the latest
snapshot to the rest; `UnpairReplica` publishes the roster at once; auto rounds
below the threshold publish nothing. **App side:** the eviction's own
`syncReplicasNow()` was dropped (it would publish a second version), the events
`start(Unpair)` returns are folded, and Unpair / Remove from group are gated by
the one-round rule. Verified with the app's unit and e2e suites against the
rebuilt local package.

Note: #4 applies to these rounds too — they reuse the last published weights
and threshold, not the owner's current Channels-tab values.

## 6. A pending unpair publishes when the app cannot defer it

**Where:** `process()` / `tick()` → `maybe_auto_publish` with
`pending_unpair_share_holders`.

**What happens:** under `UnpairAck::Required` the republish runs when the
helper's answer arrives (or on the timeout), the same shape as #2. The app
copes by treating any `PendingUnpair` state row (kind 2) as a round about to
start, and holding every publish back meanwhile — again by reading the
library's internal state rows (see #3).

**Question:** the same opt-out or deferral as #2 would cover it; failing that,
a supported query for pending unpairs.
