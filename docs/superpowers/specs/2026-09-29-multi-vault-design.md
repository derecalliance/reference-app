# Managing many vaults in one browser

## The problem

A DeRec protocol instance is bound to exactly one `secret_id`. That is the
protocol's shape and it is correct: one owner, one secret, one set of helpers,
one replica group. Nothing in the protocol says an *application* may only manage
one of them.

Today this app manages exactly one. A browser context registers one owner actor,
binds one instance to one secret, and every screen is built around it. A
developer who wants a vault for account recovery codes with a laptop as replica
and five helpers, plus a separate vault for wallet seed phrases with no replica
and ten helpers, cannot have both — they are two browser contexts that know
nothing of each other.

This builds the missing layer: an app that manages many vaults, the way a crypto
wallet manages many wallets. Each vault remains an ordinary, independent owner.
Counterparties see unrelated owners protecting unrelated secrets. Only the app
knows they belong to one person.

## Two levels of "secret"

The word is overloaded and every discussion of this feature slides between the
two meanings. The spec uses these terms and nothing else:

| Term | Means |
| --- | --- |
| **User secret** | One named entry a person stores — a seed phrase, a recovery code. Many go in one bag. `UserSecret` in `types.ts`. |
| **Vault** | One DeRec instance: one `secret_id`, one bag of user secrets, its own helpers, channels and replica group. Called a "DeRec secret" in protocol terms. |

Multi-user-secret already works. **This spec is about multiple vaults.**

## Vocabulary: Vault in the app, Owner in the protocol

"Owner" is good protocol vocabulary and poor application vocabulary — a person
does not "create an owner," they create a vault. The rule:

- **Vault** wins in the UI, `types.ts`, storage keys, file and component names,
  and console output.
- **Owner** stays wherever it names the protocol role: `Role::Owner`,
  `POST /owners`, `peerRole: 'owner'`, `ChannelRole`, `sender_kind`, and the
  library's own helper/owner vocabulary.

One line to settle any argument: *a vault is an owner-role actor; the app stops
calling it that at the user.*

## What is already built

This change is much smaller than it first appears, because the repo was written
with multiple instances in mind and in several places says so outright.

**The backend needs no changes at all.** Every store table is keyed
`(actor_id, secret_id)` — `migrations/0001_initial.sql:19-37` spends nineteen
lines arguing why. `instances.rs` is a complete multi-instance map with
channel→secret routing, and `actor.rs:1029-1075` already routes inbound messages
through it. A provisioned helper's own instance holds every owner channel
separated by `channel_id`, each share carrying its own `share_secret_id`, and
discovery already returns a list of `{secretId, version, description}`. Replica
pairing already names its vault explicitly via the `replica_for_owner_secret`
query param (`routes/actors.rs:235-247`).

**On the front end, `Owner` already is a vault.** `ownerPersistence.ts` stores N
of them (`derec:owner:{id}`, `listOwners()`, `loadOwnerById`) with protocol stores
partitioned underneath. `SetupWizard.tsx:126` `StepChoice` is already a
saved-owner picker with paired counts and busy labels. `App.tsx:97` `adoptOwner`
already switches between them. `ownerLock.ts` already enforces one tab per owner.
`protocolDefaults.ts` already implements server-defaults-plus-browser-overrides
with a single merge point.

What is missing is not the substrate. It is that exactly one vault may run at a
time, and that the protocol engine and the UI are the same object.

## Decisions

Five decisions were settled before design, each with its cost accepted.

**Background vaults keep running.** All vaults a tab holds poll, tick and
process. The alternative — only the open vault runs — silently breaks: messages
queue in the backend mailbox and age past `inbound_message_secs`, whose default
is 300s (`config.ts:25`), so a vault unopened for six minutes drains a queue
where every message is rejected as a replay. Protocol time also stops advancing
for an unmounted vault, and `owner/protocol.ts:22-27` notes a publishing round
whose helpers go quiet has nothing else to close it.

**A background vault's confirmation badges; it does not raise a modal.** A
banner fires and the vault row gets an action-needed badge; clicking either
navigates to the vault, where the existing modal opens. Accepted cost: an ignored
badge is easier to miss than a modal, so a badged vault sits stalled and its
queued messages can age past the replay window. Mitigated but not eliminated —
see *Failure modes*.

**One tab runs everything; other tabs are read-only-ish.** Running a vault means
holding its lock, because two tabs draining one destructive mailbox would split
messages arbitrarily. The first tab claims every vault it knows about; a second
tab sees them all as "open in another tab" and can only create or claim. This
costs the current "three tabs for three owners" habit but **nothing in the test
suite**: `app.ts:208`, `browser-pairing.spec.ts:45` and
`browser-replica.spec.ts:38` all use `browser.newContext()`, which has its own
storage and its own Web Locks scope.

**In-app banners only.** No OS-level Web Notifications, no title or favicon
badging. Accepted cost: nothing signals from a backgrounded tab.

**App-level config defaults with per-vault override.** Not per-vault-always (a
default change would mean editing every vault) and not app-level-only (which
would kill running two vaults with different timeouts side by side — exactly the
interop check this app exists for).

## Non-goals

- No migration. Existing persisted state is abandoned; the DB starts blank.
- No OS-level notifications.
- No batched multi-actor mailbox endpoint. It would collapse N polls into one
  request and is a reasonable future optimisation, but it is a backend change and
  polling cadence is not a real constraint (see below).
- No IndexedDB migration for storage quota. Named as a deferral, not solved.
- No full decomposition of `OwnerPage.tsx`. It shrinks substantially as a side
  effect; finishing the job is separate work.

## Data model

`Owner` in `types.ts:263` becomes `Vault`, nearly unchanged in shape — the payoff
of one-actor-per-vault. Renames: `ownerId` → `id` (documented as the owner-role
actor UUID, which is also the storage key, the lock name and the URL segment),
`ownerName` → `name`, `ownSecretId` → `secretId`. Everything else on the record
is already per-vault and stays: `participants`, `secretBag`, `pendingPairings`,
`recoveredSecrets`, `recoveryProgress`, `recoveryFailures`, `heldShares`,
`mainChannels`, `prePairedCount`.

### Configuration has three tiers

Following `protocolDefaults.ts` exactly, including its "store a partial, not a
snapshot" reasoning so a reconfigured node still propagates:

1. Server defaults from `GET /config`.
2. Browser overrides — `derec.protocolDefaults`, partial, already built.
3. **Per-vault overrides — partial, new.**

`effectiveDefaults()` grows a vault-aware sibling and remains the single place
the merge happens.

One value must not follow this pattern. `minParticipants` is the Shamir
threshold passed to `withThreshold`, and shares already distributed depend on
it. It is **resolved once and frozen into the vault record at creation**.
Live-inheriting it would let a browser-default edit retroactively change the
threshold of a vault that has already published. The four behavioural settings —
`protocolTimeoutSecs`, `authenticationMethod`, `unpairAck`,
`autoAcceptUnpairRequests` — are safe to inherit live unless overridden.

### Storage keys

`derec:owner:` → `derec:vault:`, including the `namespace` string passed to
`buildProtocolInstance`. Seven files reference the prefix and four are tests.
`derec:replica-id:{id}` and `derec:replica-state:{id}` stay keyed per vault,
which is already correct. `localData.ts` sweeps the whole `derec:` prefix, so
"Reset browser data" stays complete without changes.

### Two additions

`ConsoleEntry` (`ConsoleContext.tsx:32-43`) gains a `vaultId`, with a vault
filter in `ConsolePanel` — five vaults logging into one unfilterable stream is
unusable. `ConsoleRole` (`'owner' | 'participant' | 'server'`) is untouched: it
names the protocol role an entry is about, which the vocabulary rule leaves
alone. And the `derec:active-owner` sessionStorage pointer splits into *which
vaults this tab runs* (a set) and *which one is on screen* (one id).

## Runtime architecture

The core problem is that `OwnerPage.tsx` — 5238 lines — holds `instanceRef`, the
mailbox poll, the tick, the event fold and every modal in one component, with
the fold calling React setters directly. Running N vaults while showing one
requires separating "runs" from "shows."

Three new units:

**`VaultRuntime`** — plain TypeScript, no React, one per vault. Owns the
`ProtocolInstance`, the per-vault protocol lock, the mailbox poll, the tick, the
contact publication and the event fold. Surface: `start()`, `stop()`, `state()`,
`subscribe(fn)`, a lock-guarded `protocol` façade (the `ReplicaProtocol` shape at
`OwnerPage.tsx:588` is already this and generalises), and the attention API
below. Being React-free is the point — it becomes unit-testable against a fake
mailbox, which none of this logic is today.

**`VaultManager`** — holds `Map<vaultId, VaultRuntime>`, acquires and releases
locks, starts and stops runtimes, and owns the one shared `apiGetActors()` poller
that fans out to each runtime's fold. `apiGetActors()` returns the same node-wide
list for every vault, so the fetch is shared and only the fold is per-vault. Also
the aggregation point for attention and notifications.

**`<VaultRuntimeHost vaultId>`** — mounts once per running vault at the app root,
renders `null`, and exists only to bind a runtime's lifetime to React's.

### The attention queue is the interface

Four confirmations gate the mailbox drain today — pairing, store-share,
verify-share and unpair (`OwnerPage.tsx:1694-1699`) — by holding React state.
A fifth decision, `pendingReplicaAdoption` (`OwnerPage.tsx:361`), does **not**
gate it: the offer is staged and the drain continues, because
`mergeReplicaSecretReceipt` keeps the newer of what is staged and what arrives,
so a replay cannot regress it.

All five become typed, vault-scoped `Attention` items on the runtime, resolved by
`resolveAttention(id, decision)` — but the queue must preserve that difference,
so an item carries whether it blocks the drain. Collapsing the two would either
stall a vault that need not stall, or drain a destructive mailbox underneath a
question the user is still being asked. `pendingInboundRef` moves with the
blocking items, because that buffer is what makes pausing safe.

That one move buys three things: a background vault can raise attention with no
view mounted, the manager can aggregate it into badges and banners, and the
active vault's view renders the real modal by reading its own runtime.

`adoptionBlock` (`OwnerPage.tsx:500`) moves into the runtime as a stopped-state.
It already gates all three loops (1688, 2032, 2485) and is already per-vault; it
only looks app-global because `OwnerPage` is the whole page. As runtime state, a
blocked vault stops itself while other vaults keep running, and
`ReplicaAdoptionBlockedScreen` becomes that vault's view of it.

### The split rule

Written down because otherwise this turns to mush: **if it needs no DOM, it
belongs to the runtime.** Instance lifecycle, polling, ticking, folding events
into the vault record, the attention queue, offline-flag replay. Everything else
— modal rendering, tabs, panels, reveal toggles, dialog open/close — stays in the
view.

### Cost

N mailbox polls plus N ticks. The current 5000ms idle / 500ms busy cadence
(`OwnerPage.tsx:1678`) exists to simulate a human counterparty, not to satisfy a
constraint, so it is freely tunable and does not bound the design. The shared
roster poller is worth doing precisely because it is the one loop that need not
multiply.

## Notifications and the vault list

Three tiers decide where anything a vault produces goes:

| Tier | What | Where | Lifetime |
| --- | --- | --- | --- |
| Console | every protocol event, as today | `ConsolePanel`, filterable by vault | permanent |
| Banner | terminal outcome of a flow | in-app toast naming the vault, click to navigate | transient |
| Badge | anything needing a decision | vault row in the list | until resolved |

Banners fire for outcomes a user would otherwise miss: a sharing round completing
or failing, a verification result, a peer completing a pairing, a recovery
outcome, a peer-initiated unpair, a watchdog timeout. Per-helper chatter
(`ShareConfirmed` × 7) rolls up to the round rather than firing seven banners.
Badges are the attention queue rendered — not a parallel notion of "unread."

**Banners fire only for vaults that are not on screen.** The active vault reports
in place exactly as it does today — progress dialog, inline statuses, existing
toasts. So no current in-vault UX changes and there is no double-reporting to
reconcile.

`Toast` gains an optional `vaultId` and an optional click action;
`Toast.tsx:83` currently hardwires click-to-dismiss, which becomes
dismiss-or-navigate. `reportError` / `reportInfo` gain vault-scoped siblings.
Additive — existing call sites keep working.

### The list

The vault list becomes the home screen, promoted out of `SetupWizard`'s
`StepChoice`, which already renders most of a row. Each row shows: name; running
or locked-by-another-tab; paired participant count; current bag version; replica
count; attention badge. Plus "New vault," which is today's wizard minus the
saved-owner step — so `FLOW_STEPS` collapses and the wizard goes back to doing
one job.

`listOwners()` / `OwnerSummary` (`ownerPersistence.ts:207-221`) become
`listVaults()` / `VaultSummary` under the vocabulary rule. They currently read
full records from storage to build summaries; live rows should read from running
runtimes instead, falling back to storage for vaults this tab cannot run.

## Navigation and lifecycle

**Hash routing, no new dependency.** There is no router today and none in
`package.json`. `CLAUDE.md` pins "served from GitHub Pages until strictly not
possible," and a path deep-link like `/reference-app/vault/abc` 404s on Pages
without SPA-fallback config. So `#/` is the list and `#/vault/{id}` is a vault,
driven by a small `useHashRoute` hook. `BASE_PATH` (`App.tsx:54`) is untouched.
The segment is the vault id — deliberately not the `secret_id`, so nothing
protocol-sensitive lands in the URL. Reload restores the vault on screen; a
banner click sets the hash.

**Boot.** Enumerate stored vaults → attempt a lock on each
(`acquireOwnerLock` is already non-blocking via `ifAvailable`) → start a runtime
for each locked one → render the rest as "open in another tab." The tab claims
eagerly rather than claiming only what is displayed.

N vaults means N `buildProtocolInstance` calls and N `postOwnerContact()` backend
calls at boot, so **the list must not wait on them**. It renders from storage
immediately and rows flip to running as runtimes come up, in parallel. That also
gives an honest place to show a vault that failed to start.

**Transitions.** Create: register the owner actor → lock → persist → start
runtime → navigate. Leave/delete: today's two-option dialog (`App.tsx:249`) moves
onto the vault, becoming stop-and-release versus that plus `clearNamespace` and
record deletion. `pagehide` releases every held lock rather than one.
`App.tsx`'s `lockRef` becomes `Map<vaultId, OwnerLock>`; `acquireOwnerLock` and
`heldOwnerIds()` need no changes.

**Claiming.** A vault locked by another tab is listed but not running. When that
tab closes the lock frees and this tab does not find out. Rather than
lock-stealing on a timer — surprising, and it could yank a vault from a tab
mid-flow during a race — those rows get an explicit **Claim** button.

**What read-only-ish means**, precisely: name and last-known counts from storage,
no live state, and no actions but Claim and Remove-from-browser. Not a read-only
view of a running vault — the stored record with a claim affordance.

## Failure modes

**Staleness** is the accepted price of badge-not-modal. A badged vault stops
draining and its messages age against the 300s replay window. Three mitigations:
the badge appears in the list *and* as a global indicator while a different vault
is on screen; a stale-rejected message logs a visible console entry rather than
vanishing; the behaviour is documented. **To verify during implementation:**
whether the library surfaces a distinguishable error for a replay-window
rejection. If it does not, that is a real gap to name rather than paper over.

*Answered (SDK 0.0.6):* it does. A message dropped for age arrives as
`MessageIgnored { channel_id, reason: 'Expired', trace_id }`, distinct from
`reason: 'PendingVerification'` (a channel this device has not yet confirmed).
`fold/outcomes.ts` logs each one to the vault's console naming the channel, so
a message that aged out while its vault sat badged is visible rather than
silently gone. It raises no banner: there is nothing the owner can do about it
but ask the peer to send again.

**Isolation.** A vault that fails to build its instance shows "failed to start"
with a retry on its row and must not take down the list or other runtimes — today
a throw in the init effect has nowhere good to go. Errors from a background vault
are attributed via the toast's `vaultId`; an unattributed error from an invisible
vault is worse than none.

**Storage quota** is the highest residual risk after WASM concurrency.
`persistOwner` swallows quota failures silently
(`ownerPersistence.ts:73-75`) — defensible with one vault, data loss with ten.
Minimum fix: surface the failure. Solving it properly is deferred.

**Non-secure origins.** `ownerLock.ts:47-49` degrades to no-locking where Web
Locks are unavailable, by design. With N vaults that means two tabs both running
everything and splitting each mailbox. Pre-existing, now N× worse, so it is
documented rather than silently inherited.

**WASM concurrency** is the one assumption that could change the design. The
protocol lock is per-runtime, which should be right: wasm-bindgen's "recursive
use of an object" guard is a per-object borrow and two `DeRecProtocol` instances
are two objects. But they share one WASM linear memory and the library has not
been verified free of module-level state. If the assumption fails, the fix is a
global lock serialising every vault — a design change, not a bug fix. Hence its
position in the sequence below.

*Answered 2026-09-30 (`apps/web/e2e/wasm-concurrency.spec.ts`, SDK 0.0.5): the
per-runtime lock holds.* Two instances built by `buildProtocolInstance` over
separate namespaces in one page ran 20 rounds of overlapped cross-instance calls
— `createContact` on both at once, and `createContact` on one while the other
runs `tick` — with no error and no channel id minted by both. No global lock is
needed. One thing the probe turned up along the way: two overlapping calls on the
*same* instance neither resolve nor throw "recursive use of an object" — they
hang silently. So the per-runtime lock is load-bearing, and a call that bypasses
it will show up as a stuck flow, not an error.

*Why it hangs (traced 2026-09-30, wasm-bindgen 0.2.126).* The SDK's async
exports take `&mut self`. wasm-bindgen's generated code takes that borrow inside
`future_to_promise(async move { … })`, so it happens when the future is first
polled on a microtask, not when JS calls the method. The second call's borrow
fails there; with `panic = abort` (the default for this target) `borrow_fail`
is `throw_str`, a JS exception thrown straight through the WASM frames, which
escapes the microtask as an uncaught error. Nothing ever calls the promise's
resolve or reject. The first call completes, the instance is usable afterwards,
and other instances are unaffected. The app now installs a global listener
(`wasmBorrowGuard.ts`) that turns this error into a toast, and
`wasm-concurrency.spec.ts` pins the behaviour so an SDK change to it is noticed.
The library could avoid it altogether by exporting `&self` methods over an
internal async mutex — a conversation for the SDK, not a change made here.

## Testing

The real win is that `VaultRuntime` becomes unit-testable against a fake mailbox
and fake stores. None of this logic has unit coverage today. That is where the
attention queue's pause/resume semantics, the three-tier config merge and the
frozen-threshold rule get tested.

Key renames touch `ownerPersistence.test.ts`, `replicaIdentity.test.ts`,
`replicaPairingConsent.test.ts` and `stores.test.ts`. `replicaFlows.test.ts`
(2096 lines) should be nearly untouched, since the flows themselves do not
change — if it is not, that is a signal the extraction went further than
intended.

e2e is unaffected by the locking change and gains two specs: two vaults in one
context, asserting that A's bag, version and participants do not leak into B; and
a background vault raising a badge.

## Sequencing

Binding, because it determines what any failure means.

1. **Rename, data model, config tier.** One vault. Existing suite green.
2. **Extract `VaultRuntime` and the attention queue.** Still one vault. Existing
   suite green.
3. **WASM concurrency probe** — two vaults publishing concurrently — before
   anything depends on the answer.
4. **`VaultManager`, N runtimes, locking, list, hash routing.**
5. **Notifications, console vault dimension, badges.**

Steps 1 and 2 are pure refactor validated by the existing suite, so a regression
there is unambiguously the refactor. Multi-vault arrives only at step 4, on top
of something already proven. Step 3 sits where it does because a failure there
changes the architecture rather than costing a fix.
