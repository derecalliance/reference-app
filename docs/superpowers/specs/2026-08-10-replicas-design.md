# Replicas — Design

**Date:** 2026-08-10
**Status:** Proposed
**Scope:** Replica identity, pairing, fingerprint confirmation, secret mirroring, and destination takeover — for both provisioned and browser-based replicas.

---

## 1. Context

A **replica** is a second device belonging to the *same Owner*, mirroring that Owner's secret so the secrets survive device loss without running full helper-based recovery.

This is the key distinction from a participant:

| | Participant (Helper) | Replica |
|---|---|---|
| Who | A **different person** | The **same person's other device** |
| Holds | A VSS **share** | The **whole secret** + every helper's share |
| Purpose | Contributes to recovery | Stands in for the source |

The reference app already implements Owner↔Helper flows end to end. Replicas are the missing half.

### Existing code disposition

An earlier replica implementation exists and is **out of date. It is superseded by this design and should be removed rather than adapted.** It is catalogued here only so nothing is missed during removal:

- `apps/web/src/OwnerSessionPage.tsx` — ~270 replica references (UI, handlers, wiring)
- `apps/web/src/types.ts` — `PairedReplica`, `ReplicaStatus`, `RecoveredSecretReplica`
- `apps/web/src/api.ts` — `apiAddReplica`, `apiGetReplicaFingerprint`, `apiConfirmReplicaFingerprint`, `apiToggleReplicaStatus`
- `apps/backend/src/routes/replicas.rs` — whole file
- `apps/backend/src/routes/sessions.rs` — `add_replica`, replica branches of `provisioned_actor` / `spawn_provisioned`
- `apps/backend/src/actor.rs` — replica event arms, `replica_id` config
- `apps/backend/src/state.rs` — `replica_channels`, `replica_confirmed`, `disabled_replicas`

Why it cannot be patched forward: the protocol wiring was never connected. `roleToSenderKind` collapses a replica to `SenderKind.Helper`, so a "replica pairing" established a plain Owner↔Helper channel; the browser Owner was built without a `replicaId`, so any replica flow would have returned `ReplicaIdNotConfigured`; and the backend granted `replica_id` only to `Role::Replica`, never to the source. The receiving-side event handlers were written but unreachable. The surviving *shape* of the UI may be reused as reference, but no code path should be assumed correct.

---

## 2. Protocol grounding

Verified against `lib-derec` (`library/README.md`, `library/src/protocol/handlers/restore.rs`, `cryptography/src/replica/mod.rs`, `library/target/pkg-web/index.d.ts`).

**Roles are unidirectional**, like Owner↔Helper:

| SenderKind | Role |
|---|---|
| `ReplicaSource` | Owns the secret. Drives `ProtectSecret`, pushes updates. |
| `ReplicaDestination` | Receives the secret. Stores `Secret` + share map. |

**Replica identity.** A stable per-device `u64` travels in the reserved `derec.replica_id` `CommunicationInfo` key, set once via `withReplicaId()` at builder time. Any replica-mode flow on a protocol built without it fails with `ReplicaIdNotConfigured`. **Both sides need one** — the source no less than the destination.

**Fingerprint confirmation is mandatory and bilateral.** Replica channels land in `ChannelStatus::Pending` after the handshake and are **not eligible as `ProtectSecret` targets** until confirmed. The fingerprint is a 16-digit decimal code formatted `XXXX-XXXX-XXXX-XXXX`, derived deterministically from the 32-byte shared key (`SHA-256(K)`, split into 16 two-byte chunks, each `% 10`), so both devices compute the same value. Each side calls `verifyFingerprint(channelId, peerCode)` with the *other's* code. Match → `Paired`; mismatch → returns `false`, channel stays `Pending`, retry permitted.

**Distribution fans out two payload shapes from one `start(ProtectSecret)` call.** Helpers receive the usual VSS share via `StoreShareRequest`. Destinations receive a typed `ReplicaSecretPayload { secret: Secret, shares: Vec<ChannelShare> }` — the full secret *plus every helper's share keyed by `channel_id`*. That payload is what lets a destination act in the source's place without re-collecting shares.

**Events:** `ReplicaPaired { peer_replica_id }` (fires alongside `PairingCompleted`), `ReplicaSecretReceived { secret, shares, from_replica_id }` on the destination, `ReplicaSecretAcked { from_replica_id }` back on the source.

**`replyTo` routing.** When a replica sends a request on a channel the helper paired with the *sibling* device, the helper's stored peer endpoint points at the sibling. `replyTo` overrides the response destination for that exchange without persisting it. `withAutoReplyTo(true)` stamps it on every outbound request.

---

## 3. Constraints and non-goals

These are current product constraints, not protocol limits. Each is a future feature.

**C1 — One user per browser context.** The frontend cannot hold two users simultaneously. To set up a replica, the user opens a **separate browser context**: incognito window, different Chrome profile, or a different browser. Consequence: no device-switcher UI, no two live protocol instances in one tab, and storage isolation between devices comes free from the browser rather than from application namespacing.

**C2 — One vault per user.** The frontend does not support multiple vaults. A device that pairs as a replica and syncs therefore **erases its existing state and adopts the source's vault as its own**. There is no coexistence of two secrets on one device.

**Non-goals for this spec:**
- Multi-identity or multi-vault support in a single browser context
- Automatic/silent adoption without user confirmation
- Replica-to-replica (sibling) pairing; only Source↔Destination
- Production-grade key custody or auth (consistent with reference-app v1 goals)

---

## 4. Identity model

Three ids are in play. Conflating them is precisely what broke the previous implementation, so they are stated explicitly.

| Id | Scope | Rule |
|---|---|---|
| `secretId` | The secret / vault being protected | **Shared.** After adoption the destination operates under the **source's** `secretId`. |
| `replicaId` | Per **device**, stable | **Distinct per device.** Both source and destination require one. |
| `namespace` (`ns`) | Local store partition | Distinct per device — satisfied automatically by C1 (separate browser contexts). |

> **A replica destination is: the source's `secretId`, its own `replicaId`, its own browser context.**

### Why the destination must adopt the source's `secretId`

Not a stylistic choice — three independent constraints force it:

1. `restore.rs` reseats **"the protocol's `secret_id` namespace"**, writing canonical helper/replica channel records and then unpairing every other channel under that `secret_id`.
2. The backend keys shares as `(secret_id, channel_id, version, replica_id)` (`stores.rs:295`). A destination querying helpers under a different `secret_id` misses every lookup.
3. The `Secret` snapshot carries the helper roster with each `channel_id`, `transport_uri`, and `shared_key`. Those reseated channel ids need the source's namespace to attach to.

Note that `replica_id` is deliberately part of the share key. `stores.rs:200-204` records that it is there "by contract": two distinct replicas may write the same `(secret_id, channel_id, version)` independently, and a store ignoring the discriminator would silently drop one of them. Helpers therefore already distinguish source from destination under a shared `secret_id` — which is what makes takeover addressable at all, and confirms that two devices operating in one namespace is an anticipated case rather than a workaround.

---

## 5. Architecture

### 5.1 Frontend modules

The replica surface is built as **new focused modules, not additions to `OwnerSessionPage.tsx`** (currently ~270KB — adding three flows to it is how the previous attempt became unmaintainable).

| Module | Responsibility | Depends on |
|---|---|---|
| `replicaIdentity.ts` | Mint + persist this device's stable `replicaId`; expose it for builder config. Pure, no protocol dependency. | `localStorage` |
| `replicaFlows.ts` | Drive pairing, fingerprint exchange, and adoption. No JSX. | protocol instance, `api.ts` |
| `ReplicaPanel.tsx` | Replica list, pair action, status. Presentation. | `replicaFlows.ts` |
| `ReplicaFingerprintDialog.tsx` | Display local code, capture peer code, call verify. | `replicaFlows.ts` |
| `ReplicaAdoptionDialog.tsx` | The destructive-wipe confirmation gate. | `replicaFlows.ts` |

`OwnerSessionPage.tsx` retains only mount points and the protocol instance it already owns.

**Shared, not duplicated:** protocol construction stays in `buildProtocolInstance`, extended so `replicaId` is always supplied. Both the owner instance and the post-adoption instance go through it.

### 5.2 Backend

| Concern | Design |
|---|---|
| Replica actors | A replica is an actor with `Role::Replica`, either provisioned or `browser_managed` — mirroring the existing participant split. |
| `replica_id` | Assigned to **every** actor at spawn, regardless of role. Any actor may participate in replica pairing; the source is an Owner. |
| `secret_id` | A **provisioned** replica inherits the `secret_id` of an **explicitly named owner** (`owner_actor_id` on the add-replica request), not "the session's owner" — a session may hold several `Role::Owner` actors, since the invite/join flow mints independent owners by design. A **browser** replica joins as an ordinary owner with its own `secret_id`, and adopts the source's at first sync. |
| Mailbox | **A browser replica is an ordinary owner actor.** It joins the session through the normal join flow, gets the usual owner mailbox, and polls it as `'owners'`. There is no browser-managed `Role::Replica` actor and no `'replicas'` mailbox role. `Role::Replica` exists only for **provisioned** replicas. |
| Fingerprint endpoints | Resolve **both** provisioned and browser actors. The previous provisioned-only resolution is the reason browser replicas had no path. |

Handlers stay thin: extract → validate → delegate → map to HTTP, per the backend guidelines. Fingerprint retrieval/verification is delegated to the actor; the route layer holds no protocol logic.

---

## 6. Flows

### 6.1 Pairing and fingerprint confirmation

```
Owner (context A, ReplicaSource)         Replica (context B, ReplicaDestination)
─────────────────────────────────        ────────────────────────────────────────
adds replica to session          ──────► joins session as browser_managed
                                          Role::Replica; gets mailbox URI
initiates pairing                ──────► handshake
   channel: Pending                        channel: Pending
   ReplicaPaired{peer_replica_id}          ReplicaPaired{peer_replica_id}

getFingerprint(channelId)                 getFingerprint(channelId)
        └──── human compares out of band ────┘
verifyFingerprint(ch, peerCode)           verifyFingerprint(ch, peerCode)
   → Paired                                  → Paired
```

Both sides confirm via explicit UI action (per decision D2). A mismatch returns `false`, leaves the channel `Pending`, and is presented as retryable — not an error state.

Provisioned replicas follow the identical protocol path; the human clicks confirm for both sides in the UI.

### 6.2 Mirroring

Once the destination channel is `Paired`, the source includes it as a `ProtectSecret` target alongside helpers. One `start` call, two payload shapes:

- helpers → VSS share (`StoreShareRequest`)
- destinations → `ReplicaSecretPayload { secret, shares }`

Destination raises `ReplicaSecretReceived`; source receives `ReplicaSecretAcked`.

### 6.3 Adoption (wipe-and-restore)

Triggered by `ReplicaSecretReceived`, **gated on explicit user confirmation** (decision D3):

```
ReplicaSecretReceived { secret, shares }
  → confirm: "This erases this device's vault and replaces it with <owner>'s."
  → clearNamespace(ns)
  → buildProtocolInstance({ secretId: <source's>, replicaId: <own>, ... })
  → restore(secret, version)
  → drain returned events (one Unpaired per wiped channel)
```

**This reuses the existing recovery path, not a new mechanism.** `OwnerSessionPage.tsx:6023` already builds a fresh instance at another secret's `secretId` and calls `restore(...)`, draining teardown events. `index.d.ts` documents `SecretRecovered.secret` as mirroring `ReplicaSecretReceived.secret`. The replica path differs only in its trigger.

**Clearing first is load-bearing.** `restore` rejects, before any store mutation, on:
- `AlreadyRestored` — a user-secret snapshot already exists for this `secret_id`
- `Conflict` — a channel already occupies a canonical helper/replica id (carries the colliding `channel_ids`)

Wiping makes both unreachable. The C2 product constraint and the library's preconditions point the same way.

**The source↔destination channel survives.** `Secret.replicas` exists specifically to "rebuild replica channels without re-pairing," so restore reseats it; the destination keeps receiving syncs without a second pairing.

### 6.4 Takeover

After adoption the destination holds the secret, the helper roster (with `shared_key` and `transport_uri` per helper), and every helper's share. It can therefore drive `VerifyShares`, `ProtectSecret`, and `RecoverSecret` against those helpers directly.

One protocol requirement: helpers' stored peer endpoints point at the **source** device. The destination must therefore set **`withAutoReplyTo(true)`**, so each outbound request carries `replyTo = own_transport` and responses route back to it. This is the documented motivating case for `replyTo`.

---

## 7. Error handling

| Condition | Handling |
|---|---|
| `ReplicaIdNotConfigured` | Prevented structurally — `replicaId` is always supplied at build. Treated as a programming error if seen. |
| Fingerprint mismatch | `verifyFingerprint` → `false`. Channel stays `Pending`. Surfaced as retryable, both codes redisplayed. |
| `ProtectSecret` targeting an unconfirmed destination | Destination is ineligible until `Paired`. UI must not offer sync before confirmation; backend rejects with a clear conflict. |
| `restore` → `AlreadyRestored` / `Conflict` | Should be unreachable after wipe. If raised, surface verbatim including `channel_ids` — it signals the wipe failed, and silently retrying would corrupt state. |
| Adoption declined by user | Nothing is wiped. The mirrored payload is discarded; channel remains `Paired` and a later sync can re-offer. |
| Mailbox/transport failure mid-adoption | The snapshot write is `restore`'s commit point; nothing is removed before it succeeds, so a failed attempt is detectable as a precondition on retry. |

Backend errors follow the existing structured-JSON convention with intentional status codes; no internal detail leaks.

---

## 8. Testing

**Unit (pure, deterministic):**
- `replicaIdentity` — mint/persist/reload stability
- sender-kind mapping — all three roles, including that a replica never maps to `Helper` (the previous defect)
- fingerprint formatting/parsing at the UI boundary

**Integration:**
- Backend: replica actor spawn assigns `replica_id`; provisioned replica inherits the owner's `secret_id`; fingerprint endpoints resolve both provisioned and browser actors
- Adoption: after `clearNamespace`, `restore` completes without `AlreadyRestored`/`Conflict` — this is the specific failure mode clearing exists to prevent, so it is asserted rather than assumed

**Manual (cross-context, cannot be automated under C1):**
- Two browser contexts: pair → compare codes → confirm both sides → sync → confirm adoption → verify destination holds the vault
- Mismatch path: entering a wrong code leaves the channel `Pending` and permits retry

---

## 9. Risks and open assumptions

Recorded rather than resolved. Each should be verified during implementation.

**R1 — `snapshotToPayload` reuse (medium).** `index.d.ts` documents `ReplicaSecretReceived.secret` and `SecretRecovered.secret` as mirrors, but that the existing `snapshotToPayload` helper accepts the replica payload **unchanged is unverified**. If shapes diverge, a sibling adapter is needed. Verify before relying on the recovery path wholesale.

**R2 — Provisioned replica `secret_id` inheritance (medium).** `provisioned_actor` currently assigns every actor a random `secret_id`. Making a provisioned replica inherit the owner's may interact with the actor spawn path in ways not yet traced.

**R3 — Takeover against live helpers (medium).** `withAutoReplyTo(true)` is documented as the fix for sibling-endpoint routing, but takeover has not been exercised end to end in this app. Helper-side behaviour when two devices act under one `secret_id` with distinct `replica_id`s is understood from the share-key contract, not from observation.

**R4 — Scope coupling (accepted).** Pairing, mirroring, and takeover are specced together at the user's explicit direction after a decomposition proposal was declined. The risk is that takeover assumptions rest on a pairing layer not yet built. Mitigated by the finding that adoption reuses the proven recovery/restore path, which materially shrinks the takeover surface.

---

## 10. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Second device = separate browser context; same backend session | C1. Storage isolation for free; no device-switcher. |
| D2 | Fingerprint confirmed by explicit human action on **both** sides | Faithful to the out-of-band intent; best for interop demos. |
| D3 | Destination wipes on **first sync, with confirmation** | Destructive step stays explicit and reversible until the click. |
| D4 | **A browser replica joins as an ordinary owner; the replica relationship is established at PAIRING time by explicit role choice** | Corrected 2026-08-10 after implementation. There is no separate browser-replica entry point. Bob joins the session exactly as any browser user does — as an owner — then pairs with Alice choosing `ReplicaSource` or `ReplicaDestination`, the same way Owner↔Helper pairing already works: unidirectional, role explicit at pairing. The superseded design (a `browser_managed` `Role::Replica` actor with its own mailbox) required a `'replicas'` polling role and a bespoke entry point that never existed, and was the root cause of finding F1. |
| D7 | **Pairing as `ReplicaDestination` shows an erase-warning modal; the actual wipe still happens at first sync** | The user consents up front that pairing this way means this device's vault will be erased and replaced. The destruction itself still occurs at `ReplicaSecretReceived` behind the existing confirmation (D3), so consent sits next to the act. |
| D8 | **Sync fires immediately once a replica destination reaches `Paired`** | So pairing and adoption are contiguous in practice: the source pushes the secret as soon as bilateral fingerprint confirmation promotes the channel, rather than waiting for a manual protect round. |
| D5 | Existing replica code is removed, not adapted | Protocol wiring was never connected; shape may inform, code should not be trusted. |
| D6 | Replica UI lives in new modules, not `OwnerSessionPage.tsx` | The 270KB god-component is how the previous attempt became unmaintainable. |
