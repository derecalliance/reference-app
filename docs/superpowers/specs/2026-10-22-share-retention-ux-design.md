# Owner controls for weights, thresholds, retention and cleanup — design

Date: 2026-10-22. Status: approved by the owner ("build it based on what we agreed; when in doubt use your criteria"). App: DeRec reference app (`apps/web` React + MUI front end,
`apps/backend` Rust/Axum). SDK: local lib-derec 0.0.9 (unreleased, uncommitted
tree; see `../lib-derec/CHANGELOG.md` 0.0.9 and
`../lib-derec/docs/handoffs/2026-10-22-share-retention.md`).

## Intent

The reference app exists so developers integrating DeRec can see every SDK
flow working end to end and copy how it is done. lib-derec 0.0.9 turned
several things that used to be fixed into **application decisions**: how many
subshares each helper holds, the threshold a version is split with, which
versions helpers keep, and when an owner's stored verification copies are
deleted. The app must expose **every one of those flows in the UI**, made
visibly by the owner, and must stay correct underneath them.

The owner's words: "This is a reference app, so all flows must be present."
"Focus on correctness, but also adding all the capabilities to the UI." "The
protocol must enforce most of the rules, so be confident" — the app validates
for good feedback, but leans on the SDK's own errors rather than duplicating
every rule defensively.

## Goals

1. **Correctness first** (prerequisite to everything below):
   - Browser and backend share stores persist the new `Share.subshares` and
     `Share.threshold` fields; the user-secret store persists
     `UserSecrets.threshold`; state rows keep `threshold` and `keep_list`
     (opaque-JSON stores need no change — verify each store's shape).
   - Backend SQL: a migration adding nullable `subshares` and `threshold`
     columns to the shares table and `threshold` wherever user secrets are
     stored; `SqlShareStore` / user-secret store read and write them.
   - Every app-side threshold decision (publish gates, round progress,
     early-commit, rollback-on-timeout, pending-round notice) uses **the
     round's own threshold**, never the vault setting alone.
   - `restore` carries the recovered roster's threshold (and weights, already
     done) and the app's view of the vault follows it.
   - Compile/adapt to the remaining 0.0.9 API changes (new `ProtectSecret.threshold`,
     new event fields) on both halves.
2. **Default weight per helper** — set on the Channels list.
3. **Per-publish overrides** — weights and threshold, in every publish dialog.
4. **"Versions helpers keep"** — a vault setting (keep last N, or select) and,
   at publish, a legend or a picker.
5. **Cleanup of old verification copies** — a vault setting (automatic by a
   criterion, or manual) and a manual "Clean up" flow.
6. **Recoverability per version** — verified subshares against that
   version's own threshold.
7. **Restore or join** — after recovery, offer joining the live replica group
   as an alternative to restoring.
8. Help pages, CHANGELOG, unit tests and e2e coverage for each flow.

## Non-goals

- Changing lib-derec. Any SDK gap found goes into the SDK report
  (`docs/sdk-0.0.9-weighted-helpers-report.md`), never patched here.
- Deleting shares this device holds **for other owners** (helper-side rows).
  They are someone else's data; the protocol's keep-list governs them. The UI
  says so instead of offering a delete.
- Backfilling `subshares`/`threshold` onto rows stored before this change.
  The SDK reports them as unknown; the app shows "unknown".
- Backend/provisioned-helper UI for these settings. Provisioned actors keep
  their current automatic behaviour; their mirrored proofs are covered only
  by the backend log (see "Left to the builder").

## Anti-goals

- Hidden defaults: every decision the SDK hands the application must be
  visible where it is made (a legend, a field, a log line), not buried.
- The app and the SDK disagreeing about whether a round succeeded (the class
  of bug weights already caused once: helper count vs subshares).
- A delete that can lose the ability to verify the **latest** version.

## The flows, as decided

### 1. Default weight per helper (Channels list)

- Each paired helper row (owner side, share targets only) shows an editable
  **Default weight**, `1 … threshold − 1` against the vault's default
  threshold, `1` unless changed.
- It is an **app-level preference** stored with the vault (per helper channel
  or participant); it sends nothing and changes nothing in the library by
  itself.
- The row also shows the weight the library last published with
  ("Default 2 · last published 3") when they differ, because the library's
  own publishes (after pairing a helper, after a fingerprint confirmation)
  reuse the **last published** weights, not the app's defaults.

### 2. Per-publish overrides (Add Secret, Remove Secret, and every publish dialog)

- Each publish dialog lists every share-target helper with a weight field
  pre-filled from its **default weight**, overridable for this publish only.
  The next publish pre-fills from the defaults again.
- The dialog has a **threshold** field pre-filled from the vault's default
  (the value chosen at creation, or a remembered one). Overridable for this
  publish.
- If the owner changed the threshold, publishing asks **"Remember this
  threshold for future publishes?"**; yes updates the vault's default.
- *(My call, consistent with weights.)* "No" means the vault default stays a
  **dialog pre-fill only**. The SDK still stores the round's threshold, and the
  library's own publishes (after pairing, after a fingerprint confirmation)
  use that stored value — so, as with weights, the UI shows both where they
  differ: "Default threshold 3 · last published 4" (vault settings and the
  Secrets tab). Default weights are validated against the threshold in the
  dialog that uses them, not against a fixed value.
- Validation shown live (the SDK enforces it too): threshold ≥ 2, every
  weight `1 ≤ w < threshold`, total weight ≥ threshold (below it no version
  could be split).
- The existing standalone **Helper Weights** dialog is replaced by a
  **"Republish with defaults"** action (same republish path, pre-filled from
  defaults, same retention legend/picker) for applying changed defaults
  without changing secrets.
- What the round actually sends is the full assignment (the SDK's map is a
  full assignment, not a patch).

### 3. Versions helpers keep

- **Vault setting:** "Versions helpers keep":
  - **Keep last N versions** — N a number, default 3 (today's behaviour).
    Every publish's keep-list = the N newest committed versions plus any round
    still open (as today), plus the version being sent (the SDK adds it).
  - **Select at each publish** — no standing rule.
- **At publish:**
  - In "keep last N" mode: a legend naming the actual versions, e.g.
    "Helpers will keep v4, v5, v6 and this new version; v3 will be dropped
    (keep last 3 — change in vault settings)". Naming what is **dropped** is
    required.
  - In "select" mode: a checklist of the committed versions; the new version
    is always kept and locked; open rounds stay kept (and are shown as kept,
    locked) because dropping one could lose a version that later commits.
- The chosen list is what the app's `keep_list(secret_id, version)` store
  callback returns for that round, so it must be resolvable by version when
  the SDK asks.
- *(My call.)* Rounds with no dialog — the publishes the library starts on its
  own, and any round the app did not record a selection for — in **select**
  mode return **no keep-list** (`null`: helpers keep everything). Nothing is
  ever dropped without the owner having chosen it. The Console says so for
  each such round ("no keep-list sent: select mode, no selection for vN").

### 4. Cleanup of old verification copies

Terminology in the UI: a **verification copy** is the record this device keeps
of exactly what it sent (or, on a replica, mirrored) to a helper for a
version. Deleting one never affects recovery; that version just can no longer
be verified from this device (`VerifySharesFailed { NoProof }`).

- **Vault setting:** "Old verification copies":
  - **Automatic**, with a criterion:
    - **Follow the retention rule** (the handoff's safe policy): after a new
      version is stored or mirrored, keep only the versions the keep-list for
      that version keeps (plus that version).
    - **Keep the last N versions** (independent N).
  - **Manual** — nothing deleted automatically.
- **Manual "Clean up" flow** (available in both modes): lists every stored
  version with how many copies each holds and the storage it uses;
  pre-selects what the chosen criterion would remove; owner adjusts; confirm.
- **Always:** the latest version's copies are never deletable; helper-side
  rows (shares this device holds for others) are never listed for deletion.
- **Applies to:** replica destinations (the main case — the SDK never deletes
  there) and the publishing device (the SDK already prunes; manual cleanup
  goes further).
- *(My call.)* Settings are **per device**, not synced across a replica group
  — the SDK carries weights and threshold in the roster, but not the app's
  retention or cleanup choices. Vault settings says so. On a device whose
  "Versions helpers keep" is **select**, the cleanup criterion "follow the
  retention rule" has no rule to follow and **keeps everything** (it says so
  in the setting and in the Clean up preview); "keep the last N" still works.
- Every automatic cleanup is logged to the Console naming what was removed.

### 5. Recoverability per version

- Verifying a version shows, per helper, its subshares **for that version**
  (`ShareVerified.subshares`) and the version's own threshold
  (`ShareVerified.threshold`), and a verdict: "v5 recoverable — 4 of 3
  subshares verified" / "not recoverable from verified helpers alone — 2 of
  3" / "unknown" when any value is absent (versions published before this
  SDK change).
- Each version (current and previous) displays its threshold and each
  helper's weight for that version.

### 6. Threshold as data

- Each version shows its own threshold. The vault's "Minimum" setting is the
  default for the next publish, not a statement about existing versions.
- After restore, the next publish's default is the recovered roster's
  threshold (the SDK stores it); the app's vault default follows it.

### 7. Restore or join

- After recovery, if the recovered vault lists live replica members, the
  owner chooses **Restore** (today's flow: rebuild this device from the
  recovered copy) or **Join** (pair with a live replica and receive the vault
  from it). Each option explains what it keeps and loses, per the library
  README section "Recover, then restore or join" and
  `../documentation/concepts/replicas/restore-or-join.md`.
- *(My call, owner said "use your criteria".)* **Join** is offered whenever the
  recovered roster names a replica member other than the lost device. Choosing
  it turns the recovering vault into a **replica destination of a live
  member** through the existing replica pairing/adoption path (pair, confirm
  the fingerprint, receive the vault). The lost device is **not** removed by
  the flow; the owner removes it separately (`UnpairReplica`), and the Join
  explanation says so.

## Where things live in the UI (builder's call, recorded)

- **Vault settings** (new): there is no per-vault settings screen after
  creation today (only `wizard/StepVaultSettings.tsx`). Add a "Vault settings"
  dialog reachable from the vault header, holding: default threshold,
  "Versions helpers keep", "Old verification copies". Persist in the vault
  record (`configOverrides` or new vault fields — builder's choice, but they
  are per-vault and survive reloads).
- **Channels list**: default weight per helper row.
- **Publish dialogs**: weights, threshold, retention legend/picker.
- **Secrets tab**: per-version threshold and weights, recoverability on
  verify, "Clean up" entry point, "Republish with defaults".

## Constraints

- No lib-derec changes; never commit (the owner reviews and commits).
- Follow the repo's frontend/backend rules in `CLAUDE.md` (MUI, typed, no
  `any`, layered backend, typed errors, `/api/v1` envelope, CHANGELOG).
- Browser storage is small (localStorage); the cleanup feature exists partly
  because replica copies grow by one per helper per version.
- The app is pinned to local SDK path deps; Docker cannot build meanwhile.

## Left to the builder

- Exact component split, wording, and layout within the places above.
- Storage shape for the new per-vault settings and per-helper defaults.
- How the select-mode keep-list choice is held between dialog and the
  `keep_list` callback (keyed by version).
- *(My call.)* Provisioned replicas on the backend keep every mirrored copy:
  the owner's browser settings never reach the node, and a provisioned
  destination has no keep-list of its own to follow. No backend cleanup code
  this round; the README/help says so.
- Test split between unit and e2e; every flow above needs at least one e2e.
