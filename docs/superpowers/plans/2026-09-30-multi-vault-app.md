# Multi-Vault App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run every vault this tab holds at once — a vault list as the home screen, hash routes to open one, per-vault lifecycle — and tell the user about vaults they are not looking at through banners and badges.

**Architecture:** A React-free `VaultManager` owns one `VaultRuntime` per vault, the per-vault Web Locks, persistence of each vault record, and the one shared roster poller. React subscribes to it: the list renders its entries, and `OwnerPage` stops constructing a runtime and instead *attaches* its view callbacks to the one the manager hands it. Routes are hash routes (`#/`, `#/new`, `#/vault/{id}`); step 5 routes each runtime's notifications through the manager, which turns those from off-screen vaults into clickable banners and aggregates attention into badges.

**Tech Stack:** React 19 + TypeScript + Vite, MUI, Vitest (jsdom), Playwright, `@derec-alliance/web` 0.0.6 (local build).

**Spec:** `docs/superpowers/specs/2026-09-29-multi-vault-design.md` — steps 4 and 5 of its *Sequencing*. Builds on `docs/superpowers/plans/2026-09-29-vault-foundation.md`, whose "Revision note (as executed)" blocks describe the engine as built.

## Global Constraints

- Vocabulary: "Vault" in app, UI, types and storage keys; "Owner" only where it names the protocol role (`Role::Owner`, `POST /owners`, `ConsoleRole`, `peerRole`, `sender_kind`).
- **One owner actor per vault.** No backend changes; no envelope-level routing in the browser.
- **All vaults a tab holds run in the background**; one is displayed.
- **A background vault's confirmation badges; it never raises a modal.**
- **One tab runs everything**; vaults locked by another tab are listed with a **Claim** button. No lock-stealing on a timer.
- **In-app banners only** — no OS notifications, no title/favicon badging.
- **Banners fire only for vaults not on screen.** The on-screen vault reports exactly as it does today; no double-reporting.
- **Hash routing, no router dependency.** `#/` list, `#/vault/{id}` a vault (the vault id — never the `secret_id`). `BASE_PATH` untouched. GitHub Pages must keep working.
- The list must render from storage immediately; rows flip to running as runtimes come up, in parallel.
- A vault that fails to start shows "failed to start" with a retry and must not take down the list or other runtimes.
- Persistence failures (quota) must be surfaced, not swallowed.
- No migration: existing persisted state may be abandoned.
- User commits; never `git commit`/`add`/`stash` (memory: no auto-commit).

## Review Focus

1. **A vault on screen that another tab holds** (`#/vault/{id}` opened in a second tab): the view must say "open in another tab" with Claim, not start a second runtime over the same stores. — Task 5 test.
2. **Removing the vault currently on screen**: route returns to the list; the runtime is stopped before its stores are erased, so no in-flight drain writes into a cleared namespace. — Task 6 test.
3. **Two vaults sharing one replica/helper pool**: A's participants, bag and version never appear in B. — Task 9 e2e.
4. **A persisted vault whose record is corrupt or partial**: listed as failed-to-start (or dropped) without breaking the list. — Task 3 test.
5. **A banner for a vault that was removed before it was clicked**: navigating to a gone vault lands on the list with a notice, not a blank page. — Task 7 test.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/routing.ts` (new) | `Route` type, `parseHash`, `formatRoute`, `navigate` |
| `src/useHashRoute.ts` (new) | React hook over `hashchange` |
| `src/vault/manager.ts` (new) | `VaultManager`: runtimes, locks, persistence, roster poller, entries, notifications, attention aggregation |
| `src/vault/managerContext.tsx` (new) | `VaultManagerProvider`, `useVaultManager()`, `useVaultEntries()`, `useRoster()` |
| `src/vault/runtime.ts` | + `attachView`, + replica first-sync trigger ownership, + `wantsFastCadence` |
| `src/vault/types.ts` | + `VaultNotifier.outcome`, + runtime state `replicaAutoSyncOutcome` |
| `src/VaultList.tsx` (new) | Home screen: rows, New vault, Claim, Open, Retry, badges |
| `src/SetupWizard.tsx` | picker removed; `initialFlow` + `onCancel` props |
| `src/App.tsx` | provider + routes + header (All vaults, attention indicator, Leave dialog) |
| `src/OwnerPage.tsx` | takes `runtime` prop; no construction, no roster fetch, no trigger |
| `src/vaultPersistence.ts` | session pointer removed; `persistVault` reports failure |
| `src/toastBus.ts`, `src/Toast.tsx` | toast `vaultId` + click-to-navigate |
| `e2e/app.ts`, `e2e/*.spec.ts` | helpers follow the list; new multi-vault specs |

---

### Task 1: Hash routes

**Files:** Create `src/routing.ts`, `src/routing.test.ts`, `src/useHashRoute.ts`.

**Interfaces — Produces:**
```ts
export type Route =
  | { kind: 'list' }
  | { kind: 'new'; flow: 'setup' | 'claim' }
  | { kind: 'vault'; id: string }
export function parseHash(hash: string): Route
export function formatRoute(route: Route): string   // '#/', '#/new', '#/new/claim', '#/vault/<id>'
export function navigate(route: Route): void          // sets location.hash
export function useHashRoute(): Route
```

- [ ] **Step 1: Failing tests** — `parseHash('')`, `'#'`, `'#/'` → list; `'#/new'` → new/setup; `'#/new/claim'` → new/claim; `'#/vault/abc-123'` → vault; unknown (`'#/foo'`, `'#/vault/'`) → list; round-trip `parseHash(formatRoute(r))` for each kind; ids are URI-decoded.
- [ ] **Step 2: Run** `npx vitest run src/routing` — FAIL (module missing).
- [ ] **Step 3: Implement** `parseHash`/`formatRoute`/`navigate` (pure) and `useHashRoute` (`useSyncExternalStore` over `hashchange`, snapshot = `location.hash`).
- [ ] **Step 4: Run** — PASS; `npx tsc -b`, `npm run lint`.

---

### Task 2: `VaultManager` core — runtimes, locks, persistence

**Files:** Create `src/vault/manager.ts`, `src/vault/manager.test.ts`. Modify `src/vaultPersistence.ts` (drop `ACTIVE_KEY`/`loadActiveVault`/`clearActiveVault`; `persistVault` returns `boolean`).

**Interfaces — Produces:**
```ts
export type VaultRunState = 'starting' | 'running' | 'stopped' | 'failed' | 'elsewhere' | 'blocked'
export interface VaultEntry {
  id: string
  name: string
  state: VaultRunState
  failure: string | null
  pairedCount: number
  bagVersion: number | null
  replicaCount: number
  /** Open attention items — the badge. */
  attention: number
}
export interface VaultLocks {
  acquire(id: string): Promise<{ release(): Promise<void> } | null>
}
export interface VaultStorage {
  list(): string[]
  load(id: string): Vault | null
  persist(vault: Vault): boolean
  remove(id: string): void
}
export interface VaultManagerDeps {
  log: VaultLogger
  notify: VaultNotifier
  getServerDefaults: () => ServerDefaults
  locks: VaultLocks
  storage: VaultStorage
  /** Builds a runtime; injectable so specs avoid WASM. Defaults to `new VaultRuntime`. */
  createRuntime?: (vault: Vault, deps: VaultRuntimeDeps) => VaultRuntime
  /** Erases a vault's protocol stores and replica bookkeeping. */
  eraseStores: (vault: Vault) => void
}
export class VaultManager {
  constructor(deps: VaultManagerDeps)
  boot(): Promise<void>                  // every stored vault: lock → start, or 'elsewhere'
  create(vault: Vault): Promise<boolean> // lock → persist → start; false if locked elsewhere
  open(id: string): Promise<boolean>     // a 'stopped' or 'elsewhere' vault: lock → start (Claim)
  retry(id: string): Promise<void>       // a 'failed' vault: start again
  release(id: string): Promise<void>     // stop runtime → release lock → 'stopped'
  remove(id: string): Promise<void>      // release → eraseStores → storage.remove → gone
  releaseAll(): Promise<void>            // pagehide
  runtime(id: string): VaultRuntime | null
  entries(): readonly VaultEntry[]       // sorted by name; stable array identity between changes
  subscribe(listener: () => void): () => void
}
```
Each runtime is built with `onVaultChange: next => { if (!storage.persist(next)) notify.error('Could not save "<name>" — browser storage is full or unavailable') }` (reported once per vault until a save succeeds). A runtime's `subscribe` feeds `entries()`; `state()` → `VaultEntry` counts (`pairedCount` from `participants`, `bagVersion` from `secretBag.currentVersion.version`, `replicaCount` from `loadReplicaState(id).channels`, `attention` = `state.attention.length`, `state` from runtime status: `'failed'`→failed, `'blocked'`→blocked).

- [ ] **Step 1: Failing tests** (fakes for `locks`, `storage`, `createRuntime` returning a stub with `start/stop/state/subscribe`):
  - boot starts every stored vault it can lock; one the fake lock refuses is `'elsewhere'` and has no runtime.
  - `entries()` is available before any `start()` resolves (list renders from storage) with `state: 'starting'`.
  - a runtime whose `start()` leaves status `'failed'` gives `state: 'failed'` + `failure`, and other vaults stay `'running'`.
  - `create` persists, starts, and returns `false` without persisting when the lock is refused.
  - `release` stops the runtime and releases the lock (`state: 'stopped'`); `open` on it locks and starts again.
  - `remove` stops the runtime **before** `eraseStores` (assert call order) and drops the entry.
  - a record `storage.load` returns `null` for is not listed (Review Focus 4).
  - a failing `storage.persist` reports one error per vault, not one per commit.
- [ ] **Step 2: Run** `npx vitest run src/vault/manager` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; full `npx vitest run`, `tsc`, lint.

---

### Task 3: The page attaches to a runtime it is given

**Files:** Modify `src/vault/runtime.ts`, `src/vault/types.ts`, `src/OwnerPage.tsx`, `src/App.tsx`. Create `src/vault/managerContext.tsx`. Test: `src/vault/runtime.test.ts`.

**Interfaces:**
- Consumes: `VaultManager` (Task 2).
- Produces: `VaultRuntime.attachView(effects: Partial<VaultViewEffects>): () => void` (returns detach; with none attached every effect is a no-op). `OwnerPage` props become `{ runtime: VaultRuntime }`; the page reads the vault from `runtime.state().vault` via its subscription and writes through `runtime.commit(next)`. `useVaultManager(): VaultManager`.

- [ ] **Step 1: Failing tests** — effects called while a view is attached reach it; after detach they are no-ops; attaching a second view replaces the first (only one page per vault).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement `attachView`**; the `effects` getter reads the attached set.
- [ ] **Step 4: Rewire the page.** Remove from `OwnerPage`: the `new VaultRuntime(...)` block, the `syncVault` effect, the start/stop effect, `publishVault`, `onUpdate`/`onUpdateRef`, `vaultRef` as a source of truth. `const vault = runtimeState.vault`; `vaultRef` becomes `useLatestRef(vault)`. Attach the page's effects in an effect keyed on the runtime. Replace every `onUpdate(x)`/`publishVault(x)` with `runtime.commit(x)`. Delete `syncVault` from the runtime (nothing calls it).
- [ ] **Step 5: App uses the manager** for the single on-screen vault (list still the wizard until Task 5): `VaultManagerProvider` builds the manager with `acquireVaultLock`, a storage adapter over `vaultPersistence`, `eraseStores` = `clearNamespace('vault:'+id)` + `clearReplicaState(id)`, console `log`, `reportError`/`reportInfo`; `boot()` on mount; `releaseAll()` on `pagehide`. The wizard's `onReady` becomes `manager.create`.
- [ ] **Step 6: Verify** — unit suite, `tsc`, lint, **full e2e** (behaviour must be unchanged for one vault).

---

### Task 4: Shared roster poller; the replica first-sync trigger moves into the runtime

**Files:** Modify `src/vault/manager.ts`, `src/vault/runtime.ts`, `src/vault/types.ts`, `src/OwnerPage.tsx`. Tests: `src/vault/manager.test.ts`, `src/vault/runtime.test.ts`.

**Interfaces — Produces:**
- `VaultManager.roster(): readonly BEActorWithStatus[] | null`; the manager fetches `apiGetActors()` **once** per tick and calls `applyRoster(actors)` on every running runtime. Cadence: 500 ms while any runtime `wantsFastCadence()`, else 5000 ms. Injectable `fetchActors` in deps.
- `VaultRuntime.wantsFastCadence(): boolean` (the drain's fast condition).
- The runtime owns `createReplicaFirstSyncTrigger`: `applyRoster` calls `trigger.observe(replicaViews(actors, loadReplicaState(id)))`. `VaultRuntimeState.replicaAutoSyncOutcome: UnresolvedAutomaticSync | null`; `dismissReplicaAutoSyncOutcome()`; `syncReplicasNow(): Promise<ManualSyncOutcome>` (the trigger's `syncNow`).
- `useRoster()` hook for the page's projections.

- [ ] **Step 1: Failing tests** — two running runtimes, one tick → `fetchActors` called once, both `applyRoster`ed; a stopped vault is not; a fetch failure keeps the loop going; the trigger dispatches for a newly eligible destination with no page mounted.
- [ ] **Step 2–3: Run, implement.** Page: delete its roster interval, `replicaFirstSyncRef`, `replicaSyncRunnerRef`; read rows from `useRoster()`; `handleReplicaSyncNow`/eviction call `runtime.syncReplicasNow()`; banner reads `runtimeState.replicaAutoSyncOutcome`.
- [ ] **Step 4: Verify** — unit, `tsc`, lint, e2e `replicas.spec.ts` + `browser-replica.spec.ts`.

---

### Task 5: Vault list as home, routes, wizard creates one vault

**Files:** Create `src/VaultList.tsx`, `src/VaultList.test.tsx`. Modify `src/App.tsx`, `src/SetupWizard.tsx`, `src/AppShell.tsx`, `e2e/app.ts`, `e2e/participants.spec.ts`, `e2e/settings.spec.ts`.

**Interfaces:**
- Consumes: `useHashRoute`, `navigate` (Task 1); `useVaultEntries()`, manager `open/retry` (Tasks 2–3).
- Produces: `SetupWizard` props `{ initialFlow: 'setup' | 'claim'; onReady(v: Vault): Promise<boolean>; onCancel(): void }`; `VaultList` props `{ entries, onNew(flow), onOpen(id), onClaim(id), onRetry(id) }`.

Behaviour: `#/` renders the list — heading **Get started** when empty (e2e `openApp` relies on it), **Your vaults** otherwise; buttons **Set up a new vault** and **Claim an existing actor**. Rows: name, state in words (Running / Starting… / Stopped / Open in another tab / Failed to start / Blocked), paired count, bag version, replica count, attention badge (`N need your decision`, text not colour only). Actions: running → **Open**; stopped → **Open**; elsewhere → **Claim**; failed → **Retry**. `#/new` → wizard; its Back on the first step → `#/`; `onReady` success → `#/vault/{id}`. `#/vault/{id}`: running → `OwnerPage key={id} runtime`; elsewhere → notice + Claim; unknown → navigate to `#/` with a notice (Review Focus 5). `AppShell` selects the Owner section whenever the route changes to a vault or `new`. Document title follows the on-screen vault.

- [ ] **Step 1: Failing tests** — `VaultList` renders each state's words and action; the empty heading is "Get started"; the badge text appears only with attention > 0. Route handling: a `#/vault/{id}` whose entry is `'elsewhere'` renders Claim and **no** `OwnerPage` (Review Focus 1).
- [ ] **Step 2–3: Run, implement.** Remove the picker (`VaultRow`, the list part of `StepChoice`, `heldVaultIds` polling) from the wizard; it starts in `initialFlow`.
- [ ] **Step 4: e2e helpers** — `setUpOwner` clicks **Set up a new vault** from the list (heading "Get started" or "Your vaults"); the three specs that click "Set up a new owner" follow the rename.
- [ ] **Step 5: Verify** — unit, `tsc`, lint, full e2e.

---

### Task 6: Leave, stop and remove per vault

**Files:** Modify `src/App.tsx`. Test: `src/App.test.tsx` (new, jsdom with a stubbed manager) or `src/vault/manager.test.ts` for ordering.

Behaviour: when a vault is on screen the header shows **All vaults** (→ `#/`, vault keeps running) and **Leave** (smoke spec relies on it) opening a dialog: **Cancel** / **Stop running here** (`manager.release(id)` → `#/`) / **Remove from browser** (`manager.remove(id)` → `#/`). `pagehide` → `releaseAll()`.

- [ ] **Step 1: Failing test** — removing the on-screen vault navigates to `#/` and calls `remove` once; stop keeps the record (`state: 'stopped'`) (Review Focus 2).
- [ ] **Step 2–3: Run, implement.**
- [ ] **Step 4: Verify** — unit, `tsc`, lint, `smoke.spec.ts`.

---

### Task 7: Banners for vaults not on screen

**Files:** Modify `src/toastBus.ts`, `src/Toast.tsx`, `src/vault/types.ts`, `src/vault/manager.ts`, `src/vault/fold/sharing.ts`, `src/vault/fold/recovery.ts`, `src/vault/fold/pairing.ts`. Tests: `src/Toast.test.tsx` (new), `src/vault/manager.test.ts`.

**Interfaces — Produces:**
- `reportError(summary, err?, context?, origin?: ToastOrigin)`, `reportInfo(message, origin?)` with `interface ToastOrigin { vaultId: string; vaultName: string }`. A toast with an origin renders `"<vaultName>: <message>"` and clicking it calls `navigate({ kind: 'vault', id })` then dismisses; without one it dismisses (today).
- `VaultNotifier.outcome(message: string): void` — a terminal outcome worth a banner **only when off screen**.
- `VaultManager.setOnScreen(id: string | null)`; the manager builds each runtime's notifier: `error`/`info` pass through with an origin when off screen, plain when on screen; `outcome` → `reportInfo(message, origin)` when off screen, dropped when on screen.
- Outcomes raised from the fold: `SharingComplete` (threshold met → "Sharing round vN complete", else "Sharing round vN did not reach its threshold"), `SecretRecovered` ("Secret recovered"), `RecoveryShareError` ("Recovery failed: …"), `PairingCompleted` ("Paired with <peer>"). Existing `notify.info`/`error` calls keep their wording.
- Attention raised on an off-screen vault → one banner "<vault> needs your decision" (per item, on raise).

- [ ] **Step 1: Failing tests** — manager: an outcome from the on-screen vault produces no toast; from an off-screen one, one toast with its origin; an error from an off-screen vault carries its origin. Toast: clicking an origin toast calls `navigate`; a click on a toast for a removed vault lands on the list (Review Focus 5, via Task 5's unknown-id handling).
- [ ] **Step 2–3: Run, implement.**
- [ ] **Step 4: Verify** — unit, `tsc`, lint.

---

### Task 8: Badges — list rows and a global indicator

**Files:** Modify `src/VaultList.tsx`, `src/App.tsx`. Test: `src/VaultList.test.tsx`, `src/App.test.tsx`.

Behaviour: list rows already show the count (Task 5). While a vault is on screen, the header shows **"N other vault(s) need your decision"** as a button to `#/` when any *other* running vault has attention > 0; hidden otherwise. Text, not colour alone; `aria-live="polite"`.

- [ ] **Step 1: Failing test** — indicator counts other vaults only, hides at zero.
- [ ] **Step 2–3: Run, implement.**
- [ ] **Step 4: Verify** — unit, `tsc`, lint.

---

### Task 9: Multi-vault end-to-end, and the spec's open question

**Files:** Create `e2e/multi-vault.spec.ts`. Modify `e2e/app.ts` (helpers `backToVaults(page)`, `openVault(page, name)`), `docs/superpowers/specs/2026-09-29-multi-vault-design.md`.

- [ ] **Step 1: Two vaults in one context** — set up **Alpha** (1 pre-paired helper), protect a secret; back to the list; set up **Beta** (0 pre-paired). Assert Beta's Secret Bag is empty and it lists no paired channel; back to Alpha: its bag still has the secret. Both rows read Running (Review Focus 3).
- [ ] **Step 2: Background vault raises a badge** — context 1 sets up **Alpha** and **Beta**, copies Beta's contact while Beta is on screen, then opens Alpha. Context 2 sets up a vault and pairs with Beta's contact. Context 1, still on Alpha, shows the header indicator "1 other vault needs your decision" and a banner naming Beta, with **no** pairing modal on Alpha; clicking the banner opens Beta, where the pairing confirmation is shown.
- [ ] **Step 3: Run** `npx playwright test multi-vault` then the full suite.
- [ ] **Step 4: Spec** — under *Failure modes → Staleness*, record the answer to "whether the library surfaces a distinguishable error for a replay-window rejection": from SDK 0.0.6, `MessageIgnored { reason: 'Expired' }`, logged per vault by `fold/outcomes.ts`.

---

## Definition of done

- Several vaults run at once in one tab; one is displayed; the list is the home screen.
- A vault locked by another tab is listed with Claim; a failed vault with Retry; neither affects the others.
- Leave offers stop-and-release and remove-from-browser; `pagehide` releases every lock.
- Off-screen vaults surface outcomes as clickable banners and decisions as badges; the on-screen vault behaves as before.
- `npx tsc -b`, `npm run lint`, `npx vitest run`, full `npx playwright test` green; backend untouched.
