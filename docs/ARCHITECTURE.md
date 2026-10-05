# Architecture

The DeRec reference app is a minimal, working implementation of both sides of
the [DeRec protocol](https://github.com/derecalliance/protocol/blob/main/protocol.md)
— an **Owner** and a **Helper** — built so developers integrating DeRec have
something real to test against and something transparent to read.

This document describes how it is put together and the principles that keep it
that way. For running and configuring it, see the [README](../README.md).

## Goals

- A working reference for developers integrating DeRec.
- A real Owner or Helper to test an implementation against.
- Minimal, low-cost infrastructure: one process, one container.
- Protocol logic that is **client/SDK-driven**, never backend-driven.

## Shape

```
apps/web       React + Vite static front end — UI and protocol execution
apps/backend   Rust + Axum thin backend — transport, registry, hosted helpers
```

Both halves embed the same DeRec SDK: `@derec-alliance/web` (WASM) in the
browser, `derec-library` in the backend. Both are pinned to the same SDK
release, and the app's own version is that release's number.

The primary distribution is a **single Docker image** in which the backend also
serves the built front end, so UI and API share one origin. The front end can
still be run on its own under the Vite dev server (and is built for GitHub
Pages under `/reference-app/`), pointing at any reachable backend.

## Design principles

- **The backend holds no protocol logic.** Pairing, sharing, verification and
  recovery are executed by the SDK — in the page for browser owners, inside a
  provisioned actor for hosted helpers. When a protocol decision looks wrong,
  the answer is in the library, not here.
- **Thin backend.** Transport, an actor registry, store-and-forward mailboxes,
  hosted helpers and the debug surface. Handlers stay thin; provisioning,
  deletion and recovery live in their own modules.
- **Polling, not push.** Browsers poll their mailbox. There are no websockets.
- **Idempotent message handling.** A message may be delivered more than once;
  provisioning requests state targets rather than quantities.
- **Built to be inspected.** There is no authentication. Exposing internals is
  the point — which is also why it must only run on a trusted machine or LAN
  (see the README's security note).

## The actor registry

The backend keeps one flat, server-wide list of **actors**. There is
deliberately no grouping above it — no tenants, no sessions, no per-owner
namespaces. The app runs as a single local node that developers point browser
tabs at, and every actor anyone creates is visible to everyone.

An actor has a role:

- **Owner** — registered by a browser vault through `POST /owners`. Its
  protocol instance lives in the page, with keys the server never sees; the
  server only gives it an address and a mailbox.
- **Helper** — provisioned on the server through `POST /helpers` or
  `POST /helpers/ensure`. The backend runs its protocol instance itself
  (an Actix actor around `derec-library`), answering pairing, share storage,
  verification and recovery requests unattended. Hosted helpers auto-confirm
  their own pairing fingerprint, since they have no operator to read a code
  back to.

Each actor advertises one or more transport endpoints, stamped from the node's
configured `base_url` and public ports.

### Provisioned helpers are a shared pool

Provisioned helpers belong to the **server**, not to the owner that asked for
them; every owner pairs with the same fixtures.

- The helper count in the setup wizard and the Participants section is a
  **target for the pool**, not an order to create. `POST /helpers/ensure`
  provisions only the shortfall, per transport mode (`http`, `grpc`, `both`).
- Asking for fewer than exist removes nothing — another owner may be paired
  with one. Removal is explicit (`DELETE /helpers/{id}`), and unwinds the
  actor, its rows and its routing handles together.
- The count-and-create runs under a single registry lock, so two tabs setting
  up at the same moment cannot each fill an empty pool.
- A helper can be paired in the ordinary helper role or, via
  `replica_for_owner_secret`, in **replica mode**. Replica is a pairing mode
  any helper can serve, not a distinct kind of actor; a helper mirroring an
  owner runs an extra protocol instance bound to that owner's secret.
- A helper can be toggled offline (`POST /helpers/{id}/toggle-status`) to
  simulate an unreachable peer: it discards what it receives rather than
  queueing it.

### Configuration belongs to the front end

Protocol settings (threshold, timeouts, unpair acknowledgement, auto-accept
policies…) travel on each provisioning request. The backend serves
operator-supplied **defaults** from `GET /config` — read at boot from built-in
values, an optional TOML file and `DEREC_*` environment variables — and the
front end prefills from them, but the backend holds no protocol policy of its
own. The exceptions are the node's own process settings (`[server]`) and its
transport switches (`grpc_enabled`, `grpc_port`, `grpc_relay_enabled`), which
the backend enforces.

## The browser: vaults

A **vault** is one owner identity: an owner actor on the server plus the keys,
channels, secret bag and shares that the page holds for it. The browser app is
multi-vault:

- A browser can hold many vaults, and one tab runs every vault it holds at
  once — a vault that is not on screen keeps polling and answering its
  counterparties.
- **One tab per vault** is enforced with the Web Locks API: an exclusive lock
  per vault id, released automatically when the tab closes or crashes. Two tabs
  driving one vault would split its mailbox, so a vault held elsewhere is shown
  as "open in another tab" with a Claim action rather than started twice.
- Screens are hash routes (`#/`, `#/new`, `#/new/claim`, `#/vault/{id}`), so
  the static build needs no server-side rewrite. The URL carries the vault id
  (the owner actor's UUID), never the protocol `secret_id`.

A vault can also act as a **helper for another vault** — another tab's,
another browser's or another device's — holding shares in the page (the
"local" helper mode, as opposed to the backend-hosted one).

### Browser persistence

The browser persists to **`localStorage`**, not IndexedDB. Each vault's state
and its SDK stores are namespaced under `derec:vault:{vaultId}:…`, so removing
one vault erases exactly its keys and "Reset browser data" erases them all.
Protocol instances are rebuilt from those stores on load.

## Transport

### HTTP and polling

Every actor has an HTTP endpoint, `POST /derec/{actor_id}`. A message for a
hosted helper is handed straight to its actor. A message for a browser owner is
held in that owner's **mailbox** — store-and-forward, in memory — until the
page drains it with `GET /derec/{actor_id}/mailbox`. Draining is destructive,
so the page keeps undelivered messages until it has processed them.

Outbound, a browser posts protocol messages directly to the peer's advertised
HTTP transport URI.

### gRPC and the relay

The backend also runs a gRPC listener (`grpc_enabled`, `grpc_port`). gRPC has
no path segment to carry an actor id, so an inbound gRPC message is routed by
the cleartext `channel_id` on its envelope through a **channel router** with
two tiers: `bound` (the pairing completed — the steady state) and `pinned` (a
contact was minted and the handshake has not completed). A channel in neither
tier is refused rather than guessed at.

A browser cannot speak gRPC (no HTTP/2 trailer access), so `POST /derec/relay`
asks the backend to dial a gRPC endpoint on a browser owner's behalf
(`grpc_relay_enabled`). Provisioned helpers advertise `http`, `grpc` or `both`,
but every one of them can dial either protocol; what a node *advertises* is not
what it *can dial*.

## Backend persistence

The backend persists the registry, channels, shares and secrets to SQL through
one `sqlx` `AnyPool`: SQLite by default (compiled in, no service needed),
Postgres when `database_url` names one. Migrations are embedded in the binary
and applied at boot.

On boot the node **recovers**: every hosted helper becomes a running actor
again, with the identity, `replica_id` and settings it had; every browser
owner gets its mailbox back so traffic that arrives before its tab returns is
buffered rather than dropped. Every actor is first re-advertised at the node's
*current* address, so a node restarted on a new `base_url` or port does not keep
handing out a dead one.

Live runtime handles — actor addresses, mailbox channels, the event log — are
not persisted; they are rebuilt from the rows.

`sqlite::memory:` gives a deliberately scratch node; see the README for its
caveats.

## The Docker image

One image runs the backend and serves the built front end from `/app/static`
on the same origin. Its built-in defaults suit a container: data in
`/var/lib/derec` (a declared volume), a config file read from
`/etc/derec/config.toml` if one is mounted, HTTP on 5000 and gRPC on 50051. It
runs as a non-root user (uid 10001), answers a healthcheck on `/health`, and
drains on `docker stop`. The SDK is compiled in, so the image tag names the SDK
release it was built against.

## Debug surfaces

Three views of the same data:

- **Inspect** (a section of the UI) — actors and their advertised endpoints,
  the channel router's tiers, protocol instances per actor. Live.
- **Console panel** — this page's protocol events and the backend's message
  deliveries, in order, tagged with the transport that actually carried each
  one. Exportable as JSON.
- **HTTP** — `GET /debug/state`, `GET /debug/events` and `GET /debug/config`
  return what those render, plus the resolved configuration and where each
  value came from. The API is described in `apps/backend/openapi.yaml`.

## Non-goals

- Real-time transport (polling only).
- Production-grade authentication or authorization.
- High availability.
- Backend-side protocol logic.

## References

- Protocol: <https://github.com/derecalliance/protocol/blob/main/protocol.md>
- Protobufs: <https://github.com/derecalliance/lib-derec/tree/main/protobufs/protobufs>
- Rust SDK: [`derec-library`](https://crates.io/crates/derec-library)
- Web SDK: [`@derec-alliance/web`](https://www.npmjs.com/package/@derec-alliance/web)
