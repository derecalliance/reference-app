# Changelog

All notable changes to the DeRec reference app are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The app's version is the version of the DeRec SDK it is built against
(`derec-library` / `derec-proto` on crates.io, `@derec-alliance/web` on npm):
the SDK is compiled into both halves, so a different SDK means a different
release rather than a different setting. Pre-releases of a version carry a
suffix (`0.0.8-alpha.1`, `-beta.N`, `-rc.N`).

## [0.0.8-alpha.1] — unreleased

First release. Built against DeRec SDK 0.0.8.

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
  `BarcodeDetector`. The Pair dialog takes the JSON payload or the contact's
  raw protobuf `ContactMessage` bytes as hex or base64, which is how a contact
  from another implementation arrives; Share Contact copies either form.
  Browser-to-browser pairing, so a vault can be a helper for another vault.
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
  Rejected, and one whose proof does not match the share it was sent shows as
  Proof invalid, with a warning that it may be damaged or dishonest. A round counts only the helpers it was actually sent to: one whose
  fingerprint was refused is sent nothing, so it is neither waited on nor
  reported as having failed to store the version, and the Add Secret form does
  not list it among the participants. A secret bag is capped at 32 KB, which is what browser storage can
  hold across every kept version.
- **Publish choices: weights, threshold and versions kept.** Every publish
  (Add Secret, Remove Secret, Republish) shows the threshold it splits at,
  every paired helper's weight (how many subshares it holds — the threshold
  counts subshares, so fewer, more trusted helpers can meet it) and which
  earlier versions helpers keep, pre-filled from the vault's defaults and
  changeable for that publish; a changed threshold can be remembered as the
  default. Each helper's default weight is set on the Channels list, which
  also shows the weight the SDK last published with. Each version records its
  own threshold. Round progress, the publish gates and the rollback decision
  count subshares against the round's own threshold, and a weighted helper
  shows as ×N. Republish publishes the current secrets again with new
  choices. A publish is blocked only with fewer than two paired helpers; a
  default threshold the helpers cannot reach is a warning, since the dialog can
  lower it or raise weights. A version that commits while a dialog is open is
  kept unless unchecked, and a remembered threshold is saved only once the
  publish goes out. Weights and the threshold survive restore, joining a
  replica group and mirrored updates.
- **Vault Settings.** Per vault: the default threshold; the versions helpers
  keep (the last N, default 3, or chosen at each publish — a publish the SDK
  starts on its own then sends no list); automatic or manual cleanup of old
  verification copies; and periodic verification.
- **Cleaning up verification copies.** Clean up lists the copies this device
  keeps per version (count and size), pre-selects what the vault's rule would
  delete, and deletes the rest; automatic mode does it after each new version
  lands, including on a replica, where the SDK never deletes them. The latest
  version and open rounds are always kept; shares held for others are never
  touched.
- **Recoverability and periodic verification.** Verifying a version shows
  whether its verified helpers hold its threshold of subshares (recoverable,
  not recoverable from verified helpers alone, or unknown for versions
  published before the counts were recorded). Shares can be verified
  automatically every N minutes, hours or days while the vault is open.
- **Restore or join.** A recovered vault that still lives on a replica offers
  Join group next to Restore: join through a member this node runs, or pair
  as replica destination with any member. Joining is blocked by a known SDK
  0.0.9 limitation when the member confirms first (see the help page).
- **Stores keep the SDK's per-version data.** The browser and backend share
  stores keep each share's subshare count and threshold, and the user-secret
  stores its threshold and author (the browser store had dropped the author
  since SDK 0.0.6); backend migration `0005` adds the two share columns.
- **Failed and refused requests.** A request a peer sends that fails on this
  device is reported and answered rather than left to time out on the peer
  (the browser answers the SDK's `RequestFailed` token with the status and
  memo the SDK chose); a share or replica copy the SDK refuses,
  a pairing it refuses, and an error response from a peer each show in the
  Console and as a notification. Provisioned helpers log the same events.
- **Share retention.** Each round tells helpers which versions to keep
  (`keepList`): the versions the owner's rule keeps plus any round still open,
  including the rounds the library publishes on its own when a helper pairs or
  a replica's fingerprint is confirmed, so a version that commits after a newer
  round started is not dropped and still shows in discovery. Helpers drop the
  rest, so a rolled-back round never lingers on them or in discovery.
- **Recovery and restore.** Reconstruct a secret from helper shares, and
  restore this device from a recovered bag. A helper that holds no share of the
  requested version is reported as refused and does not hold recovery up; a
  corrupted share is reported with the helper and reason, with an offer to
  unpair it; an unreadable (`Malformed`) one also names the innocent cause —
  a version protected before an SDK upgrade that changed the share format —
  and advises protecting a new version. Helpers on another node can be linked for recovery. Restoring a
  vault that has replicas keeps its group: on the device that held it the
  Replicas tab still lists the replica, and on a new device the vault takes
  over the identity its group knows it by — the source's — so it can publish
  and keeps mirroring. A vault restored without that identity is told why it
  cannot publish and how to fix it, instead of failing on an internal error.
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
  listed in `DEREC_RELAY_ALLOWED_HOSTS`. Messages up to 4 MiB. A provisioned
  replica holding copies of its source's helper channels never shadows the
  helper serving one: gRPC and relayed messages reach the helper, and
  `routes[].side` in `GET /api/v1/debug/state` shows which claim is the
  channel's end (`endpoint`) and which a replica's copy (`mirror`).
- **Persistence and recovery.** The backend persists to SQLite (default) or
  Postgres and rebuilds every hosted helper — identity, `replica_id`,
  settings, channels, shares, replica instances and open pairing contacts — on
  boot, re-advertising actors at the node's current address. Provisioned
  helpers announce a new address to their peers, and messages sent to an
  address the node used before are still delivered.
- **Docker image** serving the UI and API from one origin, with a data volume,
  a non-root user, a healthcheck and graceful shutdown on `docker stop`.
  Published for `linux/amd64` and `linux/arm64` as
  `ghcr.io/derecalliance/reference-app:<version>` (and `latest`), so a node
  runs with `docker run` and no checkout. Pre-releases are tagged
  `<version>-alpha.N` / `-beta.N` / `-rc.N` and never move `latest`.
  [docs/DOCKER.md](docs/DOCKER.md) documents the image: tags, ports, volumes and
  every setting with its default, environment files and Compose.
- **Release tooling.** The version is declared once, in
  `apps/backend/Cargo.toml`; `scripts/version.sh` sets it everywhere and checks
  that every copy agrees with it and with the SDK. `scripts/publish-image.sh`
  publishes the image from the tagged release commit after checking the tree,
  the tag, the registry login and that the version is not already published,
  then verifies both platforms in the registry; `--local` rehearses against a
  registry on `localhost:5055` and `--dry-run` pushes nothing.
- **One-command start.** `./start.sh` pulls and runs the node, picks free
  ports, waits until it answers and is safe to rerun (`--postgres`, `--lan`,
  `--fresh`, `--port`, `--stop`); `--build` builds the image from the checkout
  instead, and a failed pull falls back to building. `docker compose up` at the
  repo root runs the same SQLite node and `docker compose -f
  compose.postgres.yaml up` the PostgreSQL one, both from the published image;
  add `-f compose.build.yaml` to build from the checkout. The compose files in
  `examples/` need no checkout, and `DEREC_IMAGE` points them at another
  registry. Separate public ports (`DEREC_PUBLIC_PORT`,
  `DEREC_PUBLIC_GRPC_PORT`) for nodes published on other host ports.
- **HTTP API under `/api/v1`.** Every app endpoint answers in one envelope —
  `{"result", "timestamp", "request_id"}` on success and
  `{"error": {"code", "message"}, "timestamp", "request_id"}` on failure, with
  UPPER_SNAKE codes such as `NOT_FOUND`, `FINGERPRINT_MISMATCH` or
  `RELAY_DISABLED` — and echoes an `x-request-id` header. The DeRec transport
  (`/derec/*`) and `/health` stay unprefixed, and `/derec/*` success bodies are
  the plain protocol shapes. Described in `apps/backend/openapi.yaml`.
  `POST /api/v1/actors/{id}/contact` negotiates its body from `Accept`:
  `application/octet-stream` answers the encoded protobuf `ContactMessage`
  (no envelope) for backend consumers to hand straight to their SDK; JSON
  stays the default, and errors are JSON either way.
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
  A tab opened while the node is down retries fetching the node's defaults
  (bounded backoff, at most one request every 30 s) until it answers once,
  instead of keeping the built-in fallback until a reload.
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
