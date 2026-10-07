# Node Separation and Admin UI — Design

**Date:** 2026-09-01
**Status:** Approved for planning
**Supersedes:** the architecture section of `CLAUDE.md` (rewritten as a deliverable of this work)

## Summary

The reference app is split into two independent nodes that share no state and
communicate only over HTTP: an **Owner node** and a **Helper + Admin node**. The
Owner becomes a self-contained application that runs against any DeRec server,
including third-party implementations. Helper management moves out of the setup
wizard into a dedicated **Admin UI**. The `Replica` actor kind is removed —
replica becomes a pairing mode available on any helper.

Backend state moves from memory to **SQLite or PostgreSQL**, under a schema that
is forbidden from distinguishing provisioned actors from real ones. Helper actors
run under an **Actix `Supervisor`**, which persistence makes meaningful: a
restart recovers rather than resets.

This is a redefinition of the application, not an incremental change. Existing
code is reference material and a source of reusable parts, not a constraint.

## Motivation

The DeRec Alliance shifted from a hosted deployment to a Docker image developers
run locally. That changes what the app is for: it must work as an interoperable
reference *and* as a testing tool a developer points at their own implementation.

Three problems block that today:

1. **The Owner cannot stand alone.** It assumes a backend that also hosts its
   helpers, so it cannot be pointed at someone else's server.
2. **The setup wizard is doing an operator's job.** It provisions helpers and
   sets server-wide policy because there is no admin surface. Those powers belong
   to an operator, not to every browser tab that opens the app.
3. **Replicas are a separate actor kind** for an implementation reason
   (`secret_id` binding), not a protocol one. A developer testing replica flows
   should just pair a helper against an owner.

A follow-up spec covers Docker packaging. This spec is a prerequisite for it.

## Constraints

**The protocol is the source of truth and cannot be modified.** `../lib-derec` is
available read-only, for understanding intent. No change to the SDK, the
protobufs or the protocol is in scope; if something appears to require one, that
is a signal the design is wrong, not that the SDK should change.

This design needs no SDK change. The one place it might have — mutating
`timeouts` / `unpair_ack`, which are `pub(crate)` with no runtime setters — is
solved by the rebuild primitive using the SDK's `pub` store fields.

**Verify SDK facts against the pinned published versions, not the local
checkout.** The app builds against `derec-library` / `derec-proto` 0.0.2 from
crates.io and `@derec-alliance/web` 0.0.2 from npm (pinned, because the package
publishes under the `alpha` dist-tag while `latest` lags). The local
`../lib-derec` is on `feature/grpc_support` and may diverge. The authoritative
copy for Rust API questions is the vendored source under
`~/.cargo/registry/src/*/derec-library-0.0.2/`.

**Sequencing.** The frontend and backend are reshaped to this design *before* any
Docker work. Packaging a stack that is still moving would mean solving the same
problems twice; once the nodes and modes exist, the image is close to mechanical.

## Guiding principle: behave like real DeRec actors

Any Owner↔Helper interaction that has a protocol equivalent MUST use the real
protocol. Only genuinely out-of-band steps may be shortcut — contact exchange and
operator decisions — and a shortcut MUST mirror what the out-of-band channel
actually does.

Consequences:

- The bundled Owner reaches helpers over the published HTTP port, never through
  shared memory. There is no privileged in-process path.
- Pre-pairing is legitimate: the Owner fetches a contact through the discovery
  API and then runs a **real** pairing, exactly as if the payload had arrived by
  QR code.
- Helpers auto-accept and auto-confirm because they are unattended bots, which is
  what a real helper's *user* would otherwise do. They do not skip protocol steps.

### Helpers are ordinary DeRec actors

A helper is not a special internal type. It is a complete DeRec actor that
happens to have **no UI and a deliberately limited API** — only the operations
this spec exposes. What a helper can do follows from what is exposed, not from a
capability model:

- **Pairing is exposed**, so pairing two helpers against each other is
  legitimate and supported (`POST /admin/helpers/{id}/pair`). One acts as the
  Owner side of that pairing; nothing special-cases it.
- **Secret protection is not exposed**, so helpers never initiate sharing.
- Everything inbound is auto-responded to, in all cases.

**"Bot" is node-level runtime policy, never a per-actor property.** The
`AutoAcceptPolicy::all()` and `auto_respond_on_failure(true)` settings belong to
the helper node's configuration, not to a column, field or flag on an actor. This
is what makes the persistence constraint below achievable, and it is the reason
the constraint is worth enforcing: a design that needs to mark an actor as a bot
is a design that is special-casing the protocol.

## Architecture

### Domain model

Two actor kinds:

- **Owner** — browser-managed, lives on the Owner node.
- **Helper** — provisioned, lives on the Helper node.

**Replica is a pairing mode, not an actor kind.** `Role::Replica`,
`routes/replicas.rs`, `disabled_replicas` and the replica-provisioning endpoints
are deleted. Testing replica flows means creating an owner and pairing a helper
against it in replica mode.

### Per-secret protocol instances

A `DeRecProtocol` instance is bound to one `secret_id`. Helper-role channels
already share a single instance, because each share record carries its own
owner's `secret_id` (see `actor.rs:116-120`). Only replica mode needs a dedicated
instance, because the share store keys on
`(secret_id, channel_id, version, replica_id)` for the replica's own vault view.

Each helper therefore holds:

```
Helper "Alex"
  base instance    (own secret_id)    ← helps Alice, Bob, Carol …   [exactly one]
  replica instance (Alice's secret)   ← replica for Alice
  replica instance (Carol's secret)   ← replica for Carol           [one per replicated owner]
```

Inbound routing:

```
inbound bytes → prost-decode DeRecMessage envelope → channelId → owning instance
```

This requires a per-helper `channel_id → instance` index, maintained as pairings
complete. It finishes a design the codebase already committed to: `prost` is
declared in `Cargo.toml` for exactly this purpose ("inbound messages are routed to
a per-secret protocol instance by the cleartext `channel_id`") and is currently
unused, and `spawn_provisioned`'s doc comment describes on-demand instance
construction the code does not implement.

Replica instances are created on demand when a replica-mode pairing completes,
using the shared rebuild primitive below.

### Node topology

```
:5001  OWNER NODE                      :5000  HELPER + ADMIN NODE
  /                Owner UI              /                 Admin UI
  /config          owner config          /admin/*          admin API
  /owners          register              /helpers          discovery
  /derec/{actor}   own mailbox           /helpers/{id}/contact
                                         /derec/{actor}    helper transport

        └─────────── HTTP over published ports ───────────┘
```

The two nodes share no `AppState`. The Owner node's registry holds owner actors
and their mailboxes; the Helper node's holds helpers. Because the SDK uses
`HttpTransport`, traffic between a bundled Owner and a bundled helper genuinely
leaves `:5001` and arrives at `:5000` — the same path a third-party Owner takes.

**Role prefixes are removed from URL paths.** With separate nodes there is no
collision, so `Role::from_path_segment`, the `{role}` path segment and its
round-trip test are deleted. Transport URIs become `{BASE_URL}:{PORT}/derec/{actor_id}`.

### Run modes

| `DEREC_MODE` | Binds | Use |
|---|---|---|
| `full` (default) | both nodes | complete demo environment |
| `helper` | helper node only | be a helper for someone else's owner |
| `owner` | owner node only | be an owner against someone else's server |

### URI minting

`BASE_URL` remains the host. Ports are configured separately:

- Owner transport: `{BASE_URL}:{OWNER_PORT}/derec/{actor_id}`
- Helper contacts: `{BASE_URL}:{HELPER_PORT}/derec/{actor_id}`

The existing loopback warning at boot applies to whichever nodes are bound.

## Owner node

### Independence requirements

The Owner MUST remain fully usable when the peer server is absent, unreachable,
or is a non-reference-app implementation. Specifically:

- No helper is on any critical path. The Owner boots, registers and runs with no
  peer server configured.
- **Pairing by contact payload (QR / paste) is the primary path**, because it is
  the only one a third-party helper offers.
- **Discovery is opt-in and best-effort.** If the configured peer server exposes
  `GET /helpers`, the Owner may offer a pick-list as a convenience. Failure
  degrades to "unavailable" and never blocks a screen.

### Peer server configuration

The Owner node serves its own `/config` carrying a peer-server URL supplied at
boot (`DEREC_PEER_SERVER_URL`, or the TOML file). In `full` mode the image points
this at its own helper port. The Owner UI surfaces it as an editable,
locally-persisted setting so a developer can retarget at any third-party server
without restarting.

Empty and unreachable are supported states, surfaced in the UI, not errors.

### Setup wizard

Reduced to what is genuinely per-owner:

```
Setup ─ one screen
  Your name        [ Alice        ]
  Pre-pair helpers [ 3 ]  (best-effort; skips manual contact exchange)

  Policy in effect (Admin ↗)
    pool 7 · min 3 · timeout 300s        [read-only]
```

Everything policy-shaped — pool size, min/recommended participants, protocol
timeout, unpair ack, authentication method, auto-accept unpair — moves to the
Admin UI. The wizard displays effective policy read-only with a link.

Pre-pairing is best-effort: it requires a reference-app peer server, and silently
degrades to "unavailable" against a third-party one.

### Fingerprint validation

Fingerprint comparison remains **owner-side only**. In real use a developer
controls only their own app, and helpers here are unattended bots, so an operator
confirming a fingerprint on the helper side models nothing real. Helpers
auto-confirm. The owner-side dialogs are retained.

`PENDING_CHANNEL_TTL_SECS` (currently 3600) still governs how long a channel may
await owner-side confirmation.

## Helper + Admin node

### API surfaces

Both surfaces are served on the same port.

**Public — callable by any Owner, including third-party:**

```
GET  /helpers                        discovery list
GET  /helpers/{id}/contact?mode=&nonce=   mint a contact (QR/paste payload)
POST /derec/{actor_id}               transport endpoint
```

**Admin — operator management, authenticated:**

```
GET  /admin/config          PUT  /admin/config
POST /admin/helpers         DELETE /admin/helpers/{id}
POST /admin/helpers/{id}/status        online/offline
GET  /admin/helpers/{id}                inspection detail (read-only)
GET  /admin/helpers/{id}/channels
POST /admin/helpers/{id}/link          link channels to one owner identity
POST /admin/helpers/{id}/pair          pair against a contact payload
GET  /admin/registry
GET  /admin/messages?since=
```

Channel linking stays an operator action. `authentication_method = "user"` means
two pairing channels are declared to belong to the same owner by a human, because
no field on the wire carries a trustworthy identity — a matching display name
least of all. That is an identity judgement, not a protocol step, so it does not
conflict with helpers auto-confirming fingerprints.

### Pool management simplifies to CRUD

`POST /participants/ensure` and its provision-only-the-shortfall-under-a-lock
behaviour existed because multiple owners raced to fill a shared pool. With the
Admin UI as sole provisioner that race is gone. It becomes plain CRUD and the
registry lock dance is removed.

### Admin UI panels

1. **Helpers** — table of name, id, online/offline, channel count, owners helped,
   owners replicated for. Create and delete helpers.
2. **Pairing** — per helper, mint a contact in any of the three modes; render QR
   and a copyable payload. No fingerprint confirmation step (helpers auto-confirm).
3. **Config** — effective values with their source (file / env / runtime
   override), editable, applied live.
4. **Registry & messages** — registry tree plus the message log.
5. **Actor inspection** — per-helper read-only detail for debugging: protocol
   instances and the secret each is bound to, channels with their state and peer
   info, pairings, shares by version and replica id, and channel links. Read-only
   at this stage; the view is structured so write actions can be added later
   without reshaping it.

### Authentication

pgAdmin-style form login guarding the Admin UI and all `/admin/*` endpoints.

- Credentials from configuration: `DEREC_ADMIN_USER` / `DEREC_ADMIN_PASSWORD`
  (env or TOML).
- Session cookie backed by an in-memory session store. Logout supported.
- **Fails closed:** if no credentials are configured, the node refuses to bind
  the admin surface. `DEREC_ADMIN_INSECURE=true` explicitly opts into an
  unauthenticated admin surface for local development, with a loud boot warning.

Rationale for failing closed: publishing `:5000` so an external Owner can pair
also publishes the admin API, since they share a port. A silently open admin
surface on a published port is the failure mode worth designing against.

Passwords are compared in constant time and never logged.

## Persistence

State moves out of memory. `sqlx` backs both engines behind one API, with
`sqlx::migrate!` for schema migrations.

| | |
|---|---|
| Engines | **SQLite** (default) and **PostgreSQL** |
| Configuration | `DATABASE_URL` (`sqlite://…`, `postgres://…`) or a plain file path, normalised to a SQLite URL |
| Default | SQLite at a documented default path |

The `InMemory*` implementations in `stores.rs` are replaced by store
implementations over `sqlx` that satisfy the same SDK traits
(`DeRecChannelStore`, `DeRecShareStore`, `DeRecSecretStore`,
`DeRecUserSecretStore`, `DeRecStateStore`).

**Both nodes** use this storage layer and share one schema, replacing the
`dashmap` registries. They populate different parts of it, which is a consequence
of where the protocol executes rather than a difference in modelling:

| Node | Persists |
|---|---|
| Owner | its actor registry and mailboxes (protocol state is in the browser) |
| Helper | the same registry and mailboxes, plus instances, channels, shares and protocol state |

### The uniformity constraint

**No table, column or key may distinguish a provisioned actor from a real one.**
No `is_bot`, no `provisioned`, no role-dependent tables, no role-dependent code
paths in the store layer.

```
helper.db
  actors      id, name, transport_uri, secret_id
  instances   actor_id, secret_id
  channels    instance_id, channel_id, peer_info, state
  shares      instance_id, channel_id, version, replica_id
  …

no is_bot · no role · no provisioned
```

Where this bites, and why it is worth enforcing: within the helper node's
database, a channel, peer record or share created by the **bundled** Owner must be
indistinguishable from one created by a **third-party** Owner. If telling them
apart were possible, the app would be special-casing the protocol somewhere. The
constraint is a forcing function for correct actor usage, and it is directly
testable — see Testing.

Bot behaviour is node configuration, so nothing about it needs to reach a row.

### The same principle on the owner side

Owners execute the protocol in the browser, so no owner protocol state reaches a
backend database. The principle still applies to browser storage: **the owner's
DeRec stores must be generic protocol-shaped implementations, not reference-app
specific.** A developer should be able to lift them into their own app unchanged.

`apps/web/src/stores.ts` already satisfies this — keys are
`derec:<ns>:<secretId>:<record>:<…>`, partitioned by secret id, carrying no
reference-app concepts. The work here is an audit rather than a rewrite:
reference-app UI state (`localData.ts`, `ownerPersistence.ts`) must stay out of
the `derec:` namespace and out of the store implementations.

Note the owner side persists to `localStorage`, not IndexedDB as `CLAUDE.md`
currently claims. The rewrite corrects this.

### Consequences

- Restarts are recoverable rather than a clean slate, which is what makes the
  supervisor below meaningful.
- The Docker spec inherits a **volume requirement** for SQLite, replacing the
  earlier assumption that all state was in memory and no volume was needed.
- Postgres support means a developer can point several containers at one database
  or inspect state with ordinary tooling.

## Shared primitives

### Helper actor supervision

Helper actors run under `actix::Supervisor` rather than a bare
`start_in_arbiter`. Each helper implements `Supervised` with a `restarting()`
hook that reloads its state from the store.

This is only meaningful because state is now persistent: a supervised restart
recovers channels, shares and in-flight orchestrator state instead of silently
resetting the actor. Supervision gives:

- **Fault isolation** — one helper panicking cannot take down the node or any
  other helper.
- **Liveness** — each helper owns its own mailbox and tick independently.
- **Hot configuration reload** — a config change is delivered to live actors
  through the rebuild primitive below, with no restart and no dropped pairings.

### Protocol instance rebuild

Runtime config changes and replica-instance creation both need: *rebuild a
protocol instance with new settings, moving the existing stores across*.

This is safe because `stores.rs` is our own code, `DeRecProtocol`'s store fields
(`channel_store`, `share_store`, `secret_store`, `user_secret_store`,
`state_store`, `transport`) are `pub`, and the type has no `Drop` impl. Moving
them into a freshly built instance preserves channels, shares and in-flight
orchestrator state (verification challenges, recovery accumulators, pending
unpair acks).

It is required because `timeouts` and `unpair_ack` are `pub(crate)` in the SDK
with no runtime setters — only `set_communication_info` and `set_own_transport`
exist. No SDK change is needed.

Persistence makes this cheaper than it would have been against in-memory stores:
a DB-backed store is a handle over a connection pool, so moving it across costs a
clone and the durable state never moves at all.

Implemented once as a `Reconfigure` actor message on the helper actor. It serves
three callers: runtime config edits, replica-instance creation, and the
supervisor's `restarting()` hook.

### Configuration domains

Because the nodes are independent, configuration splits in two. A single
server-wide config would make the Owner depend on a helper node it may not have.

**Helper node config** — edited in the Admin UI, applied live:

| Key | Effect |
|---|---|
| `protocol_timeout_secs` | helper instances' inbound-message replay window |
| `unpair_ack` | helper unpair acknowledgement policy |
| `authentication_method` | whether channel linking is manual |
| pool size | number of provisioned helpers |
| message tap buffer size | ring buffer capacity |

**Boot-time infrastructure config** is not runtime-editable and is shown
read-only in the Admin UI: `DATABASE_URL`, admin credentials, bind addresses and
ports, `BASE_URL`, and the auto-accept / auto-respond bot policy. Changing any of
these requires a restart, and the Admin UI says so rather than offering an edit
that silently does nothing.

**Owner node config** — from TOML/env at boot, overridable in an Owner settings
screen and persisted locally (the same pattern as the peer-server setting):

| Key | Effect |
|---|---|
| `peer_server_url` | which server to discover helpers from |
| `min_participants` | paired helpers required before secret protection |
| `recommended_participants` | threshold below which the UI warns |
| `protocol_timeout_secs` | the Owner's own instance and UI watchdogs |
| `unpair_ack` | the Owner's unpair acknowledgement policy |
| `auto_accept_unpair_requests` | whether inbound unpair prompts the user |

This amends the wizard mock-up above: policy shown there is read-only, and
**owner-side** policy is edited in Owner settings while **helper-side** policy is
edited in the Admin UI. In `owner` mode there is no Admin UI, and the Owner is
still fully configurable — which is the requirement that forces this split.

### Config semantics

Config edits apply **everywhere immediately**, including to live helpers, via the
rebuild primitive. No pairing is dropped and no in-flight state is lost.

Config precedence, per node: built-in defaults → TOML file → environment →
runtime override. Each UI shows which layer supplied each effective value.

### Message tap

A bounded in-memory ring buffer at the relay records, for all traffic:

```
time · direction · actor · channelId · sequence · traceId · size · outcome
outcome ∈ { delivered, dropped-offline, no-inbox }
```

These come from the plaintext `DeRecMessage` envelope. Message **type** is inside
the encrypted `message` field and is not readable at the relay.

Helpers additionally report the decrypted message type for traffic they handle,
so rows involving a container helper are enriched while browser↔browser rows are
not. The UI marks which rows are enriched rather than implying uniform depth.

```
14:02:11  → Alex          pair.PairRequest     ch 8f3a seq 1  412B  ok
14:02:11  ← Alex          pair.PairResponse    ch 8f3a seq 1  388B  ok
14:02:40  → Bob(browser)  — encrypted —        ch 21c9 seq 4  1.2K  ok
14:03:02  → Richard       store.StoreShareReq  ch 44e1 seq 2  2.1K  dropped (offline)
```

Raw payload bytes are **not** retained.

The tap stays an in-memory ring buffer and is deliberately **not** persisted,
even though a database is now available. It is a live debugging aid; writing every
relayed envelope to the database would turn durable state into a traffic log and
grow without bound. It is therefore empty after a restart, which the UI states.

## Frontend structure

One `apps/web` package with two Vite entries:

```
apps/web/
  index.html          → Owner app
  admin.html          → Admin console
  src/
    main.tsx          (owner entry)
    admin/
      main.tsx        (admin entry)
      AdminApp.tsx
      panels/
    AppMuiTheme.tsx   (shared)
    api.ts            (shared transport helpers)
```

No router dependency is added — the two modes are genuinely two pages, and Vite
code-splits them so the admin bundle never pulls in `OwnerPage.tsx`.

Serving: the backend roots `/` at `index.html` on the owner port and at
`admin.html` on the helper port, from the same `dist/`.

Development: `npm run dev` serves the owner app; a second Vite config serves the
admin app on **5174**, so development mirrors the production port split.

`vite.config.ts`'s `base: '/reference-app/'` (a GitHub Pages artifact) becomes `/`.

### API base resolution

Today `apiBase.ts` assumes "the API is port 5000 of whatever host served this
page". That rule breaks under two nodes: the Owner UI must reach the owner node
and the Admin UI the helper node, on different ports.

**In production each UI is same-origin with its own node** — the owner node serves
the Owner UI and the owner API; the helper node serves the Admin UI and the helper
API. So the default becomes `window.location.origin`, which is simpler than
today's rule and removes the hardcoded port.

**In development** the UIs are served by Vite on 5173/5174 while the nodes listen
on 5001/5000. Each Vite config proxies `/api`-prefixed paths to its node, keeping
requests same-origin in development too. This preserves the property today's
comment exists to protect — opening the app from a phone on the LAN works with no
configuration, because `window.location.origin` is already the LAN address.

A `VITE_API_URL` escape hatch is retained for pointing a UI at a node elsewhere.

Note this is distinct from `peer_server_url`: that is a **cross-node** address the
Owner uses to reach a *helper* node, is user-editable at runtime, and defaults to
the bundled helper port in `full` mode.

## Error handling

- **Peer server unreachable (Owner):** surfaced as a non-blocking status on the
  peer-server setting and the discovery list. Pairing by payload stays available.
- **Third-party peer without `/helpers`:** discovery reports "not supported";
  never an error dialog.
- **Helper offline:** existing behaviour retained — the relay accepts and drops,
  and the message tap records `dropped-offline`.
- **Unknown `channel_id` on an inbound envelope:** rejected with a failure
  response (helpers already run with `auto_respond_on_failure(true)`, which is
  what makes a fixture debuggable from the other side) and recorded in the tap.
- **Undecodable envelope:** recorded in the tap with size and outcome, no instance
  routed.
- **Admin auth failure:** 401 with no detail about which credential was wrong.
- **Config validation failure on `PUT /admin/config`:** 400 with per-field errors;
  no partial application.
- **Database unreachable at boot:** the node fails to start with a clear message
  naming the resolved `DATABASE_URL` (credentials redacted). Starting with an
  unusable store would surface later as inexplicable protocol failures.
- **Database error at runtime:** the failing operation returns 503 and the actor
  does not silently drop the message; repeated failures are logged once per
  window rather than per occurrence.
- **Pending migrations:** applied automatically at boot; a failed migration aborts
  startup rather than running against a half-migrated schema.

## Testing

**Backend units**
- envelope → `channel_id` → instance routing, including unknown and undecodable
- rebuild primitive preserves channels, shares and in-flight state
- replica instance creation on replica-mode pairing completion
- helper CRUD
- config precedence and validation
- admin auth: fail-closed on missing credentials, constant-time compare
- store implementations pass an identical trait-conformance suite on **both**
  SQLite and Postgres

**The uniformity constraint is a test, not a convention**
- a schema assertion that no table or column name matches
  `is_bot|provisioned|is_helper|actor_kind` or equivalent
- pair the same helper with the bundled Owner and with a simulated third-party
  Owner, then assert the resulting `channels`, peer records and `shares` rows are
  structurally identical apart from ids and payloads

**Supervision and persistence**
- a panicking helper restarts without affecting other helpers or the node
- after a restart, channels, shares and in-flight orchestrator state are recovered
- a config change reaches live actors with no restart and no dropped pairing

**Integration**
- both nodes running, pairing over real HTTP
- a helper simultaneously helping one owner and replicating for another
- **helper↔helper pairing**, one acting as the Owner side
- owner node with an unreachable peer server
- full node restart with a persistent database preserves established pairings

**E2E**
- slimmed setup wizard
- admin panels: create helper, mint contact, toggle offline, edit config live
- owner-only smoke test against an unreachable peer

Known pre-existing flake: `pairing.spec.ts:35` intermittently fails on an
owner-side mailbox poll stall. Treat as pre-existing during the rework, not as a
regression introduced here.

## What gets deleted

- `routes/replicas.rs` (~13KB) and replica provisioning endpoints
- `Role::Replica`, `disabled_replicas`, `actor_secret_id`'s replica branch
- `Role::from_path_segment`, the `{role}` path segment and its round-trip test
- `POST /participants/ensure` and the shared-pool lock logic
- Helper-side fingerprint endpoints
- The wizard's admin settings step
- Owner-side replica actor flows (`replicaFlows.ts` + tests, ~142KB combined),
  replaced by replica-*mode* pairing against an ordinary helper contact
- `vite.config.ts`'s GitHub Pages `base`
- The backend `InMemory*` store implementations, replaced by `sqlx`-backed ones
- The `dashmap` in-memory registries, replaced by database tables
- `start_in_arbiter` helper spawning, replaced by `Supervisor`

`CLAUDE.md` is rewritten to describe the two-node architecture.

## Out of scope

- Docker packaging — a follow-up spec. Constraints it inherits: single image,
  three modes, size-conscious base, config via mounted TOML and env, a **volume
  for the SQLite database**, and the fact that publishing the helper port also
  publishes the admin API.
- Production-grade auth beyond the single admin credential pair
- Write actions in the actor inspection view; read-only at this stage
- Real-time transport; polling is retained

## Assumptions

- A single admin credential pair is sufficient; no user management.
- In-memory sessions are acceptable; an admin is logged out by a restart.
- The message tap's ring buffer size is operator-configurable with a sane default;
  overflow drops oldest.
- Helper auto-confirmation of fingerprints is acceptable for all three contact
  modes, including `no_keys`.
- SQLite runs in WAL mode; its single-writer model is acceptable at reference-app
  scale, where concurrency is a handful of helpers rather than production load.
- Migrations run automatically at boot. There is no downgrade path — this is a
  development tool, and a schema change may require discarding the database.
- Helper↔helper pairing is reachable through the admin API only. It is a testing
  capability, not something the public discovery surface advertises.
- The two nodes may share one `DATABASE_URL` in `full` mode as a deployment
  choice, but neither may assume it: each must work against its own database.
