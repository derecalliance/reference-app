# Changelog

All notable changes to the DeRec reference app are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The app's version is the version of the DeRec SDK it is built against
(`derec-library` / `derec-proto` on crates.io, `@derec-alliance/web` on npm):
the SDK is compiled into both halves, so a different SDK means a different
release rather than a different setting.

## [0.0.7] — unreleased

First release. Built against DeRec SDK 0.0.7.

### Added

- **Owner and Helper reference implementation.** A React + Vite front end that
  executes the protocol client-side through the `@derec-alliance/web` WASM SDK,
  and a thin Rust + Axum backend that holds no protocol logic.
- **Multi-vault browser app.** A browser holds any number of vaults and one tab
  runs all of them at once; one tab per vault is enforced with Web Locks. Vault
  list, a header vault switcher, setting up a new vault or claiming an existing
  owner actor, Leave (stop running here, or remove from this browser) and
  Reset browser data. State persists in `localStorage`.
- **Pairing** in all three contact modes — inline keys, hashed keys and no keys
  with fingerprint confirmation (including the refusal path) — by copy/paste or
  by scanning a QR code with the camera where the browser supports
  `BarcodeDetector`. Browser-to-browser pairing, so a vault can be a helper for
  another vault.
- **Provisioned helper pool.** Backend-hosted helpers shared by every owner;
  the requested count is a target for the pool, not an order to create.
  Helpers can be provisioned, deleted and toggled offline from the
  Participants section or over HTTP.
- **Secret lifecycle.** Add a secret, protect it across paired helpers, verify
  shares, discover the versions helpers hold, and remove a secret (which
  publishes a new version without it). View Payload shows a version's secret
  bag, including its replica group. Round progress tells apart a helper that
  refused (Rejected), one that never answered (No answer) and one that could
  not be reached (Not reachable); a helper that refuses a verification shows as
  Rejected. A secret bag is capped at 32 KB, which is what browser storage can
  hold across every kept version.
- **Share retention.** Each round tells helpers which versions to keep
  (`keepList`): the three newest committed versions plus any round still open.
  Helpers drop the rest, so a rolled-back round never lingers on them or in
  discovery.
- **Recovery and restore.** Reconstruct a secret from helper shares, and
  restore this device from a recovered bag. A helper that holds no share of the
  requested version is reported as refused and does not hold recovery up; a
  corrupted share is reported with the helper and reason, with an offer to
  unpair it. Helpers on another node can be linked for recovery.
- **Unpairing**, with configurable acknowledgement policy.
- **Replica groups.** Pair another device — or a provisioned helper in replica
  mode — as a replica behind a fingerprint gate; mirroring with per-member
  acknowledgement, sync check and member removal (with the source's successor
  rule stated before confirming). On a destination the adoption question is
  asked before the fingerprint is confirmed, because confirming is what adopts
  the group's vault. A version conflict blocks publishing until it is resolved:
  get the group's copy, merge, publish once.
- **Edit Identity.** Rename a vault or move its endpoint (follow the node, or
  pin one); paired helpers are told with `UpdateChannelInfo`, and a vault in a
  replica group publishes a new version so its members get the new values.
- **HTTP and gRPC transports.** A gRPC listener alongside HTTP; helpers that
  advertise `http`, `grpc` or `both`; and a relay through which a browser owner
  reaches a gRPC-only helper. The relay reaches other nodes only when they are
  listed in `DEREC_RELAY_ALLOWED_HOSTS`. Messages up to 4 MiB.
- **Persistence and recovery.** The backend persists to SQLite (default) or
  Postgres and rebuilds every hosted helper — identity, `replica_id`,
  settings, channels, shares, replica instances and open pairing contacts — on
  boot, re-advertising actors at the node's current address. Provisioned
  helpers announce a new address to their peers, and messages sent to an
  address the node used before are still delivered.
- **Docker image** serving the UI and API from one origin, with a data volume,
  a non-root user, a healthcheck and graceful shutdown on `docker stop`.
- **One-command start.** `./start.sh` builds and runs the node, picks free
  ports, waits until it answers and is safe to rerun (`--postgres`, `--lan`,
  `--fresh`, `--port`, `--stop`); `docker compose up` at the repo root runs the
  same SQLite node. Compose examples for SQLite and PostgreSQL in `examples/`.
  Separate public ports (`DEREC_PUBLIC_PORT`, `DEREC_PUBLIC_GRPC_PORT`) for
  nodes published on other host ports.
- **HTTP API under `/api/v1`.** Every app endpoint answers in one envelope —
  `{"result", "timestamp", "request_id"}` on success and
  `{"error": {"code", "message"}, "timestamp", "request_id"}` on failure, with
  UPPER_SNAKE codes such as `NOT_FOUND`, `FINGERPRINT_MISMATCH` or
  `RELAY_DISABLED` — and echoes an `x-request-id` header. The DeRec transport
  (`/derec/*`) and `/health` stay unprefixed, and `/derec/*` success bodies are
  the plain protocol shapes. Described in `apps/backend/openapi.yaml`.
- **Layered backend.** One file per endpoint under `handlers/`, each calling
  exactly one service; services and repositories behind traits with typed
  errors and injected dependencies; business models in `models/`, one file per
  entity. See `docs/ARCHITECTURE.md`.
- **Configuration** from built-in defaults, an optional TOML file and
  `DEREC_*` environment variables, validated on the merged result. The node
  prints every resolved setting and its source at boot, and serves the same
  from `GET /api/v1/debug/config`.
- **Settings section.** The node's resolved configuration, plus per-browser
  overrides of the protocol defaults, including auto-accept for incoming unpair,
  share storage and verification requests.
- **Debug and inspect surfaces.** The Inspect section (actors, endpoints,
  channel routes, protocol instances), a Console panel of protocol events and
  backend deliveries tagged with the transport that carried them, and
  `GET /api/v1/debug/state`, `GET /api/v1/debug/events` and
  `GET /api/v1/debug/config`.
- **In-app Help.** A searchable Help section at the bottom of the navigation:
  a Getting started walkthrough plus topics on every flow, setting, transport
  and node option, and troubleshooting.
- **Phone layout.** The app is usable at phone width: the page scrolls as a
  whole, the console sticks to the bottom edge, and no screen runs off the
  side.
- **End-to-end suite** under Playwright in Google Chrome, covering setup,
  vaults, pairing, sharing, recovery, replicas, transports and settings.
