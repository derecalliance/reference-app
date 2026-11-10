# Owner controls for weights, thresholds, retention and cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every lib-derec 0.0.9 owner decision (weights, threshold, versions helpers keep, cleanup of verification copies, recoverability, restore-or-join) correct underneath and reachable in the reference app's UI.

**Architecture:** Correctness first (stores persist the new SDK fields; round logic uses each round's own threshold), then a per-vault publish policy (`Vault.publishPolicy`) edited in a new Vault Settings dialog and consumed by one shared publish-options panel used by every publish dialog, then cleanup, recoverability and restore-or-join on top.

**Tech Stack:** React + TypeScript + MUI (apps/web, vitest, Playwright), Rust/Axum + sqlx (apps/backend), `@derec-alliance/web` / `derec-library` 0.0.9 from local `../lib-derec` path deps.

**Spec:** `docs/superpowers/specs/2026-10-22-share-retention-ux-design.md`

## Global Constraints

- Never commit or stage; the owner reviews and commits. Every "Commit" step in this plan is replaced by "leave the change unstaged".
- Never modify `../lib-derec`. SDK problems go into `docs/sdk-0.0.9-weighted-helpers-report.md` (a new "Round 4" section).
- The library may still change (another agent). If a library build breaks mid-task, finish UI-only tasks first and come back.
- Default "versions helpers keep" N = 3 (today's `KEPT_COMMITTED_VERSIONS`).
- Weights: integer `1 ≤ w < threshold`; threshold ≥ 2; total weight ≥ threshold.
- The latest version's verification copies are never deletable; helper-side rows (shares held for other owners) are never listed for deletion.
- Read test exit codes from the runner itself, never from a trailing pipeline command.
- Frontend rules in `CLAUDE.md` (MUI, typed, no `any`); backend rules (layering, typed errors). Every user-visible change updates `CHANGELOG.md` top entry and the in-app Help.

## Review Focus

- A vault created before this change (no `publishPolicy`, no per-round threshold): loads with defaults equal to today's behaviour (keep last 3, threshold = `minParticipants`, cleanup manual).
- A restore whose recovered roster has no threshold (pre-change roster): the vault default threshold stays `minParticipants`, nothing crashes.
- Select mode with no recorded selection for a version (library-initiated publish): `keep_list` returns `null`, logged — never an empty list (empty would make helpers drop everything but V).
- A threshold override plus "No" to remember: the next dialog pre-fills the old default while the Secrets tab shows "last published N".
- Cleanup on a version whose copies were stored before 0.0.9 (`subshares`/`threshold` absent): listed and deletable like any other; recoverability shows "unknown".

---

### Task 1: Backend stores persist the new SDK fields

**Files:**
- Create: `apps/backend/migrations/0005_share_subshares_threshold.sql`
- Modify: `apps/backend/src/repositories/sdk/share.rs` (save/`to_shares`), `apps/backend/src/repositories/sdk/user_secret.rs` (`UserSecretsRow`, `into_secrets`), `apps/backend/src/repositories/sdk/conformance.rs` (literals + round-trip assertions)
- Test: `apps/backend/src/repositories/sdk/conformance.rs`, `apps/backend/tests/store_conformance.rs`

**Interfaces:**
- Produces: `shares` gains nullable INTEGER columns `subshares`, `threshold`; `UserSecretsRow` gains `#[serde(default)] threshold: Option<u32>`.

- [ ] Step 1: In `share_store_conforms`, save a `Share { subshares: Some(3), threshold: Some(4), .. }` and assert `load` returns both unchanged; save one with `None`/`None` and assert they read back `None`. In the user-secret conformance, save `threshold: Some(3)` and assert it round-trips.
- [ ] Step 2: Run `cargo test --test store_conformance` → FAIL (compile errors on missing fields).
- [ ] Step 3: Migration `ALTER TABLE shares ADD COLUMN subshares INTEGER; ALTER TABLE shares ADD COLUMN threshold INTEGER;` (valid on SQLite and Postgres). Map both columns in save/load; add `threshold` to `UserSecretsRow` (JSON payload, no migration needed).
- [ ] Step 4: `cargo test` (all) → exit 0; `cargo clippy --all-targets` clean.

### Task 2: Web stores and types adapt to the SDK

**Files:**
- Modify: `apps/web/src/stores.ts` (share store `save`/`readShare`; user-secret store `StoredUserSecrets`), `apps/web/src/owner/recoveredSecret.ts`, `apps/web/src/types.ts` (`RecoveredSecretHelper`/`RecoveredSecretReplica` `communicationInfo?: Record<string,string> | null`, `RecoveredSecretSnapshot.threshold?: number`), `apps/web/src/replicaFlows.ts:73-77`
- Test: `apps/web/src/stores.test.ts`, `apps/web/src/owner/recoveredSecret.test.ts`

**Interfaces:**
- Produces: share meta persisted under a new key `shareMetaV2Key(ns, secretId, channelId, version)` = JSON `{ secretId, subshares?, threshold? }` (read falls back to the old `shareMetaKey` string); user-secret record keeps `author_replica_id` and `threshold`; `RecoveredSecretSnapshot.threshold` carried by `snapshotFromEvent`/`snapshotToPayload`.

- [ ] Step 1: Tests: `makeShareStore` saves `{subshares: 2, threshold: 3}` and `load` returns them; a share saved by the old format (only data + meta string) loads with them absent. `makeUserSecretStore` round-trips `author_replica_id: '7'` and `threshold: 4`. `snapshotToPayload(snapshotFromEvent(x))` keeps `threshold: 4` and a `communication_info: null` reads as absent.
- [ ] Step 2: `vitest run src/stores.test.ts src/owner/recoveredSecret.test.ts` → FAIL.
- [ ] Step 3: Implement; for `replicaFlows.ts:73` replace the exact-equality assertion with one that ignores the nullability of `communication_info` (the SDK types differ: R4-1 in the report) and keeps checking every other field.
- [ ] Step 4: `tsc -b`, `eslint .`, `vitest run` → all pass.

### Task 3: Threshold is per round and per version

**Files:**
- Modify: `apps/web/src/vault/runtime.ts` (`protect`), `apps/web/src/vault/rounds.ts` (`OpenRound`, `beginProtectRound`, `snapshotProtectRounds`), `apps/web/src/types.ts` (`BagVersion.threshold?`, `PendingProtectRound.threshold?`), `apps/web/src/vault/fold/sharing.ts` (`commitOnceHelpersAnswered`), `apps/web/src/owner/ProtectRoundProgress.tsx` callers, `apps/web/src/owner/SecretBagPanel.tsx` (pending notice, per-version threshold), `apps/web/src/vault/commands/restore.ts`
- Test: `apps/web/src/vault/rounds.test.ts`, `apps/web/src/vault/fold/weights.test.ts`

**Interfaces:**
- Produces: `protect(secrets, options: { resolvesReplicaConflict?: boolean; weights?: ReadonlyMap<string, number>; threshold?: number })`; `RoundTracker.roundThreshold(version): number | null`; `BagVersion.threshold?: number` (the round's `t`); restore sets `vault.minParticipants` from `secret.snapshot.threshold` when present.

- [ ] Step 1: Tests: a round begun with `threshold: 4` and confirmed weight 3 does not early-commit while `vault.minParticipants` is 2; the same round resumed from a snapshot keeps `threshold: 4`; a staged bag version records `threshold`.
- [ ] Step 2: Run → FAIL.
- [ ] Step 3: Pass `threshold` to `start(ProtectSecret)` when given; record the resolved threshold (given, else `vault.minParticipants`) on the round and the staged `BagVersion`; every comparison (`settleOverdueRound`, `commitOnceHelpersAnswered`, `dispatchedWeight` check, progress dialogs, pending-round notice) uses the round's threshold.
- [ ] Step 4: `vitest run`, `tsc -b` → pass.

### Task 4: Publish policy model and Vault Settings dialog

**Files:**
- Create: `apps/web/src/owner/publishPolicy.ts`, `apps/web/src/owner/VaultSettingsModal.tsx`, `apps/web/src/owner/publishPolicy.test.ts`
- Modify: `apps/web/src/types.ts` (`Vault.publishPolicy?`), `apps/web/src/vaultPersistence.ts` (`normalizeVault` default), `apps/web/src/OwnerPage.tsx` (header button "Vault settings"), `apps/web/src/vault/runtime.ts` (`updatePublishPolicy(policy)`)

**Interfaces:**
- Produces:
  ```ts
  type HelperRetention = { mode: 'lastN'; n: number } | { mode: 'select' }
  type ProofCleanup = { mode: 'manual' } | { mode: 'auto'; criterion: 'retention' } | { mode: 'auto'; criterion: 'lastN'; n: number }
  interface PublishPolicy {
    defaultThreshold: number                     // starts as vault.minParticipants
    defaultWeights: Record<string, number>       // by channel id; absent = 1
    helperRetention: HelperRetention             // default { mode: 'lastN', n: 3 }
    proofCleanup: ProofCleanup                    // default { mode: 'manual' }
  }
  function resolvePublishPolicy(vault: Vault): PublishPolicy
  function publishPolicyProblems(p: PublishPolicy): Partial<Record<'defaultThreshold' | 'retentionN' | 'cleanupN', string>>
  ```
  `runtime.updatePublishPolicy(next: PublishPolicy): void` commits it. The vault's `minParticipants` stays the creation value; `defaultThreshold` is what publish dialogs pre-fill.

- [ ] Step 1: Tests for `resolvePublishPolicy` (legacy vault → defaults above) and `publishPolicyProblems` (threshold < 2, N < 1).
- [ ] Step 2: Run → FAIL. Step 3: implement model + dialog (MUI form: default threshold; "Versions helpers keep": radio last-N with number / select; "Old verification copies": radio manual / auto with criterion retention | last-N with number; a note that settings are per device and do not sync across a replica group; in select retention mode the "retention" criterion shows "keeps everything"). Step 4: tests pass; component test renders and saves.

### Task 5: Default weight per helper on the Channels list

**Files:**
- Modify: `apps/web/src/owner/PairedParticipantsList.tsx` (`ChannelDetails`), `apps/web/src/OwnerPage.tsx` (pass `defaultWeights`, `onSetDefaultWeight`)
- Test: `apps/web/src/owner/PairedParticipantsList.test.tsx`

**Interfaces:**
- Consumes: `PublishPolicy.defaultWeights`, `participantWeight` (last published, `owner/weights.ts`).
- Produces: props `defaultWeightFor(channelId): number`, `onSetDefaultWeight(channelId, weight)`; the row shows "Default N" editable (1 … defaultThreshold−1) and "· last published M" when M ≠ N. Owner-side share targets only.

- [ ] Steps: failing component test (edit to 2 calls `onSetDefaultWeight('900', 2)`; "last published 3" appears when they differ) → implement → pass.

### Task 6: Publish options panel in every publish dialog; keep-list by policy

**Files:**
- Create: `apps/web/src/owner/PublishOptions.tsx`, `apps/web/src/owner/PublishOptions.test.tsx`, `apps/web/src/owner/RepublishModal.tsx`
- Modify: `apps/web/src/owner/AddSecretModal.tsx`, `apps/web/src/owner/RemoveSecretModal.tsx`, `apps/web/src/vault/keepList.ts`, `apps/web/src/vault/runtime.ts` (`addSecret`, `removeSecret`, `republish`, keep-list selections), `apps/web/src/OwnerPage.tsx`; Delete: `apps/web/src/owner/HelperWeightsModal.tsx` (+ its test) in favour of `RepublishModal`
- Test: `apps/web/src/vault/keepList.test.ts`, `PublishOptions.test.tsx`, `e2e/weights.spec.ts` (update to the new UI)

**Interfaces:**
- Produces:
  ```ts
  interface PublishChoice { weights: ReadonlyMap<string, number>; threshold: number; keep: readonly number[] | null; rememberThreshold: boolean }
  // runtime
  addSecret(name: string, data: string, choice: PublishChoice): Promise<PublishedRound | null>
  removeSecret(secretId: string, choice: PublishChoice): Promise<PublishedRound | null>
  republish(choice: PublishChoice): Promise<PublishedRound | null>
  // keepList.ts
  keepListFor(vault, secretId, version, openVersions, selection?: readonly number[] | null): number[] | null
  ```
  `PublishOptions` renders weights (pre-filled from defaults), threshold (pre-filled from `defaultThreshold`), and the retention part: last-N legend naming kept and dropped versions, or select checklist (committed versions; open rounds and the new version locked kept). On publish with a changed threshold it asks "Remember this threshold for future publishes?" before sending.
  The runtime records the selected keep-list for the round's version before `start` and the `keepList` callback returns it for that version; in select mode with no recorded selection it returns `null` and logs "no keep-list sent: select mode, no selection for vN".

- [ ] Steps: keepList tests (last-N with n=2; select with recorded selection; select without → null) → FAIL → implement; PublishOptions tests (legend names dropped v3 for n=3 with v1..v4 committed... use exact versions; select locks open rounds; remember prompt appears only when threshold changed) → implement; wire dialogs; update e2e weights spec to set weights in Add Secret and defaults on the Channels list.

### Task 7: Recoverability per version

**Files:**
- Modify: `apps/web/src/types.ts` (`BagVersion.verifiedSubshares?: Record<string, number | null>`, `verifiedThreshold?: number | null`), `apps/web/src/vault/fold/sharing.ts` (`ShareVerified`), `apps/web/src/owner/VerifySharesModal.tsx`, `apps/web/src/owner/SecretBagPanel.tsx`
- Create: `apps/web/src/owner/recoverability.ts` (+ test)

**Interfaces:**
- Produces: `recoverability(version: BagVersion): { kind: 'recoverable' | 'short' | 'unknown'; verified: number; threshold: number | null }` — sum of verified subshares vs the version's threshold; any `null` → `unknown`.

- [ ] Steps: fold test (ShareVerified with subshares 2, threshold 3 recorded per participant) and `recoverability` tests (2+2 vs 3 recoverable; 2 vs 3 short; a null → unknown) → implement → UI verdict line "v5 recoverable — 4 of 3 subshares verified" / "not recoverable from verified helpers alone — 2 of 3" / "unknown (published before this app recorded subshares)".

### Task 8: Cleanup of verification copies

**Files:**
- Create: `apps/web/src/owner/proofCleanup.ts` (+ test), `apps/web/src/owner/CleanupModal.tsx`
- Modify: `apps/web/src/stores.ts` (`listOwnerProofVersions(ns, secretId, helperChannelIds): ProofVersionUsage[]`, reuse `removeVersions`), `apps/web/src/vault/runtime.ts` (`cleanupProofs(versions)`, auto cleanup after `SharingComplete` on the publishing device and after `ReplicaSecretInstalled`/`ReplicaSecretReceived` on a destination), `apps/web/src/owner/SecretBagPanel.tsx` (entry point)

**Interfaces:**
- Produces:
  ```ts
  interface ProofVersionUsage { version: number; copies: number; bytes: number }
  function cleanupCandidates(usage: ProofVersionUsage[], latest: number, policy: PublishPolicy, keepForLatest: readonly number[] | null): number[]
  ```
  Never returns `latest`; `retention` criterion returns versions outside `keepForLatest` (and nothing when it is `null`); `lastN` keeps the N newest. Only owner-side rows: channels whose stored `peer_role` is `Helper` in this vault's partition (`listHelperChannels`).

- [ ] Steps: `cleanupCandidates` tests (latest excluded; retention with null keeps all; lastN=2) → implement; `listOwnerProofVersions` test against seeded localStorage (helper-side rows excluded) → implement; runtime auto cleanup logs each removal to the Console; modal lists versions with copies and size, preselects candidates, confirm deletes via `removeVersions` under the protocol lock.

### Task 9: Restore or join

**Files:**
- Modify: `apps/web/src/owner/RecoveryPanel.tsx` (`RecoveredSecretCard` confirmation), `apps/web/src/OwnerPage.tsx`, `apps/web/src/vault/runtime.ts` (`joinRecoveredGroup(memberReplicaId)`)

**Interfaces:**
- Consumes: the existing replica pairing as destination (`pairReplica`/fingerprint/adoption path, `adoptMirroredVault`).
- Produces: when `secret.snapshot.replicas` names a member other than this device's recorded lost source, the card offers **Restore** (existing) and **Join**: an explanation (what each keeps and loses, per the library README "Recover, then restore or join"), the member to join, and then the existing flow that pairs this vault as a replica destination of that member (contact exchange with that device), ending in adoption. The lost device is not removed; the text says to remove it separately.

- [ ] Steps: component test (Join shown only when the roster names another member) → implement; e2e: old device + live replica in two contexts, new device recovers, chooses Join, ends adopted with the secret (reuse `browser-replica.spec.ts` helpers).

### Task 10: Docs, CHANGELOG, full verification, SDK report

**Files:** `apps/web/src/help/content/04-protecting-secrets.md`, `05-verification.md`, `06-recovery-and-restore.md`, `07-replicas.md`, `11-settings.md`, `17-glossary.md`; `CHANGELOG.md`; `docs/sdk-0.0.9-weighted-helpers-report.md` (Round 4).

- [ ] Steps: document every flow; `cargo test` (exit code read directly), `tsc -b`, `eslint .`, `vitest run`, full Playwright suite (read the output file); write Round 4 findings (R4-1 `communication_info` nullability mismatch between `SecretRecovered` and `ReplicaSecretReceived`, plus anything found during the build).
