# lib-derec "weighted helpers" + `DeRecProtocolConfig` — reference-app report

Four rounds against the local, unreleased lib-derec 0.0.9 (branch
`feature/leaf_separator_and_padding`). **Round 4** (2026-10-23) is the current
state; Rounds 3, 2 and 1 are kept below for the record. Everything here
is an observation plus a suggestion; none of it has been changed in the
library.

---

# Round 4 — 2026-10-23: the share-retention SDK changes, built into the app

Library under test: commit `8f3e333` plus the uncommitted tree, now including
per-share `subshares` / `threshold`, the recorded threshold (`UserSecrets`,
`Secret`, `ProtectSecret.threshold`), owner-side proof pruning, and the
`2026-10-22-share-retention.md` handoff. This round implemented every flow the
handoff describes in the reference app, rather than only adapting to it
(design: `docs/superpowers/specs/2026-10-22-share-retention-ux-design.md`).

## Result

The SDK changes work as documented for every flow the app now exposes:
weights (defaults and per publish), the threshold as per-version data, which
versions helpers keep (last N or chosen per publish), cleanup of verification
copies (manual and automatic, including on a replica), recoverability from
`ShareVerified.subshares` / `threshold`, and periodic verification. One flow
cannot complete because of the SDK: **joining a recovered vault's replica
group** (R4-2). The Round 3 documentation findings are all fixed.

## What was run

| Check | Result |
| --- | --- |
| Backend `cargo test` / `cargo clippy --all-targets` (exit codes read directly) | **exit 0** / clean |
| Web `tsc -b`, `eslint .` | clean |
| Web `vitest run` | **116 files / 1351 tests pass** |
| Playwright e2e, full suite | **85 passed, 5 skipped (14.8 min), exit 0** |
| `e2e/restore-or-join.spec.ts` | `test.fixme` — reaches the SDK boundary (R4-2) |

Note (not a finding): since 0.0.9 the library deletes the source's own proofs of a version it tells helpers to drop, so verifying that version fails with `NoProof` before any challenge goes out. Helpers can no longer be seen refusing a dropped version from the app. That is consistent with the retention handoff. The app had been describing every `NoProof` as "restored from a recovered bag"; that is fixed on the app side.

## Status of Round 3 findings

| # | Finding | Now |
| --- | --- | --- |
| R3-1 | "Below the threshold" example arithmetic | **Fixed** — now "two helpers at weight 2 against 3 (total 4) drop below it when a publish leaves both out … for a total of 2" |
| R3-2 | `?? 1` snippet vs "stored 0 reads as 1" | **Fixed** — snippet gone from the Web, Node and RN READMEs |
| R3-3 | Public `restore()` docs omit the absent/`null` rule | **Fixed** — `index.d.ts` documents it and types `communication_info` as `Record<…> \| null` |

## Findings

| # | Area | Severity | Kind |
| --- | --- | --- | --- |
| R4-1 | `SecretRecovered` and `ReplicaSecretReceived` payloads no longer have the same TypeScript type | Low | Types |
| R4-2 | A joiner that has not confirmed the fingerprint yet loses the admission handover, and cannot ask again | **High** | Behaviour — blocks "recover, then join" |

### R4-1. The mirrored and recovered secret types diverged

**What happens.** In `packages/web/index.d.ts`, `SecretRecovered.secret`'s helpers
and replica members carry `communication_info?: Record<string, string> | null`
(the R2-6 fix), while `ReplicaSecretReceived.secret` keeps
`communication_info?: Record<string, string>`. The two are documented as the same
`Secret`, and the app had a compile-time assertion that they are exactly equal
(so a mirrored copy can go straight to `restore`). It now fails to compile.

**Reproduce.** `type X = ExactlyEqual<ReplicaSecretReceived['secret'],
SecretRecovered['secret']>` resolves to `false`.

**App side.** The app now checks assignability plus identical field names at every
level instead, which is what `restore` needs.

**Suggestion.** Give `ReplicaSecretReceived` (and `ReplicaSecretInstalled`) the same
`| null`, or derive all three from one declared `Secret` type so they cannot drift.

### R4-2. Joining a group: the admission handover is lost if the joiner confirms second

**Where.** `library/src/protocol/handlers/replicas/sharing.rs` — the admission
handover ("The admitter dropped its side when it sent the sync",
`"admission handover complete; ephemeral channel dropped"`), together with the
destination's `PendingVerification` rule (a channel not yet fingerprint-confirmed
ignores inbound traffic).

**What happens.** The README's "Recover, then restore or join" tells an app to
join a live group: pair with a live member as replica destination, confirm the
fingerprint, then `ReplicaDiscovery`. When the joiner is admitted by an existing
member:

1. the member confirms its side and immediately sends the admission handover (the
   sync carrying the group channel and key) on the ephemeral pairing channel, and
   drops that channel;
2. the joiner has not confirmed yet — a person is comparing codes — so it ignores
   the handover (`MessageIgnored { reason: PendingVerification }`);
3. once the person confirms, the joiner asks for the copy (`ReplicaDiscovery`) on
   the only channel it has, the ephemeral one, which the member no longer holds.
   Nothing answers; the joiner never receives the vault.

A member run unattended (a provisioned helper, any auto-confirming member)
confirms within seconds, so joining through one **always** fails; a human
joiner succeeds only if they confirm before the member does. The first-pairing
case ("a mirrored copy pushed before the destination confirms is ignored, then
pulled once it does") works because there the source keeps the channel.

**Evidence (reference app e2e, provisioned member on the same node).** Joiner's
Console: `Replica channel …983 established — pending fingerprint confirmation`,
then `Ignored a message on channel …983 — this device has not confirmed the
channel's fingerprint yet`, then after confirming `Asking the replica group for
its copy (attempt 1)`. Node log on the member:
`no instance owns this channel; dropping message channel_id=…` for every later
message on that channel.

**Reproduce.**

1. Owner with two helpers and one replica (here a provisioned helper in replica
   mode); protect a secret; the replica acknowledges.
2. New device: pair with the helpers, link, Discover, Recover. The recovered
   `secret.replicas` names the replica.
3. Pair as `ReplicaDestination` with that replica (a contact from its replica
   instance for the recovered secret), confirm the fingerprint after the member
   has. The vault never arrives.

**Suggestions (for the library owner to weigh).**

- Keep the ephemeral channel on the admitter until the joiner acknowledges the
  handover (or until a timeout), so a catch-up on it is answered.
- Or let a `Pending` destination buffer an admission handover instead of ignoring
  it, and apply it when the fingerprint is confirmed — the handover is already
  authenticated by the pairing key.
- Or have the admitter send the handover only after the joiner signals its own
  confirmation.
- Whichever, a test where the joiner confirms *after* the admitter would pin it.

---

# Round 3 — 2026-10-22: the Round 2 fixes

Library under test: still commit `8f3e333` plus the uncommitted tree, now
including the fixes for R2-1 … R2-6 (see the library's own
`.superpowers/sdd/2026-10-22-refapp-r2-report.md`, which was read as a list of
claims and checked independently).

## Result

Every Round 2 finding is resolved as claimed, checked against the shipped
package and the CHANGELOG rather than taken from the summary. The app adopted
`RequestFailed.memo` and runs green on every suite. Three new documentation
findings, none affecting behaviour; the most visible is a worked example whose
arithmetic is wrong in seven places (R3-1).

One correction to my own Round 2 report: its "backend `cargo test`: all pass"
was wrong — see "Changes made in the app" below.

## What was run

| Check | Result |
| --- | --- |
| WASM package rebuilt and reinstalled | ok |
| Backend `cargo clippy --all-targets` | clean |
| Backend `cargo test` (exit code read directly) | **exit 0**, every test binary ok — after re-vendoring `error.proto` (it failed before; see below) |
| Web `tsc -b`, `eslint .` | clean |
| Web `vitest run` | 107 files / 1253 tests pass |
| Playwright e2e, full suite | **82 passed, 4 skipped, 0 failed** (13.1 min, exit 0); skips are the LAN-gated specs |
| `e2e/weights.spec.ts`, including the new restore test (run separately; added after the suite started) | **2 passed** (exit 0): the restored device published with the heavy helper at ×2 |

## Changes made in the app

- **`RequestFailed.memo` adopted.** A failed request is answered with
  `reject(action, event.status, event.memo)`, exactly what auto-respond would
  send, instead of the generic memo the app had to supply in Round 2. The
  backend logs the memo too.
- **Comments brought up to date** where they described the old SDK: the
  `StatusEnum` name table (no longer "declared as an enum") and the
  `communication_info` omission (now a courtesy to older builds, since
  0.0.9 accepts `null`).
- **Vendored proto re-copied** (`apps/backend/proto/protobufs/error.proto`).
  `ErrorResponseMessage` gained `timestamp = 2` in Round 2 and
  `tests/proto_drift.rs` had been failing since then. My Round 2 run started
  `cargo test` in the background and read the exit code of the trailing
  `grep` instead of cargo's, so it reported "all pass". It was the app's gap,
  not the library's.
- **New e2e test:** a vault protected with a helper at weight 2, recovered and
  restored on a *new* device, publishes with that helper at ×2 without anyone
  setting it again. This exercises the claim the app relies on — that
  `restore` writes each roster `weight` into the new channel records — end to
  end, rather than on the device that already had it stored.

## Status of Round 2 findings

| # | Finding | Now | How checked |
| --- | --- | --- | --- |
| R2-1 | TS enums without reverse mapping | **Fixed** | `index.d.ts` declares `export declare const StatusEnum: { readonly Ok: 0; … }` plus a value type; `StatusEnum[8]` no longer compiles; the app's name table still type-checks. CHANGELOG has a "breaking (TypeScript source)" entry. |
| R2-2 | `RequestFailed` lacked the memo | **Fixed** | `memo: string` on the event, documented as "exactly the response `autoRespondOnFailure` would have sent"; the app now uses it. |
| R2-3 | Absent `weights` resets every helper | **Docs only, by decision** | The full-assignment rule stands; every SDK's docs now describe the "pre-fill from the store, pass the stored weights on every other publish" workflow — the one the app implements. |
| R2-4 | Rust source breaks not flagged | **Fixed** | CHANGELOG marks `ProtectSecret.weights` and `HelperChannel.weight` "Breaking (Rust source)", and the builder sentence now says to drop the `OwnTransport` parameter. |
| R2-5 | Pairing send failure behaviour | **Fixed** | CHANGELOG and library README describe `PairingCompleted` + `RequestFailed { responded: true }`. |
| R2-6 | `communication_info: null` refused | **Fixed** (by code and library test) | `HelperIn` / `ReplicaIn` now take `Option<HashMap>`. Not exercised in-app: the app still omits the key. See R3-3 for the public docs. |

## Findings

| # | Area | Severity | Kind |
| --- | --- | --- | --- |
| R3-1 | "Below the threshold" example: 2 + 1 does not drop below 3 | Low | Docs (7 places) |
| R3-2 | README weight-reading snippet `?? 1` keeps a stored `0` as `0` | Nit | Docs (3 places) |
| R3-3 | Public `restore()` docs omit the new absent/`null` rules | Low | Docs |

### R3-1. The "below the threshold" example does not add up

**Where:** CHANGELOG (weighted helpers, "Below `t`" paragraph), `library/README.md`
(around "two Helpers at weight 2 against `threshold = 3`"), and the Web, Node,
React Native, Go and .NET READMEs ("two helpers at weight 2 against a
threshold of 3 drop below it the moment one is replaced by an unnamed
helper").

**What it says vs what happens.** Two helpers at weight 2 hold 4 subshares;
replacing one with an unnamed helper at weight 1 leaves 2 + 1 = 3, which
*meets* a threshold of 3. The round splits normally. The example only drops
below threshold if both reset (1 + 1 = 2, which is what an unweighted restore
follow-up actually does) or with a threshold of 4 (2 + 1 = 3 < 4).

**Suggestion.** Use `threshold = 4` in the example, or describe the restore
follow-up case directly: "a follow-up publish that passes no weights resets
both to 1, and 1 + 1 is below 3".

### R3-2. `?? 1` disagrees with "a stored `0` reads as 1"

**Where:** the Web, Node and React Native READMEs, "Helper weights":
`JSON.parse(…).Helper.weight ?? 1`.

**What it says vs what happens.** The CHANGELOG says a stored `0` (written by a
writer that predates the field, e.g. a Go struct without `Weight`) reads as 1.
`?? 1` only covers absent or `null`; a `0` stays `0`, and passing it back in
the `weights` map is an `invalid_weight` error. In practice a TS app reads
records the core wrote, so a `0` is unlikely — hence "nit".

**Suggestion.** `… .Helper.weight || 1`, or say "absent, `null` or `0` means
1" next to the snippet.

### R3-3. The public `restore()` docs do not carry the new rules

**Where:** `packages/web/index.d.ts` (and Node), the hand-written `restore()`
doc and the `SecretRecovered` helper type.

**What happens.** The R2-6 fix documents "an absent or `null`
`communication_info` reads as an empty map" in the Rust/WASM rustdoc and the
FFI doc. In the web package that text appears only in the generated internal
binding `derec_library.d.ts`, which apps do not import. The public
`restore()` doc in `index.d.ts` says nothing about it, and the
`communication_info?: Record<string, string>` type does not admit `null`, so a
TypeScript caller cannot tell `null` is now accepted.

**Suggestion.** Add the sentence to the `restore()` doc in `index.d.ts`, and
optionally widen the type to `Record<string, string> | null`.

---

# Round 2 — 2026-10-22: the fixed and extended SDK

Library under test: commit `8f3e333` ("Weighted helpers on the protocol") **plus
the uncommitted changes** on top of it (every authenticated request answered
exactly once, `RequestFailed`, `ShareRefused`, `ReplicaSecretRefused`,
`PairingRefused`, `ErrorResponseReceived`, sticky weights on `HelperChannel` and
in the roster). Still versioned `0.0.9`.

## Result

The app now **uses** the new SDK surface, not just compiles against it: helper
weights end to end, and every new event handled. Every suite is green
(numbers below). Round 1's finding 2 (an invalid share stored and never
answered) is fixed in the library and re-verified across builds. Six new
findings, all about contracts and docs rather than broken behaviour — the most
consequential is that an absent `weights` map silently resets every helper to
1 (R2-3).

## What was run

| Check | Result |
| --- | --- |
| WASM package rebuilt and reinstalled | ok |
| Backend `cargo build --all-targets`, `cargo clippy --all-targets` | clean |
| Backend `cargo test` | ~~all pass~~ **Correction (Round 3):** this was wrong. `tests/proto_drift.rs` failed (exit 101) because the vendored `error.proto` lacked the new `timestamp` field; the background run's exit code was misread. Fixed in Round 3 by re-vendoring. |
| Web `tsc -b`, `eslint .` | clean |
| Web `vitest run` | 107 files / 1253 tests pass (17 new) |
| Playwright e2e (86 tests, one new: `e2e/weights.spec.ts`) | **82 passed, 4 skipped, 0 failed** (12.7 min); the skips are the LAN-gated specs |
| Round 1 finding 2 re-checked across builds (old owner → new helpers) | **Fixed**: both helpers answered `FORMAT_ERROR` (9, "CommittedDeRecShare.de_rec_share is not a valid DeRecShare") and stored nothing; the owner saw "2 rejected" in about 1 s instead of "2 no answer" after about 65 s |

## Changes made in the app

**Adapting to the SDK (required):**

- Backend: `HelperChannel` gained a required `weight` field; seven test
  literals set `weight: 1`. The provisioned actors log the five new events
  (`RequestFailed`, `ShareRefused`, `ReplicaSecretRefused`, `PairingRefused`,
  `ErrorResponseReceived`) — they fell into a catch-all `_ => {}` and would
  have vanished, where the old error path at least logged `process() failed`.
- Backend test `the_tick_backstop_confirms_a_channel_the_event_path_missed`
  manufactured its premise from the old behaviour: a failed `PairResponse`
  send made `process()` return `Err`, so the actor never saw
  `PairingCompleted`. The library now returns `PairingCompleted` plus
  `RequestFailed { responded: true }`, so the fast path runs and the premise is
  gone. The test now pairs for real, then puts the helper's record back to
  `Pending` through its own channel store — the state a node stopping between
  persist and confirm leaves behind.
- Web: the exhaustive event table and `PendingActionKind` map gained the new
  entries. `RequestFailed` with `responded: false` and a token is answered with
  `reject(token, status, "request could not be processed")`; the browser runs
  with `auto_respond_on_failure` off, so without this its peers would time out.
  The answer is chained onto the protocol lock, because folds run inside it.
- Web: the recovered-secret snapshot now carries each helper's `weight` to
  `restore`. Without it, `restore` would record every helper at 1 and the next
  publish would silently reset the owner's weights.

**Adopting weighted helpers:**

- Every protect round passes the stored weights, read from the library's own
  helper records (absent or `0` read as 1, as the library does) — the map is a
  full assignment, so passing nothing would reset them.
- **Helper weights** editor on the Secrets tab: one field per paired helper,
  `1 … threshold − 1`, total must reach the threshold; saving republishes the
  current bag with the new weights and shows the usual round progress.
- Threshold decisions count subshares: the publish gates and banner, round
  progress ("×N" on weighted rows, subshare wording), the pending-round notice,
  and — the one that affects correctness — the watchdog's roll-back-on-timeout
  and the early commit, which used helper counts and would have rolled back a
  round the library considers successful. Round weights are persisted with the
  open round so a reload keeps them.
- Help (protecting secrets, concepts, glossary, troubleshooting) and CHANGELOG.

## Status of Round 1 findings

| # | Finding | Now |
| --- | --- | --- |
| 1 | Old-format shares verify but do not recover | Expected (maintainer) |
| 2 | Invalid share stored and never answered | **Fixed** — re-verified across builds: immediate `FORMAT_ERROR`, no share row stored |
| 3 | Two incompatible builds both say 0.0.9 | Unchanged (still 0.0.9) |
| 4 | Rust source breaks not flagged | **Still applies**, and grew — see R2-4 |
| 5 | TS: `weights` keyed by `bigint`; error `code` untyped | **Fixed** — `Map<bigint \| string, number>`; `DeRecErrorCode` union |
| 6 | `restore` rejects `communication_info: null` | **Still open** — see R2-6 |

## Findings

| # | Area | Severity | Kind |
| --- | --- | --- | --- |
| R2-1 | TS enums declared as `enum` but shipped without reverse mapping | Low–Medium | Types / runtime mismatch |
| R2-2 | `RequestFailed` lacks the memo the library would have sent | Low | API gap |
| R2-3 | An absent `weights` map resets every helper to 1 | Medium | API design (question) |
| R2-4 | More Rust source breaks not marked breaking; one stale sentence | Low | Docs |
| R2-5 | A responder's failed `PairResponse` send no longer fails `process()` | Info | Behaviour change worth a line |
| R2-6 | `communication_info: null` still refused, now beside a `weight` that accepts `null` | Low | Consistency |

### R2-1. `StatusEnum` (and three others) type-check as enums, but are not

**What happens.** `packages/web/index.d.ts` declares `export enum SenderKind`,
`ContactMode`, `FlowKind` and `StatusEnum`. A TypeScript `enum` has a reverse
mapping, so `StatusEnum[8]` type-checks as `string`. `index.js` ships each as
`Object.freeze({ Ok: 0, … })`, with no reverse mapping, so it is `undefined`
at run time. The compiler cannot catch it.

**Reproduce.**

```
node --input-type=module -e "import('@derec-alliance/web').then(m => console.log(m.StatusEnum[8], m.FlowKind[1]))"
# undefined undefined
```

The app hit it naming statuses for the Console (`StatusEnum[status]` printed
`status 8`, caught by a unit test) and now builds its own name table.

**Suggestions.** Declare what is shipped — e.g. `export declare const
StatusEnum: { readonly Ok: 0; … }` plus `export type StatusEnum = (typeof
StatusEnum)[keyof typeof StatusEnum]` — or ship the reverse mapping. Either
keeps `StatusEnum.Rejected` working as it does today. A `statusName()` helper
would also save every app writing the same table.

### R2-2. A token answerer cannot send what the library would have sent

**What happens.** With `auto_respond_on_failure` on, the library answers a
failed request with a status *and a memo* chosen by `failure_status`
(`protocol/obligation.rs`): `"the sender's role does not permit this
request"`, `"no transport endpoint in the request is supported"`, `"message
body could not be decoded"`, or the generic `"request could not be processed"`.
With it off, `RequestFailed` hands over `status` and the token, but not that
memo — only `message`, which must never go on the wire. An app answering the
token (as the docs ask) can only send a generic memo, so a peer gets a less
precise answer from an app that answers itself than from one that lets the
library do it.

**Reproduce.** Read `RequestFailed`'s fields (`events/mod.rs`: `channel_id,
action_kind, responded, status, error_code, message, action`) against
`failure_status` / `UNDECODABLE_MEMO` in `obligation.rs`.

**Suggestion.** Add the wire-safe `memo` to `RequestFailed` (the one the
library sent, or would have), so `reject(action, event.status, event.memo)` is
exactly what auto-respond does.

### R2-3. An absent `weights` map resets every helper to 1

**What happens.** Weights are sticky and the map is a *full assignment*, so
"an absent or empty map resets every helper to 1" (`ProtectSecretParams`
docs). Absent and empty mean the same thing. Every caller of
`start(ProtectSecret)` that predates weights — or simply does not care about
them — therefore silently erases weights another part of the app (or a
`restore`) set. There is no getter; in TypeScript the documented way to keep
weights is to `JSON.parse` the stored helper records, which the same docs
otherwise warn against (u64 ids).

The reference app had to route its single protect call site through a store
read to stay correct, and found one place (the recovered-secret snapshot) that
would have dropped weights on the way to `restore`.

**Question / suggestions (for the library owner to weigh).**

- Make *absent* mean "keep what is stored" and an explicit empty map mean
  "reset": existing callers would then keep weights instead of erasing them,
  and resetting stays one deliberate call.
- Or expose the stored weights (a `helperWeights()` read, or the weights on
  the roster the app can already list), so callers need not parse store bytes.

### R2-4. Rust source breaks still not marked as breaking

- `HelperChannel` gained a required `weight` field and still has no `Default`,
  so every struct literal stops compiling — the app had seven, all in tests.
  The changelog describes the field but not the break.
- `DeRecFlow::ProtectSecret.weights` (Round 1) is still a required field
  described as a feature.
- The changelog's "No code, rustdoc or README named the builder's type
  parameters" is still there; the reference app did name them.

**Suggestion.** Mark these "breaking (Rust source)"; optionally give
`HelperChannel` a constructor or `Default` so fixtures survive the next field.

### R2-5. A failed `PairResponse` send no longer fails `process()`

Informational. On the responder, a `PairResponse` whose send fails now yields
`PairingCompleted` plus `RequestFailed { action_kind: Pairing, responded: true }`
instead of an `Err` with a persisted `Pending` channel and no events. That is
the right behaviour, and it broke a backend test that relied on the old one
(see the changes above). The changelog covers it only implicitly under "an
accepted unpair or pairing that failed after its response"; one explicit line
— "the responder now reports `PairingCompleted` even when its `PairResponse`
could not be sent" — would help anyone who, like the app, reacted to the
error.

### R2-6. `communication_info: null` still refused, next to a `weight` that accepts it

Round 1's item 6 is unchanged: in `interop/recovered_secret.rs`,
`HelperIn.communication_info` is `HashMap` with `#[serde(default)]`, so an
explicit `null`/`undefined` fails `restore`. The new `weight` field on the same
struct is `Option<u32>`, documented "Absent or `null` is `1`". Two neighbouring
optional fields now follow two rules. Suggestion as before: `Option<HashMap>`
(or a `deserialize_with` mapping `null` to empty).

---

# Round 1 — 2026-10-21

Library under test: local `../lib-derec`, branch
`feature/leaf_separator_and_padding`, commit `6d073a8` ("Support for weighted
helpers") **plus the staged changes** on top of it (subshares rename,
`DeRecProtocolConfig` / `with_config`, `with_max_subshares`, own transports out
of the builder typestate). Still versioned `0.0.9`, unpublished (registries are
on 0.0.8).

"Before" is lib-derec `0a7daf6` ("Binaries for v0.0.9 release"), which is what
the app (and the `derec/reference-app:0.0.9-local` image) ran yesterday.

## Result in one paragraph

The app works as before against the new library once two compile-level
adaptations are made (below): every suite is green. The app does not use
weights, so every helper still gets one subshare and nothing about thresholds
changes. The new library is **not wire-compatible with the previous 0.0.9
build**, which is documented and expected (finding 1: old shares still verify
but no longer recover). Mixing builds did expose a latent bug that is worth a
look: a helper that cannot validate a peer's share stores it anyway and never
answers, even with `auto_respond_on_failure` enabled (finding 2).

## What was run

| Check | Result |
| --- | --- |
| WASM package rebuilt (`wasm-pack build --release --out-dir target/pkg-web --target web`, `prepare-web-package.mjs`, `npm pack`) and reinstalled | ok |
| Backend `cargo build --all-targets`, `cargo clippy --all-targets` | clean after the adaptations below |
| Backend `cargo test` | all pass (354 unit + every integration binary) |
| Web `tsc -b`, `eslint .` | clean |
| Web `vitest run` | 104 files / 1237 tests pass |
| Playwright e2e (one backend, Chrome) | **81 passed, 4 skipped, 0 failed** (11.3 min); the 4 skips are the LAN-gated specs, as always |
| Upgrade: vault protected on the old build, then the owner's browser upgrades, then the node upgrades on the same DB | see finding 1 |
| Cross-build: old owner ↔ new helpers, and new owner ↔ old helpers | see findings 2 and 3 |

## Changes made in the app

- `apps/backend/src/infrastructure/actors/protocol.rs`: `DeRecProtocolBuilder`
  lost its 7th type parameter (`OwnTransport`), and the app names the
  parameters in `configure_builder`. Dropped the parameter. Because
  `with_own_transports` no longer moves the typestate, it now sits in the shared
  settings helper with every other setting. Behaviour is unchanged.
- `apps/backend/tests/replica_{mirror_routes,second_admission}.rs`:
  `DeRecFlow::ProtectSecret` gained a required `weights` field; the two
  struct literals pass `Default::default()`.
- `apps/web/package-lock.json`: new integrity for the rebuilt tarball. The file
  name is unchanged because the version is still 0.0.9.
- Recovery wording (`src/vault/fold/recovery.ts`,
  `src/owner/CorruptShareWarnings.tsx`, help page 06, CHANGELOG, plus a unit
  test). For a `Malformed` share the app used to say "an honest helper never
  does this — damaged or compromised; consider unpairing it" and "pair with more
  helpers and try again". Finding 1 shows a perfectly honest helper produces
  exactly this after an SDK upgrade, and both pieces of advice are wrong then.
  The app now names the upgrade cause and suggests protecting a new version.
  `InvalidProof` and `Inconsistent` keep the old wording.

## Findings

| # | Area | Severity | Kind |
| --- | --- | --- | --- |
| 1 | Shares from before the format change verify ✓ but cannot be recovered | — | **Expected** (share-level breaking change; closed 2026-10-21) |
| 2 | A share that fails validation is **stored anyway** and **never answered** (store-before-validate in `accept`; error escapes the auto-respond hook) | Medium | Bug — latent since June (#35), surfaced by the format change |
| 3 | Two wire-incompatible builds both identify as 0.0.9 | Low | Process |
| 4 | Rust source breaks not flagged as breaking | Low | Docs / API |
| 5 | TypeScript surface: `weights` keyed by `bigint` while events use `string`; error `code` untyped | Low | API ergonomics |
| 6 | Previous handoff item (`communication_info: null` in `restore`) | Low | Still open, unchanged |

### 1. Old shares verify ✓ but cannot be recovered

> **Status: expected.** The maintainer confirmed this is part of the breaking
> change at the share level, not only in code. Kept here for the record; the
> app's recovery wording was adjusted so a `Malformed` share is not blamed on
> the helper.

**What happens.** A vault protected on the old build, then upgraded:

| Step | Owner on new web, helpers on **old** node | Owner on new web, helpers on **new** node (same DB) |
| --- | --- | --- |
| Verify Shares (v1) | **2/2 verified ✓** | **2/2 verified ✓** |
| Discover All | v1 offered by both helpers, READY | same |
| Recover v1 | both shares "set aside (Malformed)", INCOMPLETE | same |
| Protect v2, recover v2 | — | **recovered** |

Verification is a SHA-384 over the bytes the helper holds, checked against the
owner's own copy of the same bytes. Neither side decodes the share, so a share
in the old `DeRecShare` layout (`x = 2, y = 3, secretId = 4, version = 5`)
still passes. Recovery is the first place the share is decoded, and the new
layout (`repeated Subshare subshares = 2, secretId = 3, version = 4`) fails
there. The owner therefore sees a healthy vault right up to the moment it needs
it.

Two smaller observations:

- The changelog says "a helper still holding one cannot answer a recovery
  request for that version". That is not what we observed. The helper answers
  with the stored bytes, and the **owner** sets them aside as `Malformed`.
  Recovery then reports "not enough shares" rather than refusals.
- `RecoveryShareCorrupted { reason: Malformed }` is the only signal, and it
  cannot tell format drift from a malicious or damaged helper. The app has to
  guess, and its old wording told the owner to unpair healthy helpers.

**Reproduce.**

1. Build the "before" node and web package from lib-derec `0a7daf6`. For
   example, `git -C lib-derec archive 0a7daf6 | tar x -C <dir>/lib-derec` and
   `git -C reference-app archive HEAD apps/backend | tar x -C <dir>/reference-app`,
   then `cargo build` in `<dir>/reference-app/apps/backend`; the web package
   comes from the same archive with the usual `wasm-pack` / `npm pack` steps.
2. Run the old backend with `DEREC_DATABASE_URL=<file>` and serve the app with
   the old package. Set up a vault, pair two provisioned helpers, add a secret
   (v1), then Verify Shares → 2/2.
3. Serve the app with the new package on the **same origin**, so it keeps the
   same IndexedDB. Reload, then Verify Shares → still 2/2 ✓. Recovery → Discover
   All → Recover v1 → both helpers "set aside (Malformed)".
4. Optionally, stop the old backend and start the new one on the same DB file.
   The result is identical.
5. Add a secret (v2), then recover v2: it works.

(The scripted version used here was a Playwright spec that swaps the Vite
server and backend binaries between phases.)

**Suggestions (for discussion).**

- The owner holds its own copy of each committed share. It could decode that
  copy when it verifies, or once at startup, and report a distinct verdict such
  as "held, but in a format this version cannot read" instead of `ShareVerified`.
- Alternatively, a distinct `CorruptionReason` (e.g. `UnsupportedFormat`) for a
  share that fails to decode under the current schema but decodes under the
  previous one would let applications give the right advice.
- An explicit format or version marker in `DeRecShare` would make the next
  change of this kind detectable rather than a decode failure.
- At minimum, the changelog's "Breaking — shares made before 0.0.9 are no
  longer readable" could say outright that **verification keeps passing** for
  those versions, since that is what makes the break dangerous in practice.

### 2. A share that fails validation is stored, and the owner is never told

**Summary.** On the helper, `handlers::sharing::accept` **saves the inbound
share first and validates it afterwards**. When validation fails, the error is
returned from `accept`, and from there it propagates out of `apply_auto_accept`.
That is outside the only place `auto_respond_on_failure` is wired
(`handlers::handle`). The result:

1. the helper keeps a share it has just judged invalid,
2. no `StoreShareResponse` goes back, so the owner waits out the round
   ("No answer" after about 60 s) instead of getting a `ShareRejected` with a
   reason,
3. `process()` returns `Err`, and the `AutoAccepted` event plus any later events
   in the same batch are dropped.

The same happens on the manual path (`protocol.accept(action)`), because it
calls the same `accept`.

This is **not new**. The order has been the same since `4ed9f9e` (#35,
2026-06-17). The subshares format change only made it easy to trigger, because
every cross-build share now fails to decode.

#### Call path (helper side, current branch)

```
process()                                             protocol/process.rs:118
└─ handle_message → process_inner                     process.rs:155 / :226
   ├─ process_channel_message
   │  └─ handlers::handle(…, auto_respond_on_failure)  handlers/mod.rs:76
   │     └─ sharing::handle → on_request               handlers/sharing.rs:39 / :581
   │        size-range check only, then
   │        Ok([ActionRequired { StoreShare }])   ← no error, so the hook at mod.rs:163 never fires
   └─ apply_auto_accept                               protocol/actions.rs:279
      └─ accept_inner(action).await?                  actions.rs:294 / :439
         └─ sharing::accept                           handlers/sharing.rs:348
            1. shares.load(this version)              :367
            2. shares.save(… bytes: encoded_request)  :421   ← stored, unvalidated
            3. keepList pruning                       :461   ← may delete older, valid versions
            4. sharing_response::produce(…)?          :487
               └─ validate_produce_inputs             primitives/sharing/response.rs:361
                  CommittedDeRecShare::decode / validate / DeRecShare::decode / vss::verify
                  → Err(ProtobufDecode | Invariant("…Merkle proof verification failed"))
            (the response is never built; nothing is sent)
```

`handlers::handle` only auto-responds to an `Err` from the dispatch itself
(`mod.rs:163`). `on_request` never fails for a bad share, because it only checks
the size range, and the decode or proof failure happens later, inside `accept`.

#### Evidence from the reference app

The setup was an owner on a pre-change web build pairing two provisioned
helpers on a node built from the current branch (and the reverse, with the same
result). Fixtures are built with `with_auto_respond_on_failure(true)` and
`AutoAcceptPolicy::all()`.

- The node logs `actor process() failed … error=protobuf decode error` for both
  helpers, and then no message is delivered to the owner's inbox.
- The owner sees "0 of 2 confirmed · 2 no answer" about 65 s later, and its bag
  is rolled back.
- The helpers' `shares` table afterwards still holds v1 for both channels:

```
actor_id                              channel_id            version  len
cf5cd9b3-f1fa-43b8-81b6-642119d1672a  5791084960042323404   1        1268
e2789fff-f2a9-44ac-88ed-a6cc0e200828  16201273491447240177  1        1272
```

(The same actor ids appear in the two `process() failed` lines.)

#### Why the stored share matters, not only the missing reply

- **Discovery and recovery will offer it.** The helper now answers
  `GetSecretIdsVersions` with a version whose share it refused to acknowledge,
  and hands those bytes over at recovery, where the owner sets them aside as
  `Malformed`.
- **It can block a correct share at the same version.** A later
  `StoreShareRequest` for that version with different bytes hits the
  "different share already stored" branch (`:389`) and is refused as
  `VersionConflict`. A byte-identical resend hits the idempotent branch
  (`:410`), re-runs `produce`, and fails again, so it is never acknowledged.
  Whether the owner actually reuses the version after a failed round depends on
  whether its snapshot advanced; I did not verify that.
- **`keepList` pruning runs before validation** (`:461`), so an invalid share
  carrying a `keepList` can make the helper delete older, valid versions it was
  holding.

#### Same-build triggers (no version mismatch needed)

Anything `validate_produce_inputs` rejects:

- `share` that does not decode as `CommittedDeRecShare`;
- `de_rec_share` empty (`CommittedDeRecShare::validate`) or not decoding as
  `DeRecShare`;
- a share with no subshares or a repeated x-coordinate (rejected by
  `vss::verify` as of this change);
- a Merkle path that does not verify, whether from a buggy or a malicious owner.

So this is reachable by any authenticated owner. A misbehaving owner can make a
helper persist arbitrary bytes under a version, and possibly evict valid older
versions through `keepList`, while the helper reports only an error to its own
application.

#### Minimal reproduction (library-level, suggested)

On a helper built with `with_auto_accept(AutoAcceptPolicy::all())` and
`with_auto_respond_on_failure(true)`, paired with an owner over channel `C`,
`process()` an encrypted `StoreShareRequest { share: b"not a share", version:
1, … }` on `C`. Observed today:

- `process()` returns `Err(ProcessError { source: ProtobufDecode, … })`;
- `share_store.load(secret_id, C, &[1])` returns the request;
- the transport recorded nothing.

The same with a well-formed `CommittedDeRecShare` whose Merkle path is wrong
gives `Invariant("CommittedDeRecShare Merkle proof verification failed")` and
the same three observations. The existing `process.rs` tests
`enabled_sends_a_failure_response_and_still_errors` /
`disabled_sends_nothing_and_still_errors` show the harness shape. Their
failing request is caught at the role gate inside `handlers::handle`, which is
why they pass while this path does not.

In the reference app: run `0a7daf6` and the current branch as two nodes, put the
owner on one and the helpers on the other, then add a secret.

#### Suggestions (for the library owner to weigh)

- **Validate before storing.** Validation could move to the top of `accept`,
  before `load`/`save`/pruning. An alternative is to call
  `validate_produce_inputs` (or a `validate` split out of `produce`) in
  `on_request`, before `ActionRequired` is raised, next to the size-range check.
  The second option has two advantages:
  - an invalid share never reaches the application's accept/reject gate at all;
  - the error comes out of `handlers::handle`, where the existing auto-respond
    hook already covers it.
- **Answer it.** A share that fails validation could get a `StoreShareResponse`
  with a non-OK status (e.g. `Rejected`, or a more specific status if the enum
  has one), so the owner sees `ShareRejected { status, memo }` immediately. That
  is presumably what `auto_respond_on_failure` is meant to cover. Arguably an
  invalid share deserves a reply even with the setting off, as the size-range
  check already does unconditionally.
- **Auto-accept failures and the hook.** More generally, errors raised inside
  `apply_auto_accept` (any action kind) bypass `auto_respond_on_failure`. It
  may be worth deciding whether the hook should wrap the auto-accepted action
  too, and whether one failing auto-accept should drop the rest of the batch's
  events.
- **A regression test** along the lines of the reproduction above, asserting
  that nothing is stored and that a rejection is sent.

### 3. Two incompatible builds both say 0.0.9

Pre- and post-change builds share version `0.0.9`, and between them pairing
works but sharing silently does not (finding 2). Because 0.0.9 is unpublished,
this only affects local builds: the Docker image built yesterday, the app's
tarball, and anyone who built from the branch. One option is a pre-release
identifier on local builds (`0.0.9-dev.N`). Another is noting in the changelog
that builds from before `6d073a8` are not interoperable with the release.

### 4. Rust source-level breaks

- `DeRecFlow::ProtectSecret` gained a required `weights` field, so every
  struct-literal caller stops compiling (the app had two, in tests). The
  changelog lists weights as a feature ("an empty or absent map is unchanged
  behaviour"). That is true on the wire, but not in Rust source.
- The builder's 7 → 6 type parameters are called out, with the note that
  nothing named them. The app did name them (in a helper generic over the
  slots), so that case does occur in practice.

Suggestion: mark both as "breaking (Rust source)" in the changelog. Optionally,
make `ProtectSecret` construction future-proof with a constructor, or
`#[non_exhaustive]` plus a builder.

### 5. TypeScript ergonomics

- `ProtectSecretParams.weights` is a `Map<bigint, number>`, while every event
  (`ProtectSecretStarted.channel_id`, …) carries channel ids as `string`. An
  app that builds weights from what it has seen must convert.
- `DeRecError.code` is typed `string`, so the new `invalid_weight` and
  `too_many_subshares` are only discoverable from docs. A string-literal union
  of codes would let `switch` statements be checked.

### 6. Still open from the previous 0.0.9 handoff

`restore` still rejects an explicit `communication_info: undefined/null`
(`interop/recovered_secret.rs` is unchanged); see `docs/sdk-0.0.9-handoff.md`
item 1. The app's workaround remains in place.

## Notes for the app if it adopts the new features (done in Round 2)

- Weights: `ProtectRoundProgress.tsx` computes "threshold met" as
  `confirmedCount >= threshold`. With weights, threshold counts subshares, so
  the app would have to switch to the round's `SharingComplete.threshold_met`.
  The `weight` on `ProtectSecretStarted` / `ProtectSecretFailed` could show on
  the per-helper progress rows.
- `withConfig` could replace the backend's hand-written builder chain in
  `configure_builder` with a `DeRecProtocolConfig` built from the node config.
- `withMaxSubshares` has no use until weights are exposed.

## Round 4 (2026-10-23): Docker build against the current branch

### R4-1. Declared MSRV no longer builds

`derec-library` declares `rust-version = "1.88"`, but
`library/src/protocol/obligation.rs:505` uses an `if let` guard in a `match`
arm (`(Err(error), Some(obligation)) if let Some(sent) = obligation.answered()`),
which is newer than that. The app's image pins `rust:1.89-bookworm` and fails
with `error[E0658]: 'if let' guards are experimental`. Either raise
`rust-version` to the release that stabilised the feature (and say so in the
changelog, since the app's Dockerfile and anyone on 1.88/1.89 break), or
rewrite the arm as a nested `if let` inside the match arm. The app's local
test image was built with `rust:1-bookworm` to work around it.

The rebuilt web tarball's public `.d.ts` is identical to the previous build's.
Only the WASM changed, and the app's `tsc` and 1351 vitest tests pass on it.
