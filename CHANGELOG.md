# Changelog

All notable changes to the DeRec reference app are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The app's version is the version of the DeRec SDK it is built against
(`derec-library` / `derec-proto` on crates.io, `@derec-alliance/web` on npm):
the SDK is compiled into both halves, so a different SDK means a different
release rather than a different setting. Pre-releases of a version carry a
suffix (`0.0.8-alpha.1`, `-beta.N`, `-rc.N`).

## [0.0.10] — unreleased

First release. Built against DeRec SDK 0.0.10 (`derec-library` and
`derec-proto` from crates.io, `@derec-alliance/web` from npm): a single kept
version, the fingerprint commitment, and a mismatch that revokes the pairing.

### Changed

- **DeRec's own terms.** What earlier builds called a **vault** is now a
  **secret** — DeRec's Secret, with its `secret_id` — and what they called a
  **secret** is now an **item** — DeRec's `UserSecret` — held in the secret's
  item bag. Browser data those builds saved under `derec:vault:` is moved to
  `derec:secret:` on startup and records in the old shape are read as before;
  `#/vault/<id>` links still open the secret (now at `#/secret/<id>`).

### Added

- **Owner and Helper reference implementation.** A React + Vite front end that
  executes the protocol client-side through the `@derec-alliance/web` WASM SDK,
  and a thin Rust + Axum backend that holds no protocol logic.
- **Multi-secret browser app.** A browser holds any number of secrets and one
  tab runs all of them at once; one tab per secret is enforced with Web Locks.
  Secret list, a header secret switcher, setting up a new secret or claiming an
  existing owner actor, Leave (stop running here, or remove from this browser)
  and Reset browser data. State persists in `localStorage`.
- **Dark and light themes** with a toggle in the header. The app follows the
  system's colour scheme until a theme is picked; the pick is remembered per
  browser (`derec.theme`), applies to every open tab, and is set before the
  first paint so a light page does not flash dark. The protocol console and
  its log detail follow the theme too.
- **Pairing** in all three contact modes — inline keys, hashed keys and no keys
  with fingerprint confirmation (including the refusal path) — by copy/paste or
  by scanning a QR code with the camera where the browser supports
  `BarcodeDetector`. The Pair dialog takes the JSON payload or the contact's
  raw protobuf `ContactMessage` bytes as hex or base64, which is how a contact
  from another implementation arrives; Share Contact copies either form.
  Browser-to-browser pairing, so one secret's owner can be a helper for
  another secret.
- **Provisioned helper pool.** Backend-hosted helpers shared by every owner;
  the requested count is a target for the pool, not an order to create.
  Helpers can be provisioned, deleted and toggled offline from the
  Participants section or over HTTP. Only a participant paired with no owner
  can be deleted: while it holds a paired channel (helper or replica) Delete
  is disabled and `DELETE /api/v1/helpers/{id}` answers `409
  PARTICIPANT_PAIRED`, so each owner unpairs it first and the protocol's own
  teardown, with its republish, runs.
- **Simulated helper failures.** A provisioned participant can be set to
  lose or corrupt the shares it holds, or to refuse to store or to verify
  them (`PUT /api/v1/helpers/{id}/fault`, and a Failure mode select under
  Participants). Applied through the SDK's share-store contract, so owners
  get the library's real answers: rejected or invalid verifications, refused
  shares, corrupted recovery shares set aside. Reversible and independent of
  Take offline; owners' rows show what is simulated.
- **Secret lifecycle.** Add items to a secret, protect it across paired
  helpers, verify shares, discover the versions helpers hold, and remove an
  item (which publishes a new version without it). View Payload shows a
  version's item bag, including its replica group. Round progress tells apart
  a helper that refused (Rejected), one that never answered (No answer) and
  one that could not be reached (Not reachable); a helper that refuses a
  verification shows as Rejected, and one whose proof does not match the
  share it was sent shows as Proof invalid, with a warning that it may be
  damaged or dishonest. A round counts only the helpers it was actually sent
  to: one whose fingerprint was refused is sent nothing, so it is neither
  waited on nor reported as having failed to store the version, and the Add
  Item form does not list it among the participants. An item bag is capped at
  32 KB, which is what browser storage can hold across every kept version.
- **Previous versions as a table.** On the Items tab, the current version
  keeps its full card; earlier versions are one row each (version, item
  names, threshold, helpers verified and failed, recoverable, and Payload /
  Verify / Remove actions), with the per-helper detail and subshare counts in
  tooltips. Remove deletes a version from this device — its record and its
  verification copies — and sends nothing, so helpers that keep it can still
  recover it.
- **Threshold and weights on the Channels tab; publish choices.** The
  threshold every publish uses and each paired helper's weight (how many
  subshares it holds — the threshold counts subshares, so fewer, more trusted
  helpers can meet it) are set on the Channels tab, which also shows the
  weight and threshold the SDK last published with. The threshold is either
  at least a percentage of the subshares the paired helpers hold (rounded up,
  at least 2, raised above the heaviest helper so none recovers alone — a
  tooltip says when — and worked out at every publish; new secrets start at
  50%) or a fixed number (secrets set up before, and secrets restored or
  joined from a group, which take the group's number). Each mode keeps its
  value when switching, and a **?** beside the setting explains the chosen
  one. Setting them sends nothing until the next publish;
  while a weight reaches the threshold or the helpers cannot reach it, every
  publish is disabled and says what to fix.
  The publish dialogs (Add Item, Remove Item, Republish) show the
  threshold and weights read-only and let the owner pick which earlier
  version helpers keep. Each version records its own threshold. Round
  progress, the publish gates and the rollback decision count subshares
  against the round's own threshold, and a weighted helper shows as ×N.
  Republish publishes the current items again with the current threshold
  and weights. A version that commits while a dialog is open is the one kept
  unless another was picked. Weights and the threshold survive restore,
  joining a replica group and mirrored updates.
- **A Settings tab per secret.** Everything a secret runs and publishes
  with, saved together. Its protocol settings — timeout, unpair
  acknowledgement, whether incoming unpair, share storage and verification
  requests are answered on their own or asked about, and the authentication
  method — belong to that secret and start from defaults the app defines (each
  marked in its list, with a way back to them), not from the node or the
  browser: a 30-second timeout, no unpair acknowledgement, and every incoming
  request accepted automatically. The timeout and unpair acknowledgement apply when the secret next
  starts, and the tab says when one is waiting for that. Its publishing
  choices: the earlier version helpers keep (the newest committed one, or one
  chosen at each publish, or none — a publish the SDK starts on its own keeps
  the newest committed; a secret saved with "keep the last N" reads as the
  default); automatic or manual cleanup of old verification copies; and
  periodic verification.
- **Verification Copies tab.** Lists the copies this device keeps per
  version, latest first: how many helpers' copies, their size, whether the
  version is still in this device's history, whether helpers still keep it
  and how many of its helpers verified. Delete one version from its row, or
  check several and delete them together; Select by rule checks what the
  secret's rule would delete. Automatic mode does the same after each new
  version lands, including on a replica, where the SDK never deletes them. The
  latest version and open rounds are always kept; shares held for others are
  never listed.
- **Recoverability and periodic verification.** Verifying a version shows
  whether its verified helpers hold its threshold of subshares (recoverable,
  not recoverable from verified helpers alone, or unknown for versions
  published before the counts were recorded). Shares can be verified
  automatically every N minutes, hours or days while the secret is open.
- **Notifications.** A bell in the header counts unread notifications across
  secrets, and rings with a red badge while one is critical. Each secret has a
  Notifications tab (filter, mark read, link to the tab concerned). Automatic
  verification announces every run: started and passed as toasts, and a failed
  run (a helper rejected, sent an invalid proof, was unreachable or silent past
  the run's report window, or the run could not start) as an alert that stays
  until dismissed, plus a critical notification that stays until read. The
  Items card shows the last automatic check. An invalid proof in any
  verification is recorded as critical too. A run is reported at its report
  window (the protocol timeout, capped at the schedule interval) although its
  challenges stay open for late answers, and the next run is no longer held
  back by them.
- **Restore or join.** A recovered secret that still lives on a replica offers
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
- **Share retention.** Each round tells helpers the one earlier version to
  keep (`keepVersion`, SDK 0.0.10, which replaced `keepList`): the newest
  committed version, or the owner's pick. Helpers hold at most that one and
  the version sent, and drop the rest, so a rolled-back round never lingers
  on them or in discovery. Provisioned helpers keep the newest version that
  may have committed. When nothing on record vouches for a version, the one just below
  the version sent is kept.
- **One round at a time.** Nothing that publishes starts while a round is
  open, the library's own included: Add Item, Remove, Republish, Retry,
  Pair, Share Contact, Unpair, and a replica's Sync now and Remove from group
  are disabled with the version still being published, and confirming a
  fingerprint that would publish is refused. An unpair still waiting for the
  helper's answer holds them back too, since it publishes when it completes. A
  round that closes without every helper storing its share raises a banner:
  a warning when the version is still recoverable, a danger alert when it
  rolled back. Retry publishes the same items as a new round; Dismiss or
  Discard clears it.
- **Fingerprint commitment (SDK 0.0.10).** Contacts carry
  `fingerprint_commitment` (inline-keys contacts) through the JSON payload and
  `ContactMessageDto` in the HTTP API, so pairing works against a 0.0.10 peer;
  an older peer cannot pair with this build. A fingerprint mismatch the SDK
  detects now revokes the pending pairing, and the dialogs say to pair
  again.
- **Recovery and restore.** Reconstruct a secret from helper shares, and
  restore this device from a recovered item bag. A helper that holds no share of the
  requested version is reported as refused and does not hold recovery up; a
  corrupted share is reported with the helper and reason, with an offer to
  unpair it; an unreadable (`Malformed`) one also names the innocent cause —
  a version protected before an SDK upgrade that changed the share format —
  and advises protecting a new version. Helpers on another node can be linked
  for recovery. Restoring a secret that has replicas keeps its group: on the
  device that held it the Replicas tab still lists the replica, and on a new
  device the secret takes over the identity its group knows it by — the
  source's — so it can publish and keeps mirroring. A secret restored without
  that identity is told why it cannot publish and how to fix it, instead of
  failing on an internal error.
- **Unpairing**, with configurable acknowledgement policy. Unpairing a helper
  that holds a share publishes the current items as a new version to the
  helpers that remain, once the unpair completes — at once without
  acknowledgement, otherwise on the helper's answer or the timeout — unless
  the secret holds no items or the remaining helpers fall below the
  threshold, which the app reports. Removing a replica from its group
  publishes the roster without it at once; a secret with no items yet only
  announces the removal, which completes with the first publish. SDK 0.0.10
  leaves both publishes to the application. An unpair without
  acknowledgement clears its row at once.
- **Replica groups.** Pair another device — or a provisioned helper in replica
  mode — as a replica behind a fingerprint gate; mirroring with per-member
  acknowledgement, sync check and member removal (with the source's successor
  rule stated before confirming). On a destination the adoption question is
  asked before the fingerprint is confirmed, because confirming is what adopts
  the group's secret. A version conflict blocks publishing until it is resolved:
  get the group's copy, merge, publish once.
- **Edit Identity.** Rename a secret or move its endpoint (follow the node, or
  pin one); paired helpers are told with `UpdateChannelInfo`, and a secret in a
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
  overrides of its helper pool defaults (pool size, minimum, recommended,
  pre-paired, transport mix). Protocol settings are per secret, on its
  Settings tab; protocol overrides an earlier build saved here are ignored.
- **No protocol settings in the node's configuration.** `protocol_timeout_secs`,
  `unpair_ack`, `authentication_method` and the three `auto_accept_*` keys (and
  their `DEREC_*` variables) are gone from `[defaults]` and from
  `GET /api/v1/config`. A file that still sets them boots and the boot report
  names each as ignored. A helper provisioned without settings gets a
  30-second timeout and `not_required`.
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
  secrets, pairing, sharing, recovery, replicas, transports and settings.
