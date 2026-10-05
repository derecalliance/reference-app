# Vault Foundation Implementation Plan (Phases 1–3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put today's single-vault behaviour onto a multi-vault-capable architecture — domain type renamed, config layered, protocol engine extracted from the view — and answer whether two WASM protocol instances can run concurrently.

**Architecture:** `OwnerPage.tsx` currently fuses the protocol engine and the UI in 5238 lines. This plan extracts a React-free `VaultRuntime` (instance lifecycle, protocol lock, mailbox poll, tick, event fold, attention queue, command surface) and leaves `OwnerPage` as a view that subscribes to it. Exactly one vault runs throughout; the existing test suite is the gate at every step.

**Tech Stack:** React 19 + TypeScript + MUI 7 + Vite 8, Vitest (jsdom), Playwright, `@derec-alliance/web` 0.0.5 (WASM SDK).

**Spec:** `docs/superpowers/specs/2026-09-29-multi-vault-design.md`

## Global Constraints

- **Vocabulary rule.** "Vault" in app/UI, `types.ts`, storage keys, file and component names, console output. "Owner" retained **only** where it names the protocol role: `Role::Owner`, `POST /owners`, `peerRole: 'owner'`, `ChannelRole`, `sender_kind`, `ConsoleRole`. A vault is an owner-role actor; the app stops calling it that at the user.
- **No backend changes.** Nothing in `apps/backend` is touched by this plan.
- **No library changes.** If a task appears to require modifying `@derec-alliance/web` or `derec-library`, STOP and report — library fitness is under evaluation and a workaround destroys the signal.
- **No new runtime dependencies.** `package.json` dependencies are unchanged.
- **Exactly one vault runs** for the whole of this plan. Multi-vault arrives in the next plan.
- **No migration.** Existing persisted state is abandoned; blank storage is acceptable.
- **The split rule:** if it needs no DOM, it belongs to `VaultRuntime`. Modal rendering, tabs, panels, reveal toggles, dialog open/close stay in the view.
- **`minParticipants` is frozen at vault creation** — never live-inherited. Shares already distributed depend on it.
- **Do not commit.** The user reviews and commits. Every task ends with a verification step, not a `git commit`.
- Verification commands: `npm test -- --run` (unit), `npm run typecheck`, `npm run lint`, `npm run test:e2e` (e2e; slow, only where a task names it).

---

### Task 1: Rename the domain type and storage keys

**Files:**
- Modify: `apps/web/src/types.ts:263-349` (`Owner` → `Vault`, `OwnerConfig` → `VaultConfig`)
- Rename: `apps/web/src/ownerPersistence.ts` → `apps/web/src/vaultPersistence.ts`
- Rename: `apps/web/src/ownerPersistence.test.ts` → `apps/web/src/vaultPersistence.test.ts`
- Rename: `apps/web/src/ownerLock.ts` → `apps/web/src/vaultLock.ts`
- Rename: `apps/web/src/ownerLock.test.ts` → `apps/web/src/vaultLock.test.ts`
- Modify: `apps/web/src/stores.ts:13-58` (key builders — comment only; the `ns` string is supplied by callers)
- Modify: `apps/web/src/replicaIdentity.ts:19`, `apps/web/src/replicaFlows.ts:416,562`
- Modify consumers: `apps/web/src/App.tsx`, `SetupWizard.tsx`, `OwnerPage.tsx`, `owner/RecoveryPanel.tsx`, `owner/SecretBagPanel.tsx`, `owner/useLinkGroups.ts`, `ReplicasTab.tsx`, `admin/InspectTab.tsx`, `localData.ts:4-7` (comment)
- Modify tests: `replicaIdentity.test.ts`, `replicaPairingConsent.test.ts`, `stores.test.ts`, `ownerPairing.test.ts`, `ReplicasTab.test.tsx`, `AppShell.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // apps/web/src/types.ts
  export interface VaultConfig {
    protocolTimeoutSecs: number
    authenticationMethod: AuthenticationMethod
    unpairAck: UnpairAck
    autoAcceptUnpairRequests: boolean
  }
  export interface Vault {
    /** The owner-role actor UUID. Also the storage key, lock name and URL segment. */
    id: string
    name: string
    /** This vault's own secret_id (u64 decimal string). */
    secretId: string
    transport: Transport
    participants: PairedParticipant[]
    secretBag: SecretBag | null
    pendingPairings: PendingPairing[]
    prePairedCount?: number
    /** Shamir threshold. Frozen at creation — see Task 2. */
    minParticipants: number
    recommendedParticipants: number
    recoveredSecrets: RecoveredSecret[]
    recoveryProgress: RecoveryProgress | null
    recoveryFailures: RecoveryFailure[]
    heldShares: HeldShare[]
    mainChannels: string[]
    config: VaultConfig
  }
  // apps/web/src/vaultPersistence.ts
  export interface VaultSummary { id: string; name: string; pairedCount: number }
  export function persistVault(vault: Vault): void
  export function loadVaultById(id: string): Vault | null
  export function loadActiveVault(): Vault | null
  export function clearActiveVault(): void
  export function listVaults(): VaultSummary[]
  export function deleteVault(id: string): void
  // apps/web/src/vaultLock.ts
  export interface VaultLock { vaultId: string; release: () => Promise<void> }
  export function acquireVaultLock(vaultId: string): Promise<VaultLock | null>
  export function heldVaultIds(): Promise<Set<string>>
  ```

`Vault.config` stays a **full** `VaultConfig` in this task. Task 2 converts it to a partial override. Splitting the rename from the semantic change keeps this task purely mechanical.

- [ ] **Step 1: Rename the type and its fields in `types.ts`**

In `apps/web/src/types.ts`, rename `interface Owner` → `interface Vault` and `interface OwnerConfig` → `interface VaultConfig`. Rename three fields: `ownerId` → `id`, `ownerName` → `name`, `ownSecretId` → `secretId`. Replace the `Owner` doc comment with:

```ts
/**
 * One vault: a DeRec instance bound to a single `secret_id`, holding its own bag
 * of user secrets, its own paired participants, and its own replica group.
 *
 * A vault is an owner-role actor on the backend — `id` is that actor's UUID —
 * but the app never calls it an owner at the user. Counterparties see unrelated
 * owners; only this app knows several vaults belong to one person.
 */
```

Leave `HeldShare`, `PairedParticipant`, `SecretBag`, `ChannelRole` and every other type in the file unchanged — `ChannelRole`/`peerRole` name the protocol role and are covered by the vocabulary rule.

- [ ] **Step 2: Run typecheck to enumerate every consumer**

Run: `cd apps/web && npm run typecheck`
Expected: FAIL with a list of errors naming `Owner`, `ownerId`, `ownerName`, `ownSecretId`. **Save that list** — it is the exact worklist for Steps 4–6.

- [ ] **Step 3: Rename the persistence and lock modules, and their keys**

`git mv apps/web/src/ownerPersistence.ts apps/web/src/vaultPersistence.ts` (and the `.test.ts`), likewise `ownerLock.ts` → `vaultLock.ts`.

In `vaultPersistence.ts`: `ACTIVE_KEY` becomes `'derec:active-vault'`, `OWNER_KEY_PREFIX` becomes `VAULT_KEY_PREFIX = 'derec:vault:'`, `ownerStorageKey` → `vaultStorageKey`, `ownerIdFromKey` → `vaultIdFromKey`, `StoredOwner` → `StoredVault` (its `type: 'owner'` discriminant becomes `type: 'vault'`), and the six exported functions take the names in the Produces block. Update the `ownerIdFromKey` doc comment to say `derec:vault:{vaultId}:{secretId}:…`.

Keep `loadVaultById`'s stale-record guard, retargeted to the new field name:

```ts
    // Records persisted before protocol state was partitioned by secret have no
    // `secretId`, and their stored channels/shares/secrets sit under keys the
    // current stores cannot read. Treat them as stale so the app offers a fresh
    // setup instead of half-loading state whose protocol keys can never be found.
    if (!vault.secretId) return null
```

In `vaultLock.ts`: `lockName` returns `` `derec:vault-lock:${vaultId}` ``, and rename `OwnerLock`/`acquireOwnerLock`/`heldOwnerIds` per the Produces block, including the `ownerId` field on the lock object → `vaultId`.

In `replicaIdentity.ts:19`, `STORAGE_PREFIX` becomes `'derec:replica-id:'` — unchanged in value, but its doc comment must say the suffix is a vault id. In `replicaFlows.ts:416`, `REPLICA_STATE_KEY_PREFIX` stays `'derec:replica-state:'` with the same comment fix, and `loadReplicaState(ownerId)` → `loadReplicaState(vaultId)`.

- [ ] **Step 4: Update the namespace string every store partition is built from**

Every call site builds the store namespace as `` `owner:${ownerId}` ``. Change all of them to `` `vault:${vault.id}` ``. Find them with:

Run: `rg -n "owner:\\\$\{" apps/web/src`
Expected sites include `OwnerPage.tsx:684,332,404,3500` and `owner/RecoveryPanel.tsx:224`. Combined with `derec:` from `stores.ts:14`, this yields the `derec:vault:{id}:{secretId}:…` layout the spec names.

- [ ] **Step 5: Work the typecheck list until it is empty**

Mechanical: `Owner` → `Vault` as a type, `owner` → `vault` as a variable, `.ownerId` → `.id`, `.ownerName` → `.name`, `.ownSecretId` → `.secretId`. Do **not** rename `OwnerPage.tsx` yet — the file moves in Task 3 when its contents change. Do **not** touch `ConsoleRole`'s `'owner'` member, `peerRole`, `ChannelRole`, `Role`, `role === 'owner'` comparisons against backend actor records, or any `POST /owners` / `apiRegisterOwner` call.

Run after each file: `cd apps/web && npm run typecheck`

- [ ] **Step 6: Update the tests that hardcode storage keys**

Run: `rg -n "derec:owner|derec:active-owner" apps/web/src apps/web/e2e`
Expected: hits in `vaultPersistence.test.ts`, `replicaIdentity.test.ts`, `replicaPairingConsent.test.ts`. Replace `derec:owner:` with `derec:vault:` and `derec:active-owner` with `derec:active-vault`. In `replicaFlows.test.ts:712` update the comment naming `derec:replica-state:<ownerId>` to `<vaultId>`.

- [ ] **Step 7: Verify the whole suite is green**

Run: `cd apps/web && npm run typecheck && npm run lint && npm test -- --run`
Expected: PASS, with the same test count as before this task. A changed count means a test was dropped rather than renamed — find it.

- [ ] **Step 8: Verify the app still runs end to end**

Run: `cd apps/web && npm run test:e2e`
Expected: PASS. This is the real gate on Step 4 — a missed namespace rename typechecks fine and produces a vault that pairs but has no readable stores, which only e2e catches.

---

### Task 2: Layer vault config over browser and server defaults

**Files:**
- Modify: `apps/web/src/protocolDefaults.ts` (add the vault tier)
- Create: `apps/web/src/vaultConfig.test.ts`
- Modify: `apps/web/src/types.ts` (`Vault.config` → `Vault.configOverrides`)
- Modify: `apps/web/src/vaultPersistence.ts` (`normalizeVault`)
- Modify: `apps/web/src/SetupWizard.tsx:600-640,667-690,741-760`
- Modify: `apps/web/src/OwnerPage.tsx:179,693-694,4436`

**Interfaces:**
- Consumes: `Vault`, `VaultConfig` (Task 1).
- Produces:
  ```ts
  // apps/web/src/protocolDefaults.ts
  /** Only what this vault overrides; unset keys follow the browser/server tiers. */
  export type VaultConfigOverrides = Partial<VaultConfig>
  export function resolveVaultConfig(
    overrides: VaultConfigOverrides,
    server: ServerDefaults,
  ): VaultConfig
  ```
  and `Vault.config: VaultConfig` becomes `Vault.configOverrides: VaultConfigOverrides`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/vaultConfig.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { resolveVaultConfig } from './protocolDefaults'
import { FALLBACK_SERVER_DEFAULTS } from './config'

describe('resolveVaultConfig', () => {
  beforeEach(() => localStorage.clear())

  it('falls through to the server tier when nothing overrides', () => {
    const resolved = resolveVaultConfig({}, FALLBACK_SERVER_DEFAULTS)
    expect(resolved.protocolTimeoutSecs).toBe(FALLBACK_SERVER_DEFAULTS.protocolTimeoutSecs)
    expect(resolved.unpairAck).toBe(FALLBACK_SERVER_DEFAULTS.unpairAck)
  })

  it('lets a vault override one setting without pinning the others', () => {
    const resolved = resolveVaultConfig({ protocolTimeoutSecs: 60 }, FALLBACK_SERVER_DEFAULTS)
    expect(resolved.protocolTimeoutSecs).toBe(60)
    // The control: an override must not freeze a whole snapshot.
    expect(resolved.unpairAck).toBe(FALLBACK_SERVER_DEFAULTS.unpairAck)
  })

  it('puts the vault tier above the browser tier', () => {
    localStorage.setItem('derec.protocolDefaults', JSON.stringify({ protocolTimeoutSecs: 120 }))

    expect(resolveVaultConfig({}, FALLBACK_SERVER_DEFAULTS).protocolTimeoutSecs).toBe(120)
    expect(resolveVaultConfig({ protocolTimeoutSecs: 30 }, FALLBACK_SERVER_DEFAULTS)
      .protocolTimeoutSecs).toBe(30)
  })

  it('reflects a later browser-default change on a vault that did not override', () => {
    // Why overrides are partials: a node reconfigured after a vault was created
    // must still reach that vault. Storing a resolved snapshot would strand it.
    const overrides = {}
    expect(resolveVaultConfig(overrides, FALLBACK_SERVER_DEFAULTS).protocolTimeoutSecs)
      .toBe(FALLBACK_SERVER_DEFAULTS.protocolTimeoutSecs)

    localStorage.setItem('derec.protocolDefaults', JSON.stringify({ protocolTimeoutSecs: 900 }))

    expect(resolveVaultConfig(overrides, FALLBACK_SERVER_DEFAULTS).protocolTimeoutSecs).toBe(900)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npm test -- --run vaultConfig`
Expected: FAIL — `resolveVaultConfig` is not exported.

- [ ] **Step 3: Implement the vault tier**

Append to `apps/web/src/protocolDefaults.ts`:

```ts
/**
 * Only what this vault overrides; unset keys follow the browser and server
 * tiers. A partial for the same reason `DefaultOverrides` is one: a resolved
 * snapshot would strand a vault on the values its node happened to hold the day
 * it was created, with nothing on screen explaining why.
 */
export type VaultConfigOverrides = Partial<VaultConfig>

/**
 * What a vault actually runs with: server defaults, browser overrides, then this
 * vault's own — the third tier of the same merge `effectiveDefaults` performs.
 *
 * `minParticipants` is deliberately absent. It is the Shamir threshold passed to
 * `withThreshold`, and shares already distributed depend on it, so it is
 * resolved once and frozen onto the vault record at creation rather than
 * inherited live. See `Vault.minParticipants`.
 */
export function resolveVaultConfig(
  overrides: VaultConfigOverrides,
  server: ServerDefaults,
): VaultConfig {
  const base = effectiveDefaults(server)
  return {
    protocolTimeoutSecs: overrides.protocolTimeoutSecs ?? base.protocolTimeoutSecs,
    authenticationMethod: overrides.authenticationMethod ?? base.authenticationMethod,
    unpairAck: overrides.unpairAck ?? base.unpairAck,
    autoAcceptUnpairRequests:
      overrides.autoAcceptUnpairRequests ?? base.autoAcceptUnpairRequests,
  }
}
```

Add `import type { VaultConfig } from './types'` at the top. If `ServerDefaults` lacks `autoAcceptUnpairRequests`, fall back to `DEFAULT_AUTO_ACCEPT_UNPAIR_REQUESTS` from `config.ts:76` and note it in the comment.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npm test -- --run vaultConfig`
Expected: PASS (4 tests).

- [ ] **Step 5: Convert `Vault.config` to `Vault.configOverrides`**

In `types.ts`, replace the `config: VaultConfig` field:

```ts
  /**
   * What this vault overrides, not what it runs with. Resolve through
   * `resolveVaultConfig` — never read these values directly, or a vault that
   * overrides nothing reads as having no configuration at all.
   */
  configOverrides: VaultConfigOverrides
```

In `vaultPersistence.ts`, `normalizeVault` replaces the four-field `config:` block with `configOverrides: raw.configOverrides ?? {}`. Delete the now-unused `normalizeAuthenticationMethod` / `normalizeUnpairAck` imports **only if** nothing else in the file uses them.

- [ ] **Step 6: Point every reader at the resolver**

`OwnerPage.tsx:179` becomes `protocolTimeoutMs(resolved.protocolTimeoutSecs)` where `resolved` comes from `resolveVaultConfig(vault.configOverrides, serverDefaults)`; likewise `:693-694` (`timeoutSecs`, `unpairAck`) and `:4436`. Thread `ServerDefaults` in from wherever the page already has it — if it does not, use `FALLBACK_SERVER_DEFAULTS` and leave a comment that Task 3 gives the runtime a real `getServerDefaults`.

In `SetupWizard.tsx`, `configFrom(data)` returns overrides rather than a full config: include a key **only** when the user changed it from the offered default. `minParticipants` and `recommendedParticipants` stay plain frozen fields on the created `Vault`, resolved once at creation exactly as today.

- [ ] **Step 7: Verify**

Run: `cd apps/web && npm run typecheck && npm run lint && npm test -- --run`
Expected: PASS.

---

### Task 3: Extract `VaultRuntime` with instance lifecycle and protocol lock

**Files:**
- Create: `apps/web/src/vault/runtime.ts`
- Create: `apps/web/src/vault/runtime.test.ts`
- Create: `apps/web/src/vault/types.ts`
- Create: `apps/web/src/vault/testVault.ts`
- Modify: `apps/web/src/OwnerPage.tsx:546-608,681-759`

**Interfaces:**
- Consumes: `Vault` (Task 1), `resolveVaultConfig` (Task 2), `buildProtocolInstance` / `ProtocolInstance` (`owner/protocol.ts:83`), `ConsoleEntry` (`ConsoleContext.tsx:32`).
- Produces:
  ```ts
  // apps/web/src/vault/types.ts
  export type VaultStatus = 'idle' | 'starting' | 'running' | 'blocked' | 'failed'
  /** Exactly what `useConsole().log` accepts (`ConsoleContext.tsx:67`). */
  export type VaultLogInput = Omit<ConsoleEntry, 'id' | 'timestamp'>
  export type VaultLogger = (entry: VaultLogInput) => void
  export interface VaultNotifier {
    error: (message: string, cause?: unknown, context?: unknown) => void
    info: (message: string) => void
  }
  /** Injected so tests drive the loop with no backend and no timers. */
  export interface VaultRuntimeIo {
    pollMailbox: (actorId: string) => Promise<MailboxMessage[]>
    postContact: (actorId: string, contact: string) => Promise<void>
  }
  /**
   * View-side callbacks the engine pokes. Kept to exactly the set the moved code
   * already needed — nothing may be added here without a reason recorded.
   */
  export interface VaultViewEffects {
    refreshReplicas: () => void
    openFingerprint: (channelId: string) => void
    openAdoption: () => void
    stageReplicaAdoption: (offer: PendingReplicaAdoption) => void
    signalPairingCompleted: () => void
    signalPairingRejected: () => void
    setOutgoingUnpairConfirmation: (c: OutgoingUnpairConfirmation | null) => void
    setUnpairingChannelIds: (update: (prev: Set<string>) => Set<string>) => void
  }
  export interface VaultRuntimeState {
    vault: Vault
    status: VaultStatus
    busy: boolean
    attention: readonly Attention[]
    failure: string | null
  }
  export interface VaultRuntimeDeps {
    log: VaultLogger
    notify: VaultNotifier
    onVaultChange: (vault: Vault) => void
    getServerDefaults: () => ServerDefaults
    /** Defaults to the real `derecApi` functions. */
    io?: Partial<VaultRuntimeIo>
    /** Defaults to no-ops, so Tasks 3–4 need not supply them. */
    effects?: Partial<VaultViewEffects>
  }
  // apps/web/src/vault/runtime.ts
  export class VaultRuntime {
    constructor(vault: Vault, deps: VaultRuntimeDeps)
    readonly vaultId: string
    get secretId(): string
    start(): Promise<void>
    stop(): void
    state(): VaultRuntimeState
    subscribe(listener: (state: VaultRuntimeState) => void): () => void
    instance(): ProtocolInstance | null
    withLock<T>(fn: () => Promise<T>): Promise<T>
    /** Test-only seam so specs can run the loop without WASM. */
    __setInstanceForTest(instance: ProtocolInstance): void
  }
  ```
  `io` and `effects` are declared optional **now**, in their final shape, so Tasks 5–7 add behaviour without changing this constructor's call sites. `Attention` is declared in Task 6; until then `vault/types.ts` carries `export type Attention = never` and `state()` returns `attention: []`.

- [ ] **Step 1: Write the shared test fixtures**

Create `apps/web/src/vault/testVault.ts` — Tasks 4–8 all import from it, so it exists from the start rather than being moved later:

```ts
import { vi } from 'vitest'
import { FALLBACK_SERVER_DEFAULTS } from '../config'
import type { Vault } from '../types'
import type { VaultRuntime } from './runtime'
import type { VaultRuntimeDeps } from './types'
import type { ProtocolInstance } from '../owner/protocol'

export function vault(overrides: Partial<Vault> = {}): Vault {
  return {
    id: 'v1',
    name: 'Crypto Seeds',
    secretId: '42',
    transport: { protocol: 'https', uri: 'http://localhost:5000/derec/v1' },
    participants: [],
    secretBag: null,
    pendingPairings: [],
    minParticipants: 3,
    recommendedParticipants: 5,
    recoveredSecrets: [],
    recoveryProgress: null,
    recoveryFailures: [],
    heldShares: [],
    mainChannels: [],
    configOverrides: {},
    ...overrides,
  }
}

export function deps(overrides: Partial<VaultRuntimeDeps> = {}): VaultRuntimeDeps {
  return {
    log: vi.fn(),
    notify: { error: vi.fn(), info: vi.fn() },
    onVaultChange: vi.fn(),
    getServerDefaults: () => FALLBACK_SERVER_DEFAULTS,
    ...overrides,
  }
}

/**
 * Give a runtime a fake protocol so specs can drive the loop with no WASM.
 *
 * Goes through the documented `__setInstanceForTest` seam rather than casting
 * the runtime to `any` at every call site.
 */
export function stubInstance(
  runtime: VaultRuntime,
  protocol: Record<string, unknown>,
): void {
  runtime.__setInstanceForTest({
    secretId: '42',
    protocol,
    channelStore: {},
    shareStore: {},
  } as unknown as ProtocolInstance)
}
```

- [ ] **Step 2: Write the failing tests**

Create `apps/web/src/vault/runtime.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { VaultRuntime } from './runtime'
import { deps, vault } from './testVault'

describe('VaultRuntime', () => {
  it('reports the vault it was built for before it starts', () => {
    const r = new VaultRuntime(vault(), deps())
    expect(r.vaultId).toBe('v1')
    expect(r.secretId).toBe('42')
    expect(r.state().status).toBe('idle')
    expect(r.instance()).toBeNull()
  })

  it('notifies subscribers when state changes and stops after unsubscribe', () => {
    const r = new VaultRuntime(vault(), deps())
    const seen: string[] = []
    const off = r.subscribe(s => seen.push(s.status))

    r.stop()
    const afterStop = seen.length
    off()
    r.stop()

    expect(afterStop).toBeGreaterThan(0)
    expect(seen.length).toBe(afterStop)
  })

  it('serialises calls through the protocol lock', async () => {
    // WASM borrows &mut self for async calls; two overlapping calls on one
    // instance raise "recursive use of an object".
    const r = new VaultRuntime(vault(), deps())
    const order: string[] = []

    const first = r.withLock(async () => {
      order.push('first-in')
      await new Promise(resolve => setTimeout(resolve, 10))
      order.push('first-out')
    })
    const second = r.withLock(async () => { order.push('second-in') })

    await Promise.all([first, second])

    expect(order).toEqual(['first-in', 'first-out', 'second-in'])
  })

  it('releases the lock when the guarded call throws', async () => {
    const r = new VaultRuntime(vault(), deps())
    await expect(r.withLock(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    // The control: a lock leaked on failure would hang this forever.
    await expect(r.withLock(async () => 'ok')).resolves.toBe('ok')
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd apps/web && npm test -- --run vault/runtime`
Expected: FAIL — cannot resolve `./runtime`.

- [ ] **Step 4: Create `vault/types.ts`**

Write the types from the Produces block verbatim, importing `ConsoleEntry` from `../ConsoleContext` (export it from there if it is not already exported) and `MailboxMessage` from `../derecApi`. `PendingReplicaAdoption` and `OutgoingUnpairConfirmation` already exist in the `OwnerPage.tsx` import graph — move their declarations into `vault/types.ts` if they are declared inline in `OwnerPage.tsx`, otherwise re-export. Add:

```ts
/** Placeholder until Task 6 introduces the attention queue. */
export type Attention = never
```

- [ ] **Step 5: Implement `VaultRuntime`**

Create `apps/web/src/vault/runtime.ts`:

```ts
import { buildProtocolInstance, type ProtocolInstance } from '../owner/protocol'
import { resolveVaultConfig } from '../protocolDefaults'
import { getOrCreateReplicaId } from '../replicaIdentity'
import type { Vault } from '../types'
import type { VaultRuntimeDeps, VaultRuntimeState, VaultStatus } from './types'

/**
 * One vault's protocol engine, with no view attached.
 *
 * Owns the `DeRecProtocol` instance, the lock that serialises access to it, and
 * (from Task 5 on) the mailbox poll, the tick and the event fold. Deliberately
 * React-free: a runtime must keep polling and processing while its vault is off
 * screen, and nothing here may depend on being rendered.
 */
export class VaultRuntime {
  readonly vaultId: string

  private vault: Vault
  private readonly deps: VaultRuntimeDeps
  private protocolInstance: ProtocolInstance | null = null
  private status: VaultStatus = 'idle'
  private failure: string | null = null
  private busy = false
  private readonly listeners = new Set<(state: VaultRuntimeState) => void>()
  private lock: Promise<unknown> = Promise.resolve()

  constructor(vault: Vault, deps: VaultRuntimeDeps) {
    this.vaultId = vault.id
    this.vault = vault
    this.deps = deps
  }

  get secretId(): string {
    return this.vault.secretId
  }

  state(): VaultRuntimeState {
    return {
      vault: this.vault,
      status: this.status,
      busy: this.busy,
      attention: [],
      failure: this.failure,
    }
  }

  subscribe(listener: (state: VaultRuntimeState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  instance(): ProtocolInstance | null {
    return this.protocolInstance
  }

  /**
   * Serialise access to the WASM protocol object. It borrows `&mut self` for
   * async calls, so overlapping calls raise "recursive use of an object".
   *
   * Per-runtime rather than global: two `DeRecProtocol` values are two objects
   * with two independent borrow guards. Task 9 proves that holds.
   */
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.catch(() => {})
    return run
  }

  async start(): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') return
    this.setStatus('starting')
    try {
      const config = resolveVaultConfig(this.vault.configOverrides, this.deps.getServerDefaults())
      this.protocolInstance = buildProtocolInstance({
        namespace: `vault:${this.vault.id}`,
        secretId: this.vault.secretId,
        ownTransportUri: this.vault.transport.uri,
        communicationInfo: { name: this.vault.name },
        threshold: this.vault.minParticipants,
        keepVersionsCount: 3,
        timeoutSecs: config.protocolTimeoutSecs,
        unpairAck: config.unpairAck,
        replicaId: getOrCreateReplicaId(this.vault.id),
      })
      this.deps.log({
        role: 'owner',
        flow: 'setup',
        step: 'protocol_init',
        description: `Protocol initialized for vault ${this.vault.id}`,
        payload: { vaultId: this.vault.id, secretId: this.vault.secretId },
      })
      this.setStatus('running')
    } catch (err) {
      // A vault that cannot build its instance must fail alone. Task 4's list
      // renders this as "failed to start" with a retry rather than taking the
      // whole app down, which is what an unhandled throw in the old init effect
      // would have done.
      this.failure = err instanceof Error ? err.message : String(err)
      this.protocolInstance = null
      this.setStatus('failed')
      this.deps.notify.error(`Vault "${this.vault.name}" failed to start`, err, {
        vaultId: this.vault.id,
      })
    }
  }

  stop(): void {
    this.protocolInstance = null
    this.setStatus('idle')
  }

  /** Replace the vault record and tell both storage and subscribers. */
  protected commit(next: Vault): void {
    this.vault = next
    this.deps.onVaultChange(next)
    this.emit()
  }

  private setStatus(status: VaultStatus): void {
    this.status = status
    this.emit()
  }

  private emit(): void {
    const snapshot = this.state()
    for (const listener of this.listeners) listener(snapshot)
  }
}
```

Add the test-only seam alongside the private field, so `testVault.ts` needs no cast of the runtime itself:

```ts
  /**
   * Install a fake instance. Test-only: specs must be able to drive the poll and
   * fold without loading WASM, and the alternative is casting the runtime to
   * `any` at every call site.
   */
  __setInstanceForTest(instance: ProtocolInstance): void {
    this.protocolInstance = instance
    this.setStatus('running')
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/web && npm test -- --run vault/runtime`
Expected: PASS (4 tests).

- [ ] **Step 7: Make `OwnerPage` delegate to the runtime**

In `OwnerPage.tsx`, replace `instanceRef` (`:550`), `ownSecretIdRef` (`:558`), `ownInstance()` (`:561`), `protocolLockRef` and `withProtocolLock` (`:567-573`) with one runtime held in a ref:

```ts
  // One vault's engine, built once per vault id. Held in a ref because React
  // must not rebuild it on render — it owns a WASM object and a poll loop.
  // Server defaults, read at construction and refreshed by the existing
  // GET /config fetch. A ref because the runtime resolves config lazily and must
  // not be rebuilt when the fetch lands.
  const serverDefaultsRef = useRef<ServerDefaults>(FALLBACK_SERVER_DEFAULTS)
  useEffect(() => {
    apiGetServerDefaults()
      .then(d => { serverDefaultsRef.current = d })
      .catch(() => { /* fallback already in place */ })
  }, [])

  const runtimeRef = useRef<VaultRuntime | null>(null)
  if (runtimeRef.current?.vaultId !== vault.id) {
    runtimeRef.current = new VaultRuntime(vault, {
      log,
      notify: { error: reportError, info: reportInfo },
      onVaultChange: next => onUpdateRef.current(next),
      getServerDefaults: () => serverDefaultsRef.current,
    })
  }
  function ownInstance(): ProtocolInstance | null {
    return runtimeRef.current?.instance() ?? null
  }
  function withProtocolLock<T>(fn: () => Promise<T>): Promise<T> {
    const runtime = runtimeRef.current
    if (!runtime) return Promise.reject(new Error('Vault runtime not initialised'))
    return runtime.withLock(fn)
  }
```

Keep `ownSecretIdRef` as a thin read of `runtimeRef.current?.secretId ?? ''` so the ~20 existing call sites are untouched in this task.

Then reduce the init effect (`:681-759`) to `void runtimeRef.current?.start()` plus the two things not yet moved — `postOwnerContact()` and the offline-flag replay — and keep its cleanup calling `runtimeRef.current?.stop()`. Both move into the runtime in Task 5.

- [ ] **Step 8: Verify nothing regressed**

Run: `cd apps/web && npm run typecheck && npm run lint && npm test -- --run && npm run test:e2e`
Expected: PASS. e2e matters here — this task rewires instance construction, and a mistake shows up as pairing failing, not as a type error.

---

### Task 4: Move the event fold, with its correlation state, onto the runtime

> **Revised 2026-09-29, during implementation.** This task was written as "move
> the fold into a pure reducer with injected effects". That was based on an
> under-measurement: the original survey grepped the fold for `set*` setters and
> `log`/`report` calls only, and missed the **refs** it reads. Measured properly
> over its true bounds (`OwnerPage.tsx:889-1729`), the fold touches 8 refs, and
> **17 of its ~20 outer references are correlation state** — `pendingBagRef` ×12,
> `pendingSharesRef` ×2, `pendingRecoveryRef` ×2, `pendingVerificationsRef` ×1.
>
> A free function would therefore need ~8 accessors on top of the 9 effects — a
> 17-member interface that Task 7 would immediately dismantle. So the fold moves
> as a **private method on `VaultRuntime`**, together with the correlation state
> and the flow watchdog it drives. The four view-facing pokes stay injected as
> `VaultViewEffects`. Task 7 shrinks accordingly: it moves the commands, not this
> state, which will already be in place.
>
> The remaining three references resolve without an interface:
> `secretIdRef.current` → `current.secretId`; `protocolBusyRef.current` →
> `this.busy`; and `vaultRef`/`onUpdateRef` appear only inside the
> `applyPairingCompleted` deps object, which is already an injected seam.

**Files:**
- Create: `apps/web/src/vault/applyVaultEvent.ts`
- Create: `apps/web/src/vault/applyVaultEvent.test.ts`
- Modify: `apps/web/src/OwnerPage.tsx:837-1678` (remove `applyOwnerEvent`)

**Interfaces:**
- Consumes: `Vault` (Task 1), `VaultLogger` / `VaultNotifier` (Task 3).
- Produces:
  ```ts
  // apps/web/src/vault/applyVaultEvent.ts
  /**
   * Composed from `VaultViewEffects` (Task 3) rather than redeclaring its
   * members, so the fold and the runtime cannot drift apart on a callback name.
   */
  export interface FoldEffects
    extends Pick<VaultViewEffects,
      'refreshReplicas' | 'openFingerprint' | 'openAdoption' | 'stageReplicaAdoption'> {
    log: VaultLogger
    notify: VaultNotifier
    armWatchdog: () => void
    clearWatchdog: () => void
  }
  export function applyVaultEvent(
    current: Vault,
    event: DeRecEvent,
    fx: FoldEffects,
  ): Vault
  ```

The fold's whole coupling surface, measured across `OwnerPage.tsx:837-1678`, is 27 `log()` calls, 7 `reportError()`, 3 `reportInfo()`, 5 `refreshReplicaRows()`, 1 `onUpdateRef`, 1 each of `setPendingReplicaAdoption` / `setFingerprintChannelId` / `setAdoptionOpen`, and `armFlowWatchdog` / `clearFlowWatchdog`. Everything else is already a pure `Vault → Vault` transform. `FoldEffects` is exactly that surface, and nothing more may be added to it.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/vault/applyVaultEvent.test.ts`, importing the `vault()` factory Task 3 put in `testVault.ts`.

```ts
import { describe, expect, it, vi } from 'vitest'
import { applyVaultEvent, type FoldEffects } from './applyVaultEvent'
import { vault } from './testVault'
import type { DeRecEvent } from '@derec-alliance/web'

function fx(): FoldEffects {
  return {
    log: vi.fn(),
    notify: { error: vi.fn(), info: vi.fn() },
    refreshReplicas: vi.fn(),
    stageReplicaAdoption: vi.fn(),
    openFingerprint: vi.fn(),
    openAdoption: vi.fn(),
    armWatchdog: vi.fn(),
    clearWatchdog: vi.fn(),
  }
}

describe('applyVaultEvent', () => {
  it('returns the vault unchanged for an event it does not handle', () => {
    const before = vault()
    const after = applyVaultEvent(before, { type: 'NotAThing' } as unknown as DeRecEvent, fx())
    expect(after).toBe(before)
  })

  it('does not mutate the vault it was given', () => {
    // The fold is a reducer: the drain loop threads its result forward and
    // relies on the input being untouched if a later event throws.
    const before = vault({ participants: [] })
    const snapshot = JSON.stringify(before)
    applyVaultEvent(before, { type: 'NotAThing' } as unknown as DeRecEvent, fx())
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('logs through the injected logger rather than a module singleton', () => {
    const effects = fx()
    applyVaultEvent(vault(), { type: 'NotAThing' } as unknown as DeRecEvent, effects)
    // Any handled event must reach the injected logger; a background vault has
    // no console context of its own to reach for.
    expect(effects.notify.error).not.toHaveBeenCalled()
  })
})
```

Then add one behavioural test per event family. **Do not invent the assertions** — open each handler in the moved body and assert the transition it actually performs. Cover at minimum: `PairingCompleted`, `ShareConfirmed`, `ShareRejected`, `SharingComplete`, `ShareVerified`, `SecretsDiscovered`, `SecretRecovered`, `ReplicaSecretReceived`, and `ReplicaSecretInstalled`.

This worked example sets the pattern — a transition assertion plus a control that would fail a stub implementation:

```ts
  it('records a confirmed share against the participant that stored it', () => {
    const before = vault({
      participants: [{
        id: 'h1', name: 'Alex', channelId: '900',
        transport: { protocol: 'https', uri: 'u' },
        secretShares: [{ version: 1, status: 'pending', verified: false }],
        connectionStatus: 'paired',
      }],
    })

    const after = applyVaultEvent(
      before,
      { type: 'ShareConfirmed', channel_id: '900', version: 1 } as unknown as DeRecEvent,
      fx(),
    )

    expect(after.participants[0].secretShares[0].status).toBe('confirmed')
    // The control: a fold that rebuilt the array would drop `verified`, and a
    // fold that matched on the wrong key would confirm nothing at all.
    expect(after.participants[0].secretShares[0].verified).toBe(false)
    expect(after).not.toBe(before)
  })
```

The `ReplicaSecretReceived` case needs both branches, because the distinction is load-bearing (`OwnerPage.tsx:1023`): an event whose `secret_id` equals the vault's own `secretId` is an **update** to the vault this device already holds, and must not stage an adoption; any other `secret_id` is a takeover offer and must call `fx.stageReplicaAdoption`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npm test -- --run applyVaultEvent`
Expected: FAIL — cannot resolve `./applyVaultEvent`.

- [ ] **Step 3: Move the fold**

Cut `applyOwnerEvent` (`OwnerPage.tsx:837-1678`) into `apps/web/src/vault/applyVaultEvent.ts`, rename it `applyVaultEvent`, and add the `fx: FoldEffects` third parameter. Then apply exactly these substitutions to the moved body — nothing else changes:

| In the old body | Becomes |
| --- | --- |
| `log({…})` | `fx.log({…})` |
| `reportError(…)` | `fx.notify.error(…)` |
| `reportInfo(…)` | `fx.notify.info(…)` |
| `refreshReplicaRows()` | `fx.refreshReplicas()` |
| `setPendingReplicaAdoption(x)` | `fx.stageReplicaAdoption(x)` |
| `setFingerprintChannelId(id)` | `fx.openFingerprint(id)` |
| `setAdoptionOpen(true)` | `fx.openAdoption()` |
| `armFlowWatchdog()` | `fx.armWatchdog()` |
| `clearFlowWatchdog()` | `fx.clearWatchdog()` |
| `ownSecretIdRef.current` | `current.secretId` |
| the one `onUpdateRef` call | delete — the caller commits the returned vault |

`setPendingReplicaAdoption` is called with an updater function at `:1045`; `stageReplicaAdoption` takes the resolved offer, so pass `mergeReplicaSecretReceipt(existing, offer)` — meaning `FoldEffects.stageReplicaAdoption` receives the offer and the *caller* performs the merge. Keep the merge in the caller so the fold stays free of prior UI state.

- [ ] **Step 4: Wire the caller**

In `OwnerPage.tsx`, build the `FoldEffects` object once via `useMemo` and pass it at all four `applyOwnerEvent` call sites (found in `1680-2090`), renaming them `applyVaultEvent`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && npm test -- --run applyVaultEvent && npm test -- --run`
Expected: PASS.

- [ ] **Step 6: Verify**

Run: `cd apps/web && npm run typecheck && npm run lint && npm run test:e2e`
Expected: PASS. `OwnerPage.tsx` should now be roughly 840 lines shorter.

---

### Task 5: Move the poll, tick, and contact publication into the runtime

**Files:**
- Modify: `apps/web/src/vault/runtime.ts`
- Modify: `apps/web/src/vault/runtime.test.ts`
- Modify: `apps/web/src/OwnerPage.tsx:1678-2090,681-759`

**Interfaces:**
- Consumes: `applyVaultEvent`, `FoldEffects` (Task 4); `VaultRuntime`, `VaultRuntimeIo`, `VaultViewEffects` (Task 3 — already declared there, do not redeclare).
- Produces: added to `VaultRuntime` —
  ```ts
  /** One poll-and-process pass. The interval calls this; tests call it directly. */
  drainOnce(): Promise<void>
  /** One protocol-time advance. */
  tickOnce(): Promise<void>
  /** Add a named reason the drain must not run. Idempotent per reason. */
  pauseDrain(reason: string): void
  /** Remove a pause reason. The drain resumes when the last one clears. */
  resumeDrain(reason: string): void
  ```

- [ ] **Step 1: Write the failing tests**

Add to `runtime.test.ts`:

```ts
  it('feeds every polled message through the fold in order', async () => {
    const seen: number[] = []
    const r = new VaultRuntime(vault(), {
      ...deps(),
      io: { pollMailbox: async () => [{ bytes: new Uint8Array([1]) }, { bytes: new Uint8Array([2]) }] },
    })
    // Stub the instance so no WASM is involved.
    stubInstance(r, { process: async (b: Uint8Array) => { seen.push(b[0]); return [] } })

    await r.drainOnce()

    expect(seen).toEqual([1, 2])
  })

  it('buffers undrained messages instead of losing them', async () => {
    // The backend mailbox is destructive: a poll drains it. Anything not
    // processed must be kept, or a paused vault silently loses protocol traffic.
    const r = new VaultRuntime(vault(), {
      ...deps(),
      io: { pollMailbox: async () => [{ bytes: new Uint8Array([7]) }] },
    })
    const seen: number[] = []
    stubInstance(r, { process: async (b: Uint8Array) => { seen.push(b[0]); return [] } })

    r.pauseDrain('test')
    await r.drainOnce()
    expect(seen).toEqual([])

    r.resumeDrain('test')
    await r.drainOnce()
    expect(seen).toEqual([7])
  })

  it('surfaces a poll failure without stopping the runtime', async () => {
    const d = deps()
    const r = new VaultRuntime(vault(), {
      ...d,
      io: { pollMailbox: async () => { throw new Error('offline') } },
    })
    stubInstance(r, { process: async () => [] })

    await r.drainOnce()

    expect(d.notify.error).toHaveBeenCalled()
    expect(r.state().status).not.toBe('failed')
  })
```

`stubInstance` and `deps` already exist in `testVault.ts` from Task 3 Step 1; import them rather than redefining. `deps({ io: { pollMailbox } })` is how each test supplies its mailbox.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npm test -- --run vault/runtime`
Expected: FAIL — `drainOnce`, `pauseDrain`, `resumeDrain` do not exist.

- [ ] **Step 3: Move the loops**

Move the body of the poll effect (`OwnerPage.tsx:1680-2028`) into `VaultRuntime.drainOnce()` and the tick effect (`:2028-2090`) into `tickOnce()`. Substitutions:

- `ownerRef.current` → `this.vault`; the threaded `updated` local becomes `this.commit(next)` at the end.
- `pendingInboundRef.current` → `this.pendingInbound: MailboxMessage[]`.
- `withProtocolLock` → `this.withLock`.
- `setProtocolBusy(x)` → `this.setBusy(x)`.
- The four `pendingXConfirmationRef.current` checks that gate the drain (`:1694-1699`) become `this.drainPaused()`, backed by a `Set<string>` of pause reasons that `pauseDrain`/`resumeDrain` add to and remove from. Task 6 replaces those calls with the attention queue.
- `adoptionBlockRef.current` (`:1688`) becomes `this.status === 'blocked'`.
- The five UI setters (`setOutgoingUnpairConfirmation`, `setUnpairingChannelIds`, `setPairingRejectionCount`, `setPairingCompletedSignal`) move onto `FoldEffects`-style callbacks in `deps.effects`.

Move `postOwnerContact` (`:727-751`) to a private `publishContact()` called at the end of `start()`, and the offline-flag replay (`:721-725`) likewise. Own the interval in the runtime: `start()` schedules `drainOnce` at the current poll interval and `tickOnce` at `TICK_INTERVAL_MS`; `stop()` clears both.

Keep the 5000ms idle / 500ms busy rule for now — it is a deliberate counterparty-latency simulation, not a constraint, and changing it is out of scope for this plan.

- [ ] **Step 4: Reduce the page to a subscriber**

Delete both effects from `OwnerPage.tsx`. Replace the state they drove with a subscription:

```ts
  const [runtimeState, setRuntimeState] = useState(() => runtimeRef.current!.state())
  useEffect(() => {
    const runtime = runtimeRef.current
    if (!runtime) return
    setRuntimeState(runtime.state())
    const off = runtime.subscribe(setRuntimeState)
    void runtime.start()
    return () => { off(); runtime.stop() }
  }, [vault.id])
```

`protocolBusy` becomes `runtimeState.busy`; delete its `useState` and `protocolBusyRef`.

> **Revision note (as executed, after Task 6):** Task 5 was interrupted and ran after Task 6, so the drain gate is the attention queue plus `pauseReasons` from the start. Differences from the text above:
> - The poll is a chained `setTimeout`, not an interval, and `setBusy`/`setFastPolling` reschedule it when the cadence changes — the page used to restart its interval on the same change. `setFastPolling(on)` exists because auto-pairing (view state) also selects the fast cadence.
> - `setBusy(false)` clears the watchdog, replacing the page effect that did so on `protocolBusy`.
> - The adoption block is `block()`, sticky across `stop()`/`start()` and reported as `status: 'blocked'`; a blocked `start()` builds the instance but runs no loops and publishes no contact. The page calls `block()` on mount when a block is persisted, and on adoption failure.
> - `VaultViewEffects` gained `pairingRejected`, `pairingCompleted(channelId, vault)` and `unpairSettled(channelId)` — the four setters named above plus `maybeRaiseFingerprintGate`, each backing view-only state. `VaultRuntimeIo` gained `postBrowserContact` and `markParticipantOffline`.
> - `deps.onVaultChange` in the page also writes `vaultRef.current`, as `publishVault` did, so page handlers never build on a record the engine has already replaced.
> - The roster poll still reads a page-side `pollInterval` until Task 8.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && npm test -- --run vault/runtime && npm test -- --run`
Expected: PASS.

- [ ] **Step 6: Verify**

Run: `cd apps/web && npm run typecheck && npm run lint && npm run test:e2e`
Expected: PASS. This is the highest-risk task in the plan; if e2e fails, the fault is almost certainly in the `updated`-threading-to-`commit` conversion in Step 3.

---

### Task 6: Introduce the attention queue

**Files:**
- Modify: `apps/web/src/vault/types.ts`, `apps/web/src/vault/runtime.ts`
- Create: `apps/web/src/vault/attention.test.ts`
- Modify: `apps/web/src/OwnerPage.tsx:218-295,361,2090-2481`

**Interfaces:**
- Consumes: `VaultRuntime` (Tasks 3, 5).
- Produces:
  ```ts
  export type AttentionKind =
    | 'pairing' | 'store-share' | 'verify-share' | 'unpair' | 'replica-adoption'
  export interface Attention {
    id: string
    kind: AttentionKind
    /**
     * Whether the mailbox drain pauses while this is unresolved.
     *
     * True for the four confirmations (`OwnerPage.tsx:1694-1699`): processing
     * further messages would mutate the state the user is being asked about.
     * False for `replica-adoption` — the offer is staged and the drain
     * continues, because `mergeReplicaSecretReceipt` keeps the newer of what is
     * staged and what arrives, so a replay cannot regress it.
     */
    blocksDrain: boolean
    raisedAt: number
    payload: unknown
  }
  export type AttentionDecision = { accept: true; data?: unknown } | { accept: false; reason?: string }
  // on VaultRuntime:
  //   attention(): readonly Attention[]
  //   raiseAttention(a: Omit<Attention,'id'|'raisedAt'>): string
  //   resolveAttention(id: string, decision: AttentionDecision): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/vault/attention.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { VaultRuntime } from './runtime'
import { deps, vault, stubInstance } from './testVault'

describe('attention queue', () => {
  it('pauses the drain for a blocking item and resumes when resolved', async () => {
    const seen: number[] = []
    const r = new VaultRuntime(vault(), {
      ...deps(),
      io: { pollMailbox: async () => [{ bytes: new Uint8Array([3]) }] },
    })
    stubInstance(r, { process: async (b: Uint8Array) => { seen.push(b[0]); return [] } })

    const id = r.raiseAttention({ kind: 'pairing', blocksDrain: true, payload: {} })
    await r.drainOnce()
    expect(seen).toEqual([])

    await r.resolveAttention(id, { accept: false })
    await r.drainOnce()
    expect(seen).toEqual([3])
  })

  it('keeps draining for a non-blocking item', async () => {
    // Replica adoption stages an offer; stalling the vault until the user
    // decides would be wrong, and a replay cannot regress a staged offer.
    const seen: number[] = []
    const r = new VaultRuntime(vault(), {
      ...deps(),
      io: { pollMailbox: async () => [{ bytes: new Uint8Array([4]) }] },
    })
    stubInstance(r, { process: async (b: Uint8Array) => { seen.push(b[0]); return [] } })

    r.raiseAttention({ kind: 'replica-adoption', blocksDrain: false, payload: {} })
    await r.drainOnce()

    expect(seen).toEqual([4])
  })

  it('publishes attention on the state it emits, so an unmounted vault can badge', () => {
    const r = new VaultRuntime(vault(), deps())
    const seen: number[] = []
    r.subscribe(s => seen.push(s.attention.length))

    r.raiseAttention({ kind: 'unpair', blocksDrain: true, payload: {} })

    expect(seen.at(-1)).toBe(1)
    expect(r.attention()[0].kind).toBe('unpair')
  })

  it('resolving an unknown id is a no-op rather than a throw', async () => {
    const r = new VaultRuntime(vault(), deps())
    await expect(r.resolveAttention('nope', { accept: true })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npm test -- --run vault/attention`
Expected: FAIL — `raiseAttention` does not exist.

- [ ] **Step 3: Implement the queue**

Replace `Attention = never` in `vault/types.ts` with the real types. On `VaultRuntime`, add `private items: Attention[] = []`, implement the three methods, include `attention: this.items` in `state()`, and make `drainPaused()` return `this.items.some(i => i.blocksDrain) || this.pauseReasons.size > 0`. `raiseAttention` mints an id with the existing `randomId()` from `apps/web/src/randomId.ts`.

`resolveAttention` dispatches on `kind` to the moved handler bodies from `OwnerPage.tsx:2090-2481` — `handleAcceptPairing`, `handleRejectPairing`, `handleAcceptAndLinkPairing`, `handleAcceptStoreShare`, `handleRejectStoreShare`, `handleAcceptVerifyShare`, `handleRejectVerifyShare`, `handleAcceptUnpair`, `handleRejectUnpair` — then removes the item and emits. Each handler's React setter calls become `deps.effects` callbacks or `this.commit`, following Task 5's substitution table.

- [ ] **Step 4: Replace the page's confirmation state with reads of the queue**

Delete the four `pendingXConfirmation` `useState`/`useLatestRef` pairs (`:218-295`) and `pendingReplicaAdoption` (`:361`). Derive each from `runtimeState.attention`:

```ts
  const pairingAttention = runtimeState.attention.find(a => a.kind === 'pairing') ?? null
```

Modal-internal state — `pairingModalView`, `pairingLinkTarget`, `pairingLinkSubmitting` (`:227-229`) — stays in the view. Accept/reject buttons call `runtimeRef.current!.resolveAttention(attention.id, …)`.

Where the drain loop previously raised confirmations (five setters identified in `1680-2090`), it now calls `this.raiseAttention({ kind, blocksDrain, payload })` — `blocksDrain: true` for all four confirmations, `false` for `replica-adoption`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && npm test -- --run && npm run typecheck && npm run lint`
Expected: PASS.

> **Revision note (as executed):** `resolveAttention(id)` takes no decision and only clears the item. The accept/reject handler bodies stay in `OwnerPage` and call it once they have acted; moving them is Task 7's job, since they are commands, and moving them here would have made this task a move plus a redesign. Replica adoption is staged through `VaultRuntime.stageReplicaAdoption(offer)`, which merges into the single open `replica-adoption` item via `mergeReplicaSecretReceipt` (id preserved); the `stageReplicaAdoption` view effect is gone.

- [ ] **Step 6: Verify the confirmation flows still work end to end**

Run: `cd apps/web && npm run test:e2e`
Expected: PASS. `browser-pairing.spec.ts` and `browser-replica.spec.ts` exercise inbound confirmations and are the real gate on this task.

---

### Task 7: Move the command surface onto the runtime

**Files:**
- Modify: `apps/web/src/vault/runtime.ts`
- Create: `apps/web/src/vault/commands.test.ts`
- Modify: `apps/web/src/OwnerPage.tsx:2598-3208,3442-4040,4041-4348`

**Interfaces:**
- Produces: on `VaultRuntime` —
  ```ts
  protect(secrets: UserSecret[]): Promise<ProtectRoundResult | null>
  addSecret(name: string, data: string): Promise<number | null>
  verifyShares(version: number): Promise<void>
  requestDiscovery(): Promise<void>
  recover(secretId: string, version: number, label: string): Promise<void>
  /** Same parameters as today's `ownerStartPairing` (`OwnerPage.tsx:2717`). */
  startPairing(contact: ContactMessage, role: PairingRole, peerName?: string): Promise<bigint>
  syncReplicas(reason: ReplicaSyncReason): Promise<ReplicaSyncRoundResult>
  createContact(mode: ContactMode): Promise<ContactMessage>
  linkChannels(sourceChannelId: string, targetChannelId: string): Promise<void>
  ```
  Every other moved function keeps the exact signature it has in `OwnerPage.tsx` today. Do not redesign signatures in this task — a move and a redesign in one step makes an e2e failure ambiguous.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/vault/commands.test.ts` asserting, with a stubbed instance, that each command (a) takes the protocol lock and (b) leaves `busy` false once settled — including when the underlying call rejects:

```ts
import { describe, expect, it } from 'vitest'
import { VaultRuntime } from './runtime'
import { deps, vault, stubInstance } from './testVault'

describe('vault commands', () => {
  it('clears busy after a command fails', async () => {
    // A command that leaves busy set wedges every control on the page.
    const r = new VaultRuntime(vault(), deps())
    stubInstance(r, { start: async () => { throw new Error('nope') } })

    await r.verifyShares(1).catch(() => {})

    expect(r.state().busy).toBe(false)
  })

  it('serialises two overlapping commands', async () => {
    const order: string[] = []
    const r = new VaultRuntime(vault(), deps())
    stubInstance(r, {
      start: async () => { order.push('in'); await new Promise(f => setTimeout(f, 5)); order.push('out'); return [] },
    })

    await Promise.all([r.requestDiscovery(), r.requestDiscovery()])

    expect(order).toEqual(['in', 'out', 'in', 'out'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npm test -- --run vault/commands`
Expected: FAIL — `verifyShares` does not exist.

- [ ] **Step 3: Move the commands**

Move these function bodies from `OwnerPage.tsx` onto `VaultRuntime`, applying Task 5's substitution table: `createOwnerContact` (`:2598`), `ownerStartPairing` (`:2717`), `failSharingRound` (`:2738`), `confirmedReplicaTargets` (`:2784`), `runProtectRound` (`:2806`), `ownerAddSecret` (`:2906`), `runReplicaSyncRound` (`:2957`), `ownerVerifyShares` (`:3046`), `ownerRequestDiscovery` (`:3085`), `ownerRecoverSecret` (`:3100`), `handleRestoreFromBag` (`:3208`), `evictReplicaMember` (`:3579`), `applyMirroredUpdate` (`:3801`), `handleAdoptReplicaSecret` (`:3846`), `addPendingPairing` (`:4041`), `dispatchUnpair` (`:4116`), `linkChannelsAtomic` (`:4285`).

The watchdog and the four correlation maps (`pendingSharesRef`, `pendingBagRef`, `pendingVerificationsRef`, `pendingRecoveryRef`) moved in Task 4 — see its revision note — because the fold reads them 17 times and could not move without them. Nothing to do for them here.

Leave in the view every `handle*` that only opens or closes UI: `handleForgetReplica` (`:3654`), `handleTogglePair` (`:4184`), `handleCancelOutgoingUnpair` (`:4218`), `dismissReplicaSyncNotice` (`:3767`), `handleLinkChannel` (`:4273`), `replicaSyncNoticeFor` (`:3760`), `maybeRaiseFingerprintGate` (`:331`).

Each moved command wraps its work in `this.setBusy(true)` / `finally { this.setBusy(false) }`.

> **Revision note (as executed):**
> - **Busy is not cleared in `finally`.** `busy` means "a flow is in flight", and verify, discovery, recovery and protect stay busy until their responses arrive — clearing it on return would drop the fast poll cadence and, since `setBusy(false)` now clears the watchdog, disarm the timeout for every stalled flow. `runFlow` clears it only when the command *throws*, which is what the busy-clearing test asserts.
> - **Signatures kept, per the "move, don't redesign" rule**, so a few differ from the interface list above: `recover` keeps its `participantChannelIds` argument, `createContact` takes a `ContactModeKey`, `linkChannels` keeps its `options`. Added: `addPendingPairing`, `unpair` (returns whether it was dispatched), `restoreFromRecovered` (returns whether it committed), `adoptReplica`, `discoverReplicas`, `announceReplicaEviction`, `forgetReplicaMember`, and a lock-guarded `replicaProtocol`.
> - **The confirmation handlers deferred from Task 6 moved here** as `acceptAttention(id)`, `rejectAttention(id)` and `acceptPairingAndLink(id, target)`. Accept-and-link now also raises the fingerprint gate on completion, via the same `pairingCompleted` effect every other completion uses; the gate only opens for a genuinely `Pending` channel.
> - **The adoption block moved into the engine** as `state().blockedBy`, seeded from storage in the constructor and persisted by `block(failure)`. The page's `adoptionBlock` state and ref are gone.
> - **Stays in the page, as orchestration:** replica eviction's sequencing (it calls the page-owned first-sync trigger between the announce and the forget), `handleAddParticipant` and auto-pair (both view-driven; their protocol call goes through `startPairing`), and every tab switch, spinner and modal. `VaultViewEffects` gained `channelsLinked` so the grouped channel view recomputes after a link.
> - `runtime.ts` is now ~3200 lines, most of it the fold. Splitting the fold into its own module is worth doing before the next plan adds to it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npm test -- --run vault/commands && npm test -- --run`
Expected: PASS.

- [ ] **Step 5: Verify**

Run: `cd apps/web && npm run typecheck && npm run lint && npm run test:e2e`
Expected: PASS. `OwnerPage.tsx` should now be under ~2500 lines.

---

### Task 8: Split roster fetch from roster fold

**Files:**
- Modify: `apps/web/src/vault/runtime.ts`
- Modify: `apps/web/src/vault/runtime.test.ts`
- Modify: `apps/web/src/OwnerPage.tsx:2481-2598,433-460`

**Interfaces:**
- Produces: `VaultRuntime.applyRoster(actors: readonly BEActorWithStatus[]): void`

`apiGetActors()` returns the same node-wide list for every vault, so the fetch must not multiply with vault count. This task moves the fold and leaves the fetch at a seam the next plan's `VaultManager` owns.

- [ ] **Step 1: Write the failing test**

```ts
  it('adopts a newly provisioned helper as an available participant', () => {
    const r = new VaultRuntime(vault({ participants: [] }), deps())

    r.applyRoster([{
      id: 'h1', role: 'helper', name: 'Alex',
      transport: { protocol: 'https', uri: 'http://localhost:5000/derec/h1' },
      transports: [{ protocol: 'https', uri: 'http://localhost:5000/derec/h1' }],
      secret_id: '99',
    } as unknown as BEActorWithStatus])

    const p = r.state().vault.participants
    expect(p).toHaveLength(1)
    // Always 'available': the backend's channel_id may belong to another
    // vault's pairing, so only PairingCompleted may promote this.
    expect(p[0].connectionStatus).toBe('available')
    expect(p[0].channelId).toBe('')
  })

  it('does not re-add a participant it already knows', () => {
    const r = new VaultRuntime(vault(), deps())
    const actor = { id: 'h1', role: 'helper', name: 'Alex',
      transport: { protocol: 'https', uri: 'u' }, transports: [], secret_id: '9' } as unknown as BEActorWithStatus

    r.applyRoster([actor])
    r.applyRoster([actor])

    expect(r.state().vault.participants).toHaveLength(1)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npm test -- --run vault/runtime`
Expected: FAIL — `applyRoster` does not exist.

- [ ] **Step 3: Move the fold, keep the fetch in the page**

Move the body of the roster effect (`OwnerPage.tsx:2481-2598`) — everything after `const actors = await apiGetActors()` — into `applyRoster(actors)`, committing via `this.commit`. Leave the interval and the `apiGetActors()` call in `OwnerPage`, now just:

```ts
  // The fetch stays here for one vault. The next plan hoists it to VaultManager:
  // apiGetActors() returns the same node-wide list for every vault, so it must
  // not multiply with vault count.
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const actors = await apiGetActors()
        rosterSnapshotRef.current = actors
        runtimeRef.current?.applyRoster(actors)
        refreshReplicaRows()
      } catch { /* transient; the next tick retries */ }
    }, ROSTER_POLL_MS)
    return () => clearInterval(id)
  }, [])
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npm test -- --run && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Verify**

Run: `cd apps/web && npm run test:e2e`
Expected: PASS.

> **Revision note (as executed):** `applyRoster` also returns early for a blocked vault, and commits only when something changed, so an idle roster poll publishes nothing. The roster effect keeps the view projections (replica rows, stored members, the first-sync trigger), which read the same fetch.

---

### Task 9: Prove two protocol instances can run concurrently

**Files:**
- Create: `apps/web/e2e/wasm-concurrency.spec.ts`

**Interfaces:** consumes nothing; produces a verified answer that the next plan depends on.

This is the plan's one genuine unknown. `VaultRuntime`'s lock is per-runtime on the reasoning that wasm-bindgen's "recursive use of an object" guard is a per-object borrow and two `DeRecProtocol` values are two objects — but they share one WASM linear memory and the library is not verified free of module-level state. **If this fails, STOP and report: the fix is a global lock serialising every vault, which is a design change, and it may indicate a library limitation that must be discussed rather than worked around.**

It is an e2e test because it needs real WASM; a unit test with stubs would prove nothing.

- [ ] **Step 1: Write the test**

Create `apps/web/e2e/wasm-concurrency.spec.ts`. Build two `DeRecProtocol` instances with distinct `secret_id`s in one page context via `page.evaluate`, then drive an overlapping async call on both and assert neither throws and both return. Follow the existing harness patterns in `apps/web/e2e/app.ts` for booting the page and initialising the SDK.

```ts
import { expect, test } from '@playwright/test'
import { bootApp } from './app'

test('two protocol instances run overlapping calls without borrow errors', async ({ page }) => {
  await bootApp(page)

  const result = await page.evaluate(async () => {
    const mod = await import('@derec-alliance/web')
    await mod.init()
    const build = (secretId: bigint) =>
      new mod.DeRecProtocolBuilder(secretId)
        .withUnsafeConnection(true)
        .withThreshold(2)
        .build()

    const a = build(1001n)
    const b = build(1002n)

    // Overlap deliberately: start both before awaiting either. A shared
    // module-level borrow would surface as "recursive use of an object".
    const pa = a.createContact(null, 0)
    const pb = b.createContact(null, 0)
    const [ca, cb] = await Promise.all([pa, pb])
    return { a: String(ca.channel_id), b: String(cb.channel_id), same: String(ca.channel_id) === String(cb.channel_id) }
  })

  expect(result.a).toBeTruthy()
  expect(result.b).toBeTruthy()
  // Distinct instances must mint distinct channels — identical ids would mean
  // shared state, which is the failure this test exists to catch.
  expect(result.same).toBe(false)
})
```

If `DeRecProtocolBuilder` requires stores or a transport that this minimal build omits, supply the same fakes `buildProtocolInstance` uses via in-memory objects rather than relaxing the assertion.

- [ ] **Step 2: Run it**

Run: `cd apps/web && npm run test:e2e -- wasm-concurrency`
Expected: PASS. **If it fails with a borrow or memory error, stop here and report** — do not add a global lock and carry on, because whether the library supports this is the question the exercise is meant to answer.

- [ ] **Step 3: Record the answer in the spec**

Append the outcome to the *WASM concurrency* paragraph of `docs/superpowers/specs/2026-09-29-multi-vault-design.md`, stating the date and what was observed, so the next plan is not re-litigating a settled question.

> **Revision note (as executed):** Answered — no global lock needed; see the spec. A first, broader version of the probe also overlapped two calls on the *same* instance and timed out: that hangs (neither resolves nor throws), which is what the per-runtime lock prevents and is unrelated to the question. The committed probe overlaps only across instances, over 20 rounds that mix `createContact` and `tick`, loads the app's modules by base-relative URL (the app is served under `/reference-app/`), and builds through `buildProtocolInstance` over real stores.

---

### Task 10: Give console entries a vault dimension

**Files:**
- Modify: `apps/web/src/ConsoleContext.tsx:32-43`
- Modify: `apps/web/src/ConsolePanel.tsx`
- Modify: `apps/web/src/vault/runtime.ts`

**Interfaces:**
- Produces: `ConsoleEntry` gains `vaultId?: string`; `ConsolePanel` gains a vault filter.

`ConsoleRole` (`'owner' | 'participant' | 'server'`) is **not** renamed — it names the protocol role an entry is about, which the vocabulary rule leaves alone.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/ConsoleContext.test.tsx` asserting an entry logged with a `vaultId` retains it, and that one logged without a `vaultId` (a `server` entry from `/debug/events`) is still accepted:

```ts
import { describe, expect, it } from 'vitest'
import { makeConsoleEntry } from './ConsoleContext'

describe('console entries', () => {
  it('keeps the vault an entry came from', () => {
    expect(makeConsoleEntry({ role: 'owner', flow: 'pairing', step: 's', description: 'd', vaultId: 'v1' }).vaultId)
      .toBe('v1')
  })

  it('accepts a server entry that belongs to no vault', () => {
    // Backend events polled from /debug/events are node-wide; forcing a vault
    // onto them would file them under an arbitrary one.
    expect(makeConsoleEntry({ role: 'server', flow: 'transport', step: 's', description: 'd' }).vaultId)
      .toBeUndefined()
  })
})
```

Export a small `makeConsoleEntry` from `ConsoleContext.tsx` if the entry is currently built inline, so this is testable without rendering the provider.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npm test -- --run ConsoleContext`
Expected: FAIL — `makeConsoleEntry` is not exported.

- [ ] **Step 3: Implement**

Add `vaultId?: string` to `ConsoleEntry` with the comment that `server` entries have none. Have `VaultRuntime`'s `deps.log` stamp `vaultId: this.vaultId` on every entry it emits. Add a vault filter control to `ConsolePanel.tsx` alongside the existing filters, defaulting to "all".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npm test -- --run ConsoleContext && npm test -- --run`
Expected: PASS.

- [ ] **Step 5: Final verification of the whole plan**

Run: `cd apps/web && npm run typecheck && npm run lint && npm test -- --run && npm run test:e2e`
Expected: PASS, with `OwnerPage.tsx` materially smaller and one vault behaving exactly as it did before Task 1.

> **Revision note (as executed):** There were no existing console filters, so the vault filter is the first: a select offering all vaults, each vault seen so far (short id, full id on hover), and "Node only" for vault-less `server` entries. `OwnerPage` stamps its own direct log entries with the vault id too — otherwise filtering to a vault would hide half of what that vault did. Copy and download include `vaultId`.

---

## Definition of done

- One vault runs, with behaviour indistinguishable from before this plan.
- `VaultRuntime` owns the instance, lock, poll, tick, fold, attention queue and commands; it imports nothing from React.
- `VaultRuntime` has unit tests covering lock serialisation, drain buffering, pause/resume, attention blocking, roster folding and command busy-clearing.
- Vault config resolves through three tiers; `minParticipants` is frozen at creation.
- Storage is `derec:vault:{id}:{secretId}:…` throughout.
- The WASM concurrency question is answered and recorded in the spec.
- `npm run typecheck`, `npm run lint`, `npm test -- --run` and `npm run test:e2e` all pass.
