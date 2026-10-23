# DeRec SDK 0.0.8 handoff

As of 2026-10-07. Validated against the local, unreleased lib-derec 0.0.8 (rand 0.10, OS randomness, ML-KEM seed keys; commit 780dcfb plus the staged changes).

## Validation summary

No regressions. The reference app needed no code changes for 0.0.8.

| Check | Result |
| --- | --- |
| Backend tests (514) and clippy | Pass |
| Web type-check, lint, unit tests (1174) | Pass |
| Full e2e (75 passed, 4 skipped) | Pass |
| Upgrade: 0.0.7 database and browser state reopened on 0.0.8 | Pass. All three pairings left pending on 0.0.7 completed, including a browser contact whose key the 0.0.7 WASM held; shares stored on 0.0.7 verified 4/4; new rounds, recovery across both eras, restore and replica mirroring work |
| Mixed 0.0.7 ↔ 0.0.8 nodes | Pass. Every contact mode and transport (incl. gRPC relay across nodes), both directions, including 0.0.7 helpers pairing against 0.0.8's 64-byte seed keys |

The expanded-key deprecation warning is not visible in the app: it builds the SDK without the `logging` feature.

| # | Item | Kind | Status |
| --- | --- | --- | --- |
| 1 | Restoring with a replica_id the group does not name fails as a generic invariant | API / error typing | New |
| 2 | Recovery cannot be targeted at the helpers that hold a version | Design | Carried over from 0.0.6 item 11; mitigated in 0.0.7 |
| 3 | Discovery omits the round published right after a replica is paired | App bug (fixed); SDK API gap noted | Resolved app-side |
| 4 | Restoring into a replica group: which `replica_id`, and takeover of the source | Design / docs | New |

## 1. Restoring with a replica_id the group does not name fails as a generic invariant

**Where.** `library/src/protocol/handlers/restore.rs` (~L121 and L166–171) documents that the application must configure a `replica_id` that the restored replica group names. When it does not, nothing fails at restore; the first publish afterwards fails with `internal invariant violated: replica group has members but this device holds no row of its own (invariant)`, and every later publish fails the same way.

**What happens.** The reference app restored on a new device with a fresh replica id (its bug, being fixed app-side). The SDK accepted the restore and then refused every publish with an `Invariant` error that does not say what the application did wrong or how to recover.

**Reproduce.** Vault with 3 helpers and a hosted replica; protect. On a fresh device: new vault, pair and link the same helpers, discover, recover, restore from bag with a replica id that is not in the snapshot's roster, then publish.

**Suggested fix.** Validate the configured `replica_id` against the restored roster in `restore` and return a typed error there (e.g. `ReplicaIdNotInGroup { expected: [...] }`), or expose a typed variant from `process`/`start` instead of `Invariant` (the check is `handlers/sharing.rs:701-712`, `group_channel_of`, raised at `:711`), so applications can detect and explain it. The reference app now duplicates the check before publishing (`apps/web/src/vault/replicaMembership.ts`) only because the SDK's error cannot be told apart from a real invariant.

## 2. Recovery cannot be targeted at the helpers that hold a version

Carried over (0.0.6 item 11). `RecoverSecretParamsJson { secret_id, version }` (`library/src/interop/ffi/protocol/flow.rs`) still has no target list, unlike UpdateChannelInfo, Discovery and Verify. 0.0.7 mitigates it (a helper without the version answers `UNKNOWN_SHARE_VERSION`, reported as `RecoveryShareRefused`), so it is noise, not a failure.

**Question for the SDK.** Add an optional `target` to the recover-secret params?

## 3. Discovery omits the round published right after a replica is paired

**Verdict.** Not an SDK defect. It was the reference app's `keepList`, now fixed. The SDK side has one API gap worth knowing about (below), but it behaves as documented.

**Where.** App: `apps/web/src/vault/runtime.ts` (`keepList`) and `apps/web/src/vault/keepList.ts`. SDK, for context: `library/src/protocol/fingerprint.rs` (`verify_fingerprint`, the promotion publish) and `library/src/protocol/sweeps.rs` (~L520, `SharingComplete` waits for `pending_replicas` too).

**What happens.** Confirming a replica's fingerprint makes `verify_fingerprint` publish v3 itself. It goes to every paired helper (they store it) and to the replica. The library keeps v3's `SharingRound` open until the replica leg also resolves, so it can stay open after every helper has confirmed. The app answers `keepList` from its own committed bag plus the rounds *it* started. v3 was neither, so when the user added a secret (v4) before v3 closed, v4's list was `[2, 1]` and every helper deleted v3 when storing v4. v3 committed a moment later on the old device, but no helper held it any more, so Discover All on a new device listed v4, v2, v1. The version number is the same on 0.0.7 and 0.0.8 because the app's rule, not the SDK, dropped it.

**Reproduce.** Old device: 3 helpers (min 2), protect S1 (v1), protect S2 (v2), add and confirm a hosted replica (library publishes v3), protect S3 at once (v4). New device: pair and link the same helpers, Discover All. Before the fix, the Console showed `Round v4: helpers keep v1, v2, v4` logged before `Sharing round v3 complete`, and discovery listed v4, v2, v1. After it: `helpers keep v1, v2, v3, v4` and v4, v3, v2, v1.

**Fix (app).** `keepList` now also lists every round the library holds open, read from the app's own state store (`SharingRound` rows, kind 3, keyed by version; `openSharingRoundVersions` in `apps/web/src/stores.ts`). The library removes a row when the round completes or times out, so a round that did not commit stops being kept on the next publish. Covered by `vault/runtimeKeepList.test.ts` and `stores.test.ts`.

**SDK API gap (not a defect).** `verify_fingerprint` drops the events of the round it starts: `start_protect_secret(...).await?` is discarded and the call returns only `bool` (WASM `verifyFingerprint` included). An application cannot see that round's `ProtectSecretStarted` events or even its version, only the later `ShareConfirmed` / `SharingComplete`. Returning the events (or the version) would let applications track it like any other round instead of reading the state store. Worth raising, not blocking.

## 4. Restoring into a replica group: which `replica_id`, and takeover of the source

**Where.** `library/src/protocol/handlers/restore.rs:121-123` and `166-171`, and `flows.rs:183-189`, say only that the application must configure "a `replica_id` the roster names". They do not say which one. The replica design spec marks takeover on restore as deferred (D2, D7).

**What the reference app does now.** When the device restoring is already in the roster (same device), it keeps its id. Otherwise it takes the **Source** member's id, on the reading that the new device replaces the lost source, and never a Destination's id, since that member is another live device (`apps/web/src/vault/commands/restoreReplicas.ts`). With that, a restored device publishes and the replica acknowledges.

**The open problem.** If the old source device is in fact still running, it and the restored device both answer to the group under the same `replica_id`, and nothing in the SDK settles which one wins. The app's Help tells users to keep only one of them publishing.

**Question for the SDK.** Should `restore` offer an explicit "adopt the source's identity" option (and tell the group the old one is superseded), or should the docs state the rule above as the supported behaviour and the dual-source risk?

## 5. `rust-version = "1.88"` is not what the 0.0.8 crates build with

**What.** `derec-library` and `derec-proto` 0.0.8 declare `rust-version = "1.88"`, but a fresh resolve of their dependencies needs 1.89: `derec-cryptography` 0.0.8 → `aes-gcm` 0.11.1 → `aes` 0.9.3 (rust-version 1.89), and the `ark-*` 0.6 crates → `educe` 0.6 → `enum-ordinalize` / `-derive` 4.4.2 (1.89). With rustc 1.88 cargo refuses: `rustc 1.88.0 is not supported by the following packages`.

**How it surfaced.** The reference app's Docker image built on `rust:1.88-bookworm` (pinned to the SDK's declared floor) and failed in the dependency layer. Local builds never noticed because they run a newer toolchain. The app now pins 1.89 in its Dockerfile and `Cargo.toml`.

**Ask.** Either raise the SDK crates' `rust-version` to 1.89, or keep 1.88 and constrain the crypto dependencies (e.g. `aes-gcm` / `ark` versions) to ones that build on it, and add a CI job on the declared floor so the two cannot drift again. Not blocking.

## Released SDK 0.0.8 (crates.io / npm, 2026-10-07)

The app now uses the published `derec-library` / `derec-proto` 0.0.8 and `@derec-alliance/web` 0.0.8. The release tag's `library/`, `cryptography/`, `protobufs/` and web typings are identical to the tree validated above, and the app's suites pass on the registry builds. Items 1, 2, 4 and 5 above remain open; item 3 was an app bug, now fixed.
