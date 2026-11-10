# Brief: add a "Reference App" section to the GitBook docs

For the documentation agent working in `../documentation` (branch `gitbook`).
Local and untracked here; do not commit it to reference-app.

## Goal

Add a new top-level section that tells developers what the DeRec reference app
is, how it works, how to run it, how to configure it, and how to run it with
Docker Compose. Readers are developers who integrate DeRec and want a real Owner
or Helper to test against. They are not contributors to the app itself.

## Ground truth

The app repo is `/Users/facutherock/repositories/derec/reference-app`. For
anything about the app, that repo is the source of truth, just as `lib-derec`
is for protocol facts (see the docs repo's `CLAUDE.md`). Verify every setting
name, default, port, route and command against these files before you write
it:

| Topic | Source |
| --- | --- |
| Overview, UI tour, transports, replicas, configuration model | `README.md` |
| Architecture, design principles, shared helper pool, persistence | `docs/ARCHITECTURE.md` |
| Docker image: tags, ports, volumes, **every setting with its default**, precedence, Compose, recipes | `docs/DOCKER.md` (the canonical settings reference) |
| Commented examples | `examples/config.example.toml`, `examples/.env.example`, `examples/compose.sqlite.yaml`, `examples/compose.postgres.yaml`, `examples/README.md` |
| HTTP API (routes, envelope, error codes) | `apps/backend/openapi.yaml`, `AGENTS.md` (error-code table, driving the app over HTTP) |
| In-app Help, written for end users | `apps/web/src/help/content/*.md` (00 getting started, 02 secret setup, 03 pairing, 04 protecting secrets, 05 verification, 06 recovery, 07 replicas, 11 settings, 13 transports, 14 running the app, 16 troubleshooting, 17 glossary) |
| Version | `apps/backend/Cargo.toml` (`scripts/version.sh check`) |

Current facts. Re-check them in the files above before you use them:

- Version **0.0.8-alpha.1**, built on DeRec SDK 0.0.8 (`derec-library`/`derec-proto` from crates.io, `@derec-alliance/web` from npm). The app's version follows the SDK's.
- Image `ghcr.io/derecalliance/reference-app:0.0.8-alpha.1`, public, for `linux/amd64` and `linux/arm64`. Pre-releases do not move `latest`, so always show the explicit tag.
- Repo: https://github.com/derecalliance/reference-app
- Ports: 5000 (UI + HTTP API + DeRec HTTP transport, same origin) and 50051 (gRPC transport). Data lives in `/var/lib/derec` (SQLite) unless `DEREC_DATABASE_URL` points to Postgres.

Protocol concepts the pages mention (pairing, sharing, verification, recovery,
replicas, fingerprint confirmation) must **link to the existing chapters** in
`concepts/` and `protocol-specification/`, not explain them again.

## Placement

Add a new section to `SUMMARY.md` between `## SDK` and `## Demos`, with a new
`reference-app/` folder:

```
## Reference App

* [Reference App](reference-app/README.md)
  * [How it works](reference-app/how-it-works.md)
  * [Getting started](reference-app/getting-started.md)
  * [Configuration](reference-app/configuration.md)
  * [Docker Compose](reference-app/docker-compose.md)
```

Also make these small edits, and nothing else outside `reference-app/`:

- `CLAUDE.md` in the docs repo: add the section to "Section structure", and the app repo to the ground-truth guidance (one line saying app facts come from `reference-app`).
- `demos/web-app-demo.md`: add one `info` hint pointing to the Reference App section as the maintained app built on the current `@derec-alliance/web`. Leave the rest of that page alone.
- `getting-started/repository-map.md` and `getting-started/choose-your-integration-path.md`: if either lists repos or ways to test, add the reference app in one line with a link. Do not restructure them.

## Pages

### 1. `reference-app/README.md`: overview

- What it is: a minimal reference implementation that provides both an **Owner** and a **Helper**, for interoperability testing against your own DeRec implementation.
- Shape: a static React front end (runs the protocol in the browser through `@derec-alliance/web`, persists to browser storage, polls for messages) plus a thin Rust/Axum backend (actor registry, message relay/mailboxes, hosted helpers, serves front-end defaults). **The backend implements no protocol logic.**
- What you can test with it: pairing (paste or QR), sharing, verification, recovery, replicas, HTTP and gRPC transports, several secrets per browser.
- A `danger` hint with the security warning, kept close to the README wording: no authentication, permissive CORS, listens on all interfaces; anyone who can reach the port can read every actor through `GET /api/v1/actors`, channel shared keys included. Trusted machine or LAN only, never a public network.
- Version and SDK version, the image name, and a link to the repo and its `CHANGELOG.md`.
- One cards table, in the style `demos/web-app-demo.md` uses, linking the repo.

### 2. `reference-app/how-it-works.md`

Use `README.md` and `docs/ARCHITECTURE.md`. Cover:

- **Actors and the registry.** The node is one flat registry of actors. Every secret set up in a browser registers its own owner actor; a second tab or another machine is just another owner. There is no grouping above the registry.
- **Provisioned helpers are a shared pool.** They belong to the server, and every owner pairs with the same fixtures. The helper count is a *target*: `POST /api/v1/helpers/ensure` provisions only the shortfall and never removes helpers. Any helper can be paired in replica mode, because replica is a pairing mode, not a kind of actor.
- **Configuration belongs to the front end.** The `[defaults]` settings are served to the UI as prefilled defaults. The protocol settings an actor actually runs with travel on the provisioning request. The exception is the transport keys, which the backend enforces (see Configuration).
- **Transport.** Owners poll their mailbox over HTTP (no websockets). The node speaks HTTP and gRPC. Browsers cannot dial gRPC, so `POST /derec/relay` dials on the owner's behalf. The relay is limited to this node, to endpoints its actors advertise, and to hosts in `relay_allowed_hosts`. Helpers advertise `http`, `grpc` or `both`. Messages are capped at 4 MiB. A mailbox holds at most 1000 messages or 16 MiB; past that it refuses new messages (HTTP 503, gRPC `RESOURCE_EXHAUSTED`).
- **Secrets in the browser.** A secret is one owner identity, and one tab runs every secret it holds. Each secret is held by one tab through a Web Lock. To model a separate device, use a separate browser context (incognito, another profile or another machine).
- **UI tour.** Briefly cover the four sections: Owner (Channels, Replicas, Items, Shares, Recovery), Participants, Settings and Inspect. Mention the in-app Help.
- **Debugging.** The Inspect section, the Console panel (exportable as JSON) and `GET /api/v1/debug/{state,events,config}`. The `/api/v1` envelope (`result` / `error.code`) and the `x-request-id` header. `/health` and `/derec/*` stay at the root. Link `openapi.yaml` and `AGENTS.md` on GitHub for the full API.
- **Plaintext endpoints.** The SDK refuses `http://` and `grpc://` peer endpoints unless you opt in. The app derives the opt-in from its own transport URIs (`withUnsafeConnection` / `with_unsafe_connection`). Link the SDK chapter that documents this, after checking it in lib-derec.
- **Known gap** (in the library): source succession is not implemented. Evicting or unpairing the group's `ReplicaSource` leaves the group without one.
- One mermaid diagram at most: browser owner ↔ node (registry, mailboxes, hosted helpers, relay) ↔ external peer over HTTP or gRPC.

### 3. `reference-app/getting-started.md`

Three ways to run it, quickest first:

1. **One container, no checkout:**
   ```bash
   docker run -d --name derec -p 5000:5000 -p 50051:50051 \
     -v derec-data:/var/lib/derec ghcr.io/derecalliance/reference-app:0.0.8-alpha.1
   ```
   Then open `http://localhost:5000`. On macOS, port 5000 is often taken by AirPlay Receiver. Show how to remap it (`-p 8080:5000` plus `DEREC_PUBLIC_PORT=8080`) using the recipe in `docs/DOCKER.md`.
2. **From a checkout with `./start.sh`** (Docker, Compose v2.24+, no Node or Rust needed). Include the flags table from README: `--postgres`, `--lan`, `--fresh`, `--port`, `--build`, `--stop`.
3. **From source**: Rust 1.89+ and Node.js 22+, `cargo run` in `apps/backend`, then `npm install && npm run dev` in `apps/web`, then open `http://localhost:5173/`.

Then a short **first session**: set up a secret (the wizard provisions the helper pool), add an item, protect the secret, verify it, recover it. Link each step to the matching protocol chapter. Then **test your own implementation against it**: pair your Owner with one of the app's provisioned helpers, or pair one of the app's owners with your Helper, by exchanging contacts (paste or QR). Take the exact UI labels from Help topics 00, 02 and 03.

End with **reaching it from a phone**: set `DEREC_BASE_URL=http://<LAN IP>`. Explain why it is required: the value is stamped into every transport URI peers dial, and left at `localhost` pairing seems to work but replies go nowhere. Add the Chrome "Insecure origins treated as secure" flag for the camera, and link `docs/DOCKER.md` recipes.

### 4. `reference-app/configuration.md`

- **Three layers**, each overriding the one before: built-in defaults < TOML file < `DEREC_*` environment variables. In Docker the order is: TOML file < `.env` (only fills unset variables) < `env_file:` < `environment:`/`-e`. Use the table from README.
- **Where the file is read from**: `DEREC_CONFIG_PATH`. The default is `/etc/derec/config.toml` in the image and `config.toml` in the working directory under `cargo run`. A missing file at the default path is fine; a missing file you named explicitly aborts the boot.
- **`[server]` vs `[defaults]`.** `[server]` is how the process runs. `[defaults]` is front-end defaults, except `grpc_enabled`, `grpc_port` and `grpc_relay_enabled`, which the node enforces.
- **The settings reference tables**, one per group, copied faithfully from `docs/DOCKER.md` → "Reference" (`[server]`, UI defaults, enforced transports, process/container): key, variable, default, meaning. Add nothing and drop nothing. Note the three defaults that differ under `cargo run`.
- **Rules that abort the boot** (state them, because they surprise people): `base_url` is a scheme and host only, with no port, path or user; a misspelled key in the file; the legacy unprefixed `BASE_URL`/`PORT`/`STATIC_DIR`; `port` == `grpc_port` while gRPC is enabled; `helper_transports` not summing to `participant_count` once everything is merged. An unknown `DEREC_*` variable only produces a warning. An empty variable counts as unset.
- **Seeing what was loaded**: the boot banner (show the excerpt from README) and `GET /api/v1/debug/config`, which redacts the Postgres password, plus the Settings section.
- **Relay allow-list**: `DEREC_RELAY_ALLOWED_HOSTS` (comma-separated `host` or `host:port`, or `*`) for reaching gRPC-only helpers on another node. Without it the relay answers 403.
- Link `examples/config.example.toml` and `examples/.env.example` on GitHub as fully commented templates.

### 5. `reference-app/docker-compose.md`

Use this standalone example (no checkout needed), which is adapted from one
tested end to end against the published image:

```yaml
# DeRec reference app on PostgreSQL, from the published image.
#
#   docker compose up -d        then open http://localhost:5000
#   docker compose logs -f node
#   docker compose down         (add -v to erase the data)
#
# A development tool with no authentication: run it only on your own machine
# or a LAN you trust.

name: derec

services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: derec
      POSTGRES_PASSWORD: change-me
      POSTGRES_DB: derec
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U derec -d derec"]
      interval: 2s
      timeout: 3s
      retries: 30
    restart: unless-stopped

  node:
    image: ghcr.io/derecalliance/reference-app:0.0.8-alpha.1
    environment:
      DEREC_DATABASE_URL: postgres://derec:change-me@postgres:5432/derec
      # The ports peers are told. Change them together with `ports:` below.
      DEREC_PUBLIC_PORT: "5000"
      DEREC_PUBLIC_GRPC_PORT: "50051"
      # For phones and other machines on the LAN, advertise this machine's
      # address instead of localhost (macOS: ipconfig getifaddr en0).
      # DEREC_BASE_URL: http://192.168.0.28
    ports:
      - "5000:5000"     # UI and HTTP API
      - "50051:50051"   # gRPC transport
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

volumes:
  pgdata:
```

Explain around it:

- Why there is a healthcheck plus `depends_on: condition: service_healthy`: a node that cannot reach its database refuses to boot. Migrations run on first boot.
- Why `DEREC_PUBLIC_PORT`/`DEREC_PUBLIC_GRPC_PORT` must match the host side of `ports:`. They are the ports advertised to peers, so remapping one without the other breaks pairing.
- The SQLite variant: drop the `postgres` service and `DEREC_DATABASE_URL`, and mount a volume at `/var/lib/derec`. Point to `examples/compose.sqlite.yaml` on GitHub.
- Using an env file (`env_file:`) instead of inline `environment:`, and how the two rank against each other.
- The checkout's own compose files: root `compose.yaml` (SQLite), `compose.postgres.yaml`, and `-f compose.build.yaml` to build from source. Keep this to two or three lines with a link.
- Recipes from `docs/DOCKER.md` → "Recipes": LAN, other ports, two nodes for cross-node interop (each node's address in the other's `DEREC_RELAY_ALLOWED_HOSTS` for gRPC-only helpers). Keep them short.
- Operating it: logs, upgrading by changing the tag, erasing data with `down -v`.
- Before writing the page, check the YAML against `docs/DOCKER.md` → "Docker Compose" and `examples/compose.postgres.yaml`. If they disagree, the repo files win; report the difference.

## Out of scope

- Contributor material: the e2e suite, Playwright, `scripts/publish-image.sh`, `scripts/version.sh`, the backend's internal layering rules, vendored protos. Link `CONTRIBUTING.md` once from the overview instead.
- Anything under `docs/` in the app repo other than `ARCHITECTURE.md` and `DOCKER.md` (the handoff files are internal).
- Public-tunnel setups (ngrok/Tailscale). They are not supported yet.

## Conventions (from the docs repo's CLAUDE.md)

- Every page starts with YAML frontmatter including `icon:`. Suggested icons: `flask` for the section README, `diagram-project` for how it works, `play` for getting started, `sliders` for configuration, `docker` for Docker Compose.
- Hints: `danger` only for the security warning, `warning` for trade-offs and gotchas (`DEREC_BASE_URL`, public ports, Remove Item not erasing older versions), `info` for clarifications.
- Every code fence has a language (`bash`, `yaml`, `toml`, `text` for the boot banner).
- Cross-references inside the docs use relative paths. Links to the app repo use full GitHub URLs on `main`. The release branch is `release/v0.0.8`; if a file is not on `main` yet, report that rather than linking a branch.
- Tone: terse and precise, no marketing language. Calibrate on `concepts/failure-modes.md`.
- **Do not commit or push.** Leave the changes for the user.

## Self-review before handing back

- Every setting name, variable, default and port matches `docs/DOCKER.md`.
- Every command was copied from the repo and not paraphrased. The image tag is `0.0.8-alpha.1` everywhere.
- No protocol concept is re-explained where a link to an existing chapter would do.
- `SUMMARY.md` lists every new page, and every new page has `icon:`.
- Report back: the files touched, anything in the app repo that looked inconsistent or that you could not verify, and any link that points at a file not yet on `main`.
