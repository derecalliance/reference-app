# DeRec reference app — Docker image

`ghcr.io/derecalliance/reference-app` runs a complete DeRec reference node in
one container: the web UI (Owner and Helper), the HTTP API and the DeRec
transports over HTTP and gRPC. It is built for `linux/amd64` and
`linux/arm64`.

> **A development tool, for your own machine or a LAN you trust.** The node has
> no authentication, permissive CORS, and listens on all interfaces. Anyone
> who can reach its port can read every actor's channel keys and delete the
> shared helpers. Never publish it on a public network.

- [Quick start](#quick-start)
- [Tags and versions](#tags-and-versions)
- [Ports](#ports)
- [Data and volumes](#data-and-volumes)
- [Configuration](#configuration)
  - [Ways to configure](#ways-to-configure)
  - [Precedence](#precedence)
  - [Reference](#reference)
  - [How values are read](#how-values-are-read)
- [Docker Compose](#docker-compose)
- [Recipes](#recipes)
- [Operating the container](#operating-the-container)
- [Building the image yourself](#building-the-image-yourself)

## Quick start

```
docker run -d --name derec \
  -p 5000:5000 -p 50051:50051 \
  -v derec-data:/var/lib/derec \
  ghcr.io/derecalliance/reference-app:0.0.8-alpha.1
```

Open <http://localhost:5000>. The UI and the API share that origin; there is no
separate front end to run.

On macOS the AirPlay Receiver usually holds port 5000. Publish on another port
and tell the node about it (see [Ports](#ports)):

```
docker run -d --name derec \
  -p 8080:5000 -p 50051:50051 -e DEREC_PUBLIC_PORT=8080 \
  -v derec-data:/var/lib/derec \
  ghcr.io/derecalliance/reference-app:0.0.8-alpha.1
```

## Tags and versions

| Tag | Meaning |
| --- | --- |
| `0.0.8` | A release. Never changes once published. |
| `0.0.8-alpha.1`, `-beta.N`, `-rc.N` | A pre-release of that version. Never changes once published. |
| `latest` | The newest release. Pre-releases never move it. |

The version is the version of the DeRec SDK the image is built against
(`derec-library` in the backend, `@derec-alliance/web` in the UI). The SDK is
compiled in, so a different SDK is a different image, never a setting.
Pre-releases of one SDK version are numbered in order: `0.0.8-alpha.1`,
`0.0.8-alpha.2`, …, `0.0.8-rc.1`, then `0.0.8`.

**Pin a version** for anything you want to reproduce. `latest` is for trying
the app out.

Every image carries standard OCI labels (`org.opencontainers.image.version`,
`.revision` with the exact commit, `.source`, `.created`), a build provenance
attestation and an SBOM:

```
docker buildx imagetools inspect ghcr.io/derecalliance/reference-app:0.0.8-alpha.1
```

## Ports

| Container port | Carries | Setting |
| --- | --- | --- |
| `5000` | The UI, the HTTP API (`/api/v1`), the DeRec HTTP transport (`/derec`) and `/health` | `DEREC_PORT` |
| `50051` | The DeRec gRPC transport | `DEREC_GRPC_PORT` |

Publish **both**. Helpers that use gRPC advertise the gRPC port, so leaving it
unpublished leaves them advertising an address no peer can reach.

**Publishing on other host ports.** Every address the node gives a peer
includes a port, and that must be the port the peer can reach: the *published*
one. When the host port differs from the container port, set the matching
public port:

| `docker run` | Also set |
| --- | --- |
| `-p 8080:5000` | `DEREC_PUBLIC_PORT=8080` |
| `-p 8081:50051` | `DEREC_PUBLIC_GRPC_PORT=8081` |

Without them pairing starts, then fails when the peer replies to a port
nothing answers on. You can change the ports later: on the next boot the node
re-advertises its actors at the new address, and its helpers tell the peers
they are paired with.

## Data and volumes

Everything the node knows (actors, channels, shares, mailboxes) is kept in a
SQLite database at `/var/lib/derec/derec.db`, unless you point it at
PostgreSQL. `/var/lib/derec` is a declared volume.

| How you run it | Survives `docker restart` | Survives `docker rm` + recreate |
| --- | --- | --- |
| no `-v` (Docker creates an anonymous volume) | yes | no |
| `-v derec-data:/var/lib/derec` (named volume) | yes | yes |
| `DEREC_DATABASE_URL=postgres://…` | yes | yes, while the database lives |
| `DEREC_DATABASE_URL=sqlite::memory:` | no | no |

- **Use a named volume, not a bind mount.** SQLite locking over bind-mounted
  host directories is unreliable on macOS and Windows, and shows up as
  intermittent `database is locked`.
- **A bind mount works on Linux.** The container starts as root only long
  enough to give the data directory to its runtime user (uid `10001`), then
  drops to that user. If the database is elsewhere on the mount, set
  `DEREC_DATA_DIR` to that directory.
- **Starting fresh** means erasing the volume *and* clicking **Reset browser
  data** in every browser that used the node. A browser that still holds
  vaults for actors the node no longer has fails in ways that look like
  protocol bugs.

## Configuration

Every setting has a working default. A plain `docker run` needs none of them;
set only what you need to change.

### Ways to configure

**Environment variables**, one `-e` per setting:

```
docker run … -e DEREC_BASE_URL=http://192.168.0.28 -e DEREC_PARTICIPANT_COUNT=3 …
```

**An environment file**, for more than a few. One `NAME=value` per line, with
no quotes and no `export`; lines starting with `#` are comments.
[`examples/.env.example`](../examples/.env.example) lists every variable.

```
# derec.env
DEREC_BASE_URL=http://192.168.0.28
DEREC_PARTICIPANT_COUNT=3
```

```
docker run … --env-file derec.env …
```

With Compose, the same file goes under `env_file:` (see
[Docker Compose](#docker-compose)).

**A TOML file**, mounted at `/etc/derec/config.toml`, which the image reads
with no variable to set. Use it for a configuration you want to keep and
review. [`examples/config.example.toml`](../examples/config.example.toml) has
every key, documented.

```
docker run … -v "$PWD/config.toml:/etc/derec/config.toml:ro" …
```

Create the file **before** mounting it: Docker turns a missing source path into
an empty directory, and the node then refuses to boot. To read the file from
another path, set `DEREC_CONFIG_PATH`; a path named that way must exist.

### Precedence

Highest first. A setting takes its value from the first source that sets it:

1. Environment variables (`-e`, `--env-file`, Compose `environment:` and
   `env_file:`)
2. The TOML file
3. The built-in defaults below

The node prints every setting at boot with its value and where it came from
(`default`, `file`, or `env DEREC_…`):

```
docker logs derec
```

The same is served as JSON from `GET /api/v1/debug/config`, and shown in the
app's Settings section.

### Reference

Each setting is a TOML key and an environment variable. The variable is the
key without its `server.` or `defaults.` prefix, upper-cased, with dots as
underscores and `DEREC_` in front (`defaults.participant_count` →
`DEREC_PARTICIPANT_COUNT`, `defaults.helper_transports.http` →
`DEREC_HELPER_TRANSPORTS_HTTP`).

#### Node: `[server]`

How the node runs. Applied directly.

| Variable | TOML key | Default | Description |
| --- | --- | --- | --- |
| `DEREC_BASE_URL` | `server.base_url` | `http://localhost` | The address peers are told to reach this node at. Scheme and host only: the node appends the port, and a value with a port, path or credentials is refused. Use the machine's LAN address to pair with other devices or containers. |
| `DEREC_PORT` | `server.port` | `5000` | The HTTP listener inside the container: UI, API and HTTP transport. Must differ from `DEREC_GRPC_PORT`. |
| `DEREC_PUBLIC_PORT` | `server.public_port` | `DEREC_PORT` | The HTTP port peers are told. Set it when the published port differs (`-p 8080:5000` → `8080`). |
| `DEREC_PUBLIC_GRPC_PORT` | `server.public_grpc_port` | `DEREC_GRPC_PORT` | The gRPC port peers are told. Set it when the published port differs. |
| `DEREC_DATABASE_URL` | `server.database_url` | `/var/lib/derec/derec.db` | Where state lives. A path is a SQLite file, created if missing; a relative path resolves under `/var/lib/derec`. Anything containing `://` is passed to the driver unchanged, e.g. `postgres://user:pass@host:5432/db`. `sqlite::memory:` keeps everything in memory and forgets it on exit. |
| `DEREC_STATIC_DIR` | `server.static_dir` | `/app/static` | The directory of built UI assets the node serves. |
| `DEREC_RELAY_ALLOWED_HOSTS` | `server.relay_allowed_hosts` | *(empty)* | Other nodes a browser may reach through this node's gRPC relay: comma-separated `host` or `host:port` entries, or `*` for any host. Empty, the relay reaches this node only. |

#### UI defaults: `[defaults]`

Starting values for the setup wizard and the Settings section, served to the
browser from `GET /api/v1/config`. Users can change them in the app; a vault
runs with what its browser sends when it sets up helpers.

| Variable | TOML key | Default | Description |
| --- | --- | --- | --- |
| `DEREC_PARTICIPANT_COUNT` | `defaults.participant_count` | `7` | Helpers to set up for a new vault. At least 1, at most 255. |
| `DEREC_PRE_PAIRED_COUNT` | `defaults.pre_paired_count` | `3`, or the count if lower | Helpers paired automatically, skipping the QR exchange. A testing shortcut. At most the count. |
| `DEREC_MIN_PARTICIPANTS` | `defaults.min_participants` | `3`, or the count if lower | Paired helpers required before a secret can be protected. At least 1, at most the count. |
| `DEREC_RECOMMENDED_PARTICIPANTS` | `defaults.recommended_participants` | `5`, kept between the minimum and the count | Paired helpers below which the UI warns. |
| `DEREC_HELPER_TRANSPORTS_HTTP` | `defaults.helper_transports.http` | the count | Helpers that advertise HTTP only. |
| `DEREC_HELPER_TRANSPORTS_GRPC` | `defaults.helper_transports.grpc` | `0` | Helpers that advertise gRPC only. Needs gRPC enabled. |
| `DEREC_HELPER_TRANSPORTS_BOTH` | `defaults.helper_transports.both` | `0` | Helpers that advertise both. Needs gRPC enabled. |
| `DEREC_PROTOCOL_TIMEOUT_SECS` | `defaults.protocol_timeout_secs` | `300` | The protocol timeout, in seconds: how long messages and rounds stay valid, and how long the UI waits on pairing. Greater than 0. |
| `DEREC_AUTHENTICATION_METHOD` | `defaults.authentication_method` | `user` | How channels are recognised as the same user: `user` (the helper links them when accepting a pairing). `application` is reserved and not yet selectable. |
| `DEREC_UNPAIR_ACK` | `defaults.unpair_ack` | `required` | `required`: unpairing waits for the peer's acknowledgement or the timeout. `not_required`: state is dropped at once. |
| `DEREC_AUTO_ACCEPT_UNPAIR_REQUESTS` | `defaults.auto_accept_unpair_requests` | `true` | Accept an incoming unpair request without asking. |
| `DEREC_AUTO_ACCEPT_STORE_SHARE_REQUESTS` | `defaults.auto_accept_store_share_requests` | `false` | A vault acting as a helper stores incoming shares without asking. |
| `DEREC_AUTO_ACCEPT_VERIFY_SHARE_REQUESTS` | `defaults.auto_accept_verify_share_requests` | `false` | A vault acting as a helper answers verification requests without asking. |

Leave the four derived values (`pre_paired_count`, `min_participants`,
`recommended_participants` and the `helper_transports` breakdown) unset unless
you mean to pin them: unset, they follow the count. Once pinned, they must stay
consistent with it. The transport breakdown must add up to the count, for
example.

#### Transports: `[defaults]`, enforced by the node

These live under `[defaults]` but are not just UI defaults: the node itself
obeys them.

| Variable | TOML key | Default | Description |
| --- | --- | --- | --- |
| `DEREC_GRPC_ENABLED` | `defaults.grpc_enabled` | `true` | Run the gRPC listener. Off, the node is HTTP-only and cannot set up gRPC helpers. |
| `DEREC_GRPC_PORT` | `defaults.grpc_port` | `50051` | The gRPC listener inside the container. |
| `DEREC_GRPC_RELAY_ENABLED` | `defaults.grpc_relay_enabled` | `true` | Let browsers reach gRPC-only helpers through the node (`POST /derec/relay`). A browser cannot speak gRPC itself, so off, gRPC-only helpers are unreachable from the UI. |

#### Process and container

Not configuration settings, and not accepted in the TOML file.

| Variable | Default | Description |
| --- | --- | --- |
| `DEREC_CONFIG_PATH` | `/etc/derec/config.toml` | Where to read the TOML file. At the default path a missing file is fine; a path you set must exist. |
| `DEREC_DATA_DIR` | `/var/lib/derec` | The directory the entrypoint gives to the runtime user (uid `10001`) before starting. Set it when the database is on a bind mount elsewhere. |
| `RUST_LOG` | `info` | Log filter, e.g. `debug`, or `info,derec_backend=debug`. |

### How values are read

- **Every setting is optional.** Unset, its default applies.
- **An empty variable counts as unset** (`DEREC_PORT=`). Compose turns an
  undefined `${VAR}` into an empty string, so this keeps a missing value from
  becoming a broken one.
- **Booleans** accept `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off`, in
  any case.
- **Numbers** are whole numbers, range checked: ports up to 65535, counts up
  to 255, the timeout up to 4294967295 seconds.
- **Validation runs on the merged result**, after file and environment are
  combined. A value that is fine on its own can still conflict with another
  one, such as a count changed in the environment while the file pins a
  breakdown that no longer adds up.
- **The node refuses to boot on a bad configuration** and the log names the
  setting and where it came from. A misspelled key in the TOML file is an
  error. An unknown `DEREC_` variable is only a warning, because the
  environment is shared with other software.

## Docker Compose

Two ready-to-run files need no checkout. Copy one into an empty directory and
run `docker compose up -d` beside it:

- [`examples/compose.sqlite.yaml`](../examples/compose.sqlite.yaml): the node
  on SQLite, in a named volume.
- [`examples/compose.postgres.yaml`](../examples/compose.postgres.yaml):
  the node plus `postgres:17-alpine`, which the node waits for.

The minimal shape, with PostgreSQL:

```yaml
name: derec

services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: derec
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-derec}
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
    env_file:
      - path: .env
        required: false
    environment:
      DEREC_DATABASE_URL: postgres://derec:${POSTGRES_PASSWORD:-derec}@postgres:5432/derec
    ports:
      - "5000:5000"
      - "50051:50051"
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

volumes:
  pgdata:
```

**A `.env` file next to the compose file does two jobs:**

- Compose substitutes its variables into the file itself, as with
  `${POSTGRES_PASSWORD}` above.
- Listed under `env_file:`, as above, its `DEREC_*` variables are passed into
  the container. `environment:` entries win over `env_file:`.

```
# .env
POSTGRES_PASSWORD=change-me
DEREC_BASE_URL=http://192.168.0.28
DEREC_PARTICIPANT_COUNT=3
```

Keep secrets such as the database password there rather than in the compose
file, and keep `.env` out of version control.

The example files also read `DEREC_HOST_PORT`, `DEREC_HOST_GRPC_PORT`
(published ports, which they also pass on as the public ports) and `LAN_IP`
(which becomes `DEREC_BASE_URL`). These are Compose variables for those files,
not node settings.

## Recipes

**Reach it from phones and other machines.** Advertise the LAN address:

```
docker run -d --name derec -p 5000:5000 -p 50051:50051 \
  -v derec-data:/var/lib/derec \
  -e DEREC_BASE_URL=http://192.168.0.28 \
  ghcr.io/derecalliance/reference-app:0.0.8-alpha.1
```

Find the address with `ipconfig getifaddr en0` (macOS) or `hostname -I`
(Linux), and open `http://192.168.0.28:5000` on the phone. Plain `http://` on a
LAN address is not a secure context, so the browser withholds the camera: QR
scanning needs Chrome's *Insecure origins treated as secure* flag for that
origin. The in-app Help (*Running the app*) walks through it.

**Two nodes talking to each other.** Inside a container `localhost` is that
container, so each node needs an address the other can reach: the host's LAN
address plus its own published ports, or a shared Docker network and the
container names. For a browser on node A to reach gRPC-only helpers on node B,
list B in A's `DEREC_RELAY_ALLOWED_HOSTS` (`192.168.0.30:50051`).

**HTTP only.** `-e DEREC_GRPC_ENABLED=false`, and publish only port 5000.

**A throwaway node.** `-e DEREC_DATABASE_URL=sqlite::memory:` and no volume.
Everything is gone when the container stops. The node warns about this at
boot.

**A smaller default vault.** `-e DEREC_PARTICIPANT_COUNT=3`. The other counts
follow unless you pinned them.

## Operating the container

| Task | Command |
| --- | --- |
| Logs | `docker logs -f derec` |
| Health | `curl http://localhost:5000/health` (the image's healthcheck runs `derec-backend healthcheck`) |
| Resolved configuration | `curl http://localhost:5000/api/v1/debug/config` |
| Node state | `curl http://localhost:5000/api/v1/debug/state` |
| Open the SQLite database | `docker exec -it -u derec derec sqlite3 /var/lib/derec/derec.db` |
| Upgrade | `docker pull` the new tag, then `docker rm -f derec` and run it again with the same volume. Migrations run at boot. |
| Erase everything | `docker rm -f derec && docker volume rm derec-data` |

- **User.** The server runs as `derec` (uid `10001`). `docker exec` lands as
  root, so use `-u derec` to act as the server does.
- **Stopping.** `docker stop` gives in-flight requests up to 5 seconds, then
  closes the database cleanly, within Docker's default 10-second grace period.
- **Failing fast.** An invalid configuration, an unwritable data directory or
  a port already in use stops the boot with a message naming the cause, rather
  than leaving a node half-working.

## Building the image yourself

From a checkout of the [repository](https://github.com/derecalliance/reference-app),
at its root:

```
docker build -f apps/backend/Dockerfile -t derec/reference-app:dev .
```

`./start.sh --build` builds and runs it in one step. Maintainers publish
releases with `scripts/publish-image.sh`; see
[CONTRIBUTING.md](../CONTRIBUTING.md#publishing-the-image).
