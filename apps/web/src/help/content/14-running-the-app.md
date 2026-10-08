# Running the app

Every way to run the node: `./start.sh`, plain Docker Compose with SQLite or PostgreSQL, `docker run` from the published image, building the image yourself, from source, reaching it from a phone on the LAN, and starting fresh.

Run it only on your own machine or a LAN you trust. It has no authentication, permissive CORS and listens on all interfaces: anyone who can reach its port can read every actor's channel keys from `GET /api/v1/actors` and delete the shared helpers.

## ./start.sh

Needs Docker with Compose v2.24 or newer, nothing else. Run it from the repository root. It stops whatever it started before, pulls the published image (`ghcr.io/derecalliance/reference-app`), starts the node, waits until `/health` answers and prints the address. If the pull fails (offline, or the version is not published yet) it builds the image from the checkout instead; the first build takes several minutes.

| Command | Effect |
| --- | --- |
| `./start.sh` | SQLite, on `http://localhost:5000`, or the next free port up to 5099 if 5000 is taken (on macOS the AirPlay Receiver usually is). gRPC on the first free port from 50051. |
| `./start.sh --postgres` | PostgreSQL instead of SQLite. |
| `./start.sh --lan` | Also reachable from phones and other machines: works out this machine's LAN address and advertises it. Set `LAN_IP=<address>` if it cannot. |
| `./start.sh --fresh` | Erase all stored data (both databases) first. |
| `./start.sh --port 8080` | A fixed HTTP port instead of the first free one. |
| `./start.sh --build` | Build the image from the checkout instead of pulling it — to run local changes. Tagged `derec/reference-app:dev`, so it never shadows the published image. |
| `./start.sh --stop` | Stop it. |

Logs: `docker compose -p derec logs -f node`. Data is kept between runs unless you pass `--fresh`.

## Docker Compose

| Command | Runs |
| --- | --- |
| `docker compose up -d` (repo root) | SQLite node on `http://localhost:5000`, from `examples/compose.sqlite.yaml`. |
| `docker compose -f compose.postgres.yaml up -d` (repo root) | PostgreSQL (`postgres:17-alpine`, user, password and database `derec`) plus the node, which waits for it. |
| `docker compose -f compose.yaml -f compose.build.yaml up -d --build` | The SQLite node built from your checkout. Works the same after `compose.postgres.yaml`. |
| `docker compose -p derec down` | Stops either. Add `-v` to erase its data. |

Both pull the published image. `compose.build.yaml` is an override that builds it instead; use it only after the repo-root files, whose paths it resolves against. The files in `examples/` need no checkout: copy one anywhere and run `docker compose up -d` beside it.

Both share the project name `derec`, so one replaces the other. Data lives in named volumes, `derec-data` (SQLite) and `derec-pgdata` (PostgreSQL).

Compose reads these from your shell or an optional repo-root `.env` (copy `examples/.env.example`):

| Variable | Effect |
| --- | --- |
| `DEREC_HOST_PORT` | Host port for HTTP (default 5000). Also sets `DEREC_PUBLIC_PORT`, so peers are told the same port. |
| `DEREC_HOST_GRPC_PORT` | Host port for gRPC (default 50051). Also sets `DEREC_PUBLIC_GRPC_PORT`. |
| `LAN_IP` | The address peers are told: `DEREC_BASE_URL=http://${LAN_IP}`. Unset, `localhost`. |
| `POSTGRES_PASSWORD` | PostgreSQL only. Default `derec`. |
| `DEREC_IMAGE` | Another image repository, without the tag (default `ghcr.io/derecalliance/reference-app`) — for example a local registry. |

To use a config file, copy `examples/config.example.toml` to `apps/backend/config.toml` **first**, then uncomment the mount in the compose file. Mounting a file that does not exist makes Docker create a directory there, and the node refuses to boot.

## docker run

No checkout needed: the image is published for `linux/amd64` and `linux/arm64`. `<version>` is the app's version: the SDK version it is built against, optionally with a pre-release suffix (`0.0.8-alpha.1`, then `0.0.8`). Pre-releases never move `latest`. Every setting the image takes, with its default, is in [docs/DOCKER.md](https://github.com/derecalliance/reference-app/blob/main/docs/DOCKER.md).

```
docker run -d --name derec -p 5000:5000 -p 50051:50051 \
  -v derec-data:/var/lib/derec ghcr.io/derecalliance/reference-app:<version>
```

- The image serves the UI and the API on one origin; open `http://localhost:5000`.
- Publish **both** ports. 50051 is the gRPC listener; without it, gRPC helpers advertise an address nothing outside the container reaches.
- Published on other host ports (`-p 8080:5000 -p 8081:50051`), also set `DEREC_PUBLIC_PORT=8080` and `DEREC_PUBLIC_GRPC_PORT=8081`, or peers are told the container's ports.
- Prefer a named volume to a bind mount: SQLite locking over bind mounts on macOS and Windows shows up as intermittent `database is locked`.
- The image tag names the SDK it was compiled against; a different SDK is a different image.

| Invocation | Survives `docker restart` | Survives `docker rm` + recreate |
| --- | --- | --- |
| no `-v` | yes, on an anonymous volume | no |
| `-v derec-data:/var/lib/derec` | yes | yes |
| `-e DEREC_DATABASE_URL=sqlite::memory:` | no | no |

## Building the image yourself

To run local changes, build from the repository root and run the result the same way:

```
docker build -f apps/backend/Dockerfile -t derec/reference-app:dev .
docker run -d --name derec -p 5000:5000 -p 50051:50051 \
  -v derec-data:/var/lib/derec derec/reference-app:dev
```

`./start.sh --build` and `compose.build.yaml` do the same. Maintainers publish with `scripts/publish-image.sh`; `scripts/publish-image.sh --local` pushes both platforms to a registry on `localhost:5055` instead, and `DEREC_IMAGE=localhost:5055/derecalliance/reference-app ./start.sh` then runs what was pushed. See `CONTRIBUTING.md`.

## From source

Needs Rust 1.89+ and Node.js 22+, and two terminals:

```
cd apps/backend && cargo run          # backend on http://localhost:5000, state in apps/backend/derec.db
cd apps/web && npm install && npm run dev
```

Open `http://localhost:5173/reference-app/`. The front end finds the backend on port 5000 of whatever host served the page; set `VITE_API_URL` only to point it elsewhere. Under `cargo run` the backend serves no UI (`static_dir` is empty), so it does not shadow the dev server.

The end-to-end suite (`npm run test:e2e`) starts its own backend on 5100 (gRPC 50151, in-memory database) and Vite on 5180, so it never touches a running session.

## Phones and other machines on the LAN

Peers post back to the address the node advertises, so it must be one the phone can reach.

- **Docker**: `./start.sh --lan`, then open the *LAN* address it prints (for example `http://192.168.0.28:5000`) on the phone.
- **From source**: start the backend with `DEREC_BASE_URL=http://192.168.0.28 cargo run` and the front end with `npm run dev:lan`, then open `http://192.168.0.28:5173/reference-app/`.

Find the address with `ipconfig getifaddr en0` on macOS; Vite also prints it as `Network:`. Left at `localhost`, pairing appears to work and then the peer sends messages to its own loopback.

**The secure-context flag.** Plain `http://` on a LAN address is not a secure context, so the browser withholds the camera (no **Scan QR**), `BarcodeDetector` and Web Locks (one-tab-per-vault becomes best-effort). On Android Chrome:

1. Open `chrome://flags`.
2. Find **Insecure origins treated as secure**.
3. Add the exact origin the phone opens, for example `http://192.168.0.28:5000` or `http://192.168.0.28:5173`, and set it to **Enabled**.
4. Relaunch Chrome.

Alternatives: Android over USB with `adb reverse tcp:5173 tcp:5173 && adb reverse tcp:5000 tcp:5000`, then open `http://localhost:5173/reference-app/` (localhost is a secure context); or real https, which iOS would need and which the backend must serve too.

## Two nodes

Two nodes on one host must be told each other's LAN address and their own published ports, or share a Docker network and use container names: inside a container, `localhost` is that container. Two nodes run with `cargo run` on one machine can use loopback on different ports. For a browser on one node to reach gRPC-only helpers on the other, list the other node in `relay_allowed_hosts`; see [Transports](13-transports.md).

## Starting fresh

1. Erase the node's data: `./start.sh --fresh`, `docker compose -p derec down -v`, or with `cargo run` stop it and delete `apps/backend/derec.db` (and any `derec.db-wal` / `derec.db-shm` beside it).
2. In **every browser you used**, click **Reset browser data** in the header. Vaults in a browser that still point at actors the node no longer has fail in ways that look like protocol bugs.
