# Changelog

All notable changes to the DeRec reference app are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The app's version is the version of the DeRec SDK it is built against
(`derec-library` / `derec-proto` on crates.io, `@derec-alliance/web` on npm):
the SDK is compiled into both halves, so a different SDK means a different
release rather than a different setting.

## [0.0.6] — unreleased

First release. Built against DeRec SDK 0.0.6.

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
  publishes a new version without it — earlier versions still contain it).
  View Payload shows a version's secret bag, including its replica group.
- **Recovery and restore.** Reconstruct a secret from helper shares, and
  restore this device from a recovered bag.
- **Unpairing**, with configurable acknowledgement policy.
- **Replica groups.** Pair another device — or a provisioned helper in replica
  mode — as a replica behind a fingerprint gate; mirroring with per-member
  acknowledgement, sync check, eviction, and a guarded, destructive adoption on
  the destination.
- **HTTP and gRPC transports.** A gRPC listener alongside HTTP; helpers that
  advertise `http`, `grpc` or `both`; and a relay through which a browser owner
  reaches a gRPC-only helper.
- **Persistence and recovery.** The backend persists to SQLite (default) or
  Postgres and rebuilds every hosted helper — identity, `replica_id`,
  settings, channels and shares — on boot, re-advertising actors at the node's
  current address.
- **Docker image** serving the UI and API from one origin, with a data volume,
  a non-root user, a healthcheck and graceful shutdown on `docker stop`.
  Separate public ports (`DEREC_PUBLIC_PORT`, `DEREC_PUBLIC_GRPC_PORT`) for
  nodes published on other host ports.
- **Configuration** from built-in defaults, an optional TOML file and
  `DEREC_*` environment variables, validated on the merged result. The node
  prints every resolved setting and its source at boot, and serves the same
  from `GET /debug/config`.
- **Settings section.** The node's resolved configuration, plus per-browser
  overrides of the protocol defaults, including auto-accept for incoming unpair,
  share storage and verification requests.
- **Debug and inspect surfaces.** The Inspect section (actors, endpoints,
  channel routes, protocol instances), a Console panel of protocol events and
  backend deliveries tagged with the transport that carried them, and
  `GET /debug/state`, `GET /debug/events` and `GET /debug/config`. The API is
  described in `apps/backend/openapi.yaml`.
- **End-to-end suite** under Playwright in Google Chrome, covering setup,
  vaults, pairing, sharing, recovery, replicas, transports and settings.
