# DeRec Reference App

A minimal reference implementation of the [DeRec protocol](https://github.com/derecalliance/protocol/blob/main/protocol.md), providing both an Owner and a Helper for interoperability testing.

- `apps/web` — React + Vite static frontend. Executes DeRec flows (pairing, sharing, verification, recovery, replicas) client-side and polls the backend for messages.
- `apps/backend` — Rust + Axum thin backend. Actor registry, message relay and hosted helpers only; no protocol logic lives here.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the architecture and
design principles, [`AGENTS.md`](AGENTS.md) if you are an LLM or coding agent
driving this over HTTP rather than through the UI, and
[`CHANGELOG.md`](CHANGELOG.md) for what each release contains.

## Getting started

```
git clone https://github.com/derecalliance/reference-app.git
cd reference-app
./start.sh
```

That is all it takes with [Docker](https://docs.docker.com/get-docker/)
(Compose v2.24 or newer) — no Node or Rust needed. Then open the address it
prints and set up your first vault.

Without cloning anything, the published image runs on its own:

```
docker run -d --name derec -p 5000:5000 -p 50051:50051 \
  -v derec-data:/var/lib/derec ghcr.io/derecalliance/reference-app:0.0.8-alpha.1
```

### Run it in Docker

`./start.sh` pulls the published image (`ghcr.io/derecalliance/reference-app`),
starts the node, waits until it answers and prints the address:
`http://localhost:5000`, or the next free port if 5000 is taken (on macOS the
AirPlay Receiver usually is). Run it again whenever you like: it stops whatever
it started before and starts it fresh, keeping your data. If the image cannot be
pulled — offline, or a version not published yet — it builds it from your
checkout instead, which takes several minutes the first time.

| | |
| --- | --- |
| `./start.sh --postgres` | PostgreSQL instead of SQLite |
| `./start.sh --lan` | also reachable from phones and other machines on your network |
| `./start.sh --fresh` | erase all stored data first — then use **Reset browser data** in the app, in each browser you used |
| `./start.sh --port 8080` | a fixed port instead of the first free one |
| `./start.sh --build` | build the image from your checkout instead of pulling it — to run local changes |
| `./start.sh --stop` | stop it |

Plain Compose works too: `docker compose up` in the repo root runs the same
SQLite node on `http://localhost:5000` (set `DEREC_HOST_PORT` to move it), from
the published image like any other service image. The compose files are
[`examples/compose.sqlite.yaml`](examples/compose.sqlite.yaml) and
[`examples/compose.postgres.yaml`](examples/compose.postgres.yaml); see
[docs/DOCKER.md](docs/DOCKER.md) for the details, and
[Reaching it from a phone](#reaching-it-from-a-phone-on-the-same-network) for
the browser settings a phone needs.

### Run it from source

For working on the code. Needs [Rust](https://rustup.rs) 1.89+ and
[Node.js](https://nodejs.org) 22+, and two terminals:

```
# terminal 1 — the backend, on http://localhost:5000 (state in apps/backend/derec.db)
cd apps/backend
cargo run

# terminal 2 — the front end, with hot reload
cd apps/web
npm install
npm run dev
```

Open `http://localhost:5173/reference-app/`. The front end finds the backend on
port 5000 of whatever host served the page, so nothing needs configuring; set
`VITE_API_URL` only to point it elsewhere. Settings for the backend (ports,
database, defaults) are covered in [Configuring it](#configuring-it).

### Run the tests

```
cd apps/backend && cargo test --all-targets        # backend
cd apps/web && npx tsc -b && npm run lint && npx vitest run   # front end: types, lint, unit
cd apps/web && npm run test:e2e                    # end to end, in Chrome
```

The end-to-end suite starts its own backend and dev server on separate ports,
so it runs alongside a `cargo run` / `npm run dev` session without touching it.
It drives an installed Google Chrome. See [End-to-end tests](#end-to-end-tests).

## What's in the app

The left navigation has four sections:

| | |
| --- | --- |
| **Owner** | Your vaults (see below). Inside a vault: **Channels** (pair with helpers or other vaults, by paste or QR), **Replicas**, **Secrets** (**Add Secret**, protect, verify, **View Payload**, **Remove Secret**), **Shares** held for others, and **Recovery**. |
| **Participants** | The node's shared pool of provisioned helpers: provision up to a target, take one offline to simulate an unreachable peer (or bring it back), delete one. |
| **Settings** | What the node is configured with and where each value came from, plus this browser's overrides of the protocol defaults — pool size and transport mix, unpair acknowledgement, and whether incoming **unpair**, **share storage** and **verification** requests are auto-accepted or prompt. Overrides live in this browser and travel on each provisioning request. |
| **Inspect** | The server's own view of itself (see [Debugging it](#debugging-it)). |

**View Payload** shows a published version of the secret bag as it is
distributed — including its replica group, when there is one. **Remove Secret**
publishes a new version without the secret; it does not reach back into earlier
versions, which still contain it. Each publish tells helpers which versions to
keep — the three newest committed ones, plus the one being sent — so until three
newer versions have committed, recovering an earlier version brings the secret
back.

### Vaults

A vault is one owner identity: an owner actor on the server, plus the keys,
channels, secrets and shares this browser holds for it. A browser can hold
several, and **one tab runs every vault it holds at once** — a vault that is not
on screen keeps polling and answering its counterparties, and its pending
decisions are flagged in the header and the list.

| Route | Screen |
| --- | --- |
| `#/` | The vault list: every vault saved in this browser, its status, paired helpers, bag version and replicas. |
| `#/new` | **Set up a new vault** — registers a new owner actor. |
| `#/new/claim` | **Claim an existing actor** — a testing shortcut that takes over an existing owner actor's mailbox instead of registering a new one. |
| `#/vault/{id}` | One vault, by its owner actor's id. |

In the header: a **vault switcher** to jump between vaults, **All vaults** back
to the list (the vault keeps running), **Leave**, and **Reset browser data**.
Leave offers two things: **Stop running here** (the vault stays saved and
another tab can open it) or **Remove from browser** (erases its keys, channels
and shares from this browser). Reset browser data erases every vault in this
browser, across all its tabs. None of these touch the actors on the server.

**One tab per vault.** Two tabs driving one vault would split its mailbox, so
each vault is held with an exclusive Web Lock that is released when its tab
closes. A vault open elsewhere is listed as *Open in another tab* with a
**Claim** action that works once the other tab has let it go.

## Debugging it

This is a developer's tool, so it is built to be inspected. There is no
authentication anywhere — exposing the internals is the point, and it is not
meant to be reachable from outside a trusted network (see
[Security](#security-trusted-networks-only)).

Three places show you what is happening, all reading the same data:

| | |
| --- | --- |
| **Inspect section** | The server's own view of itself: actors and the endpoints they advertise, which tier of the channel router holds each channel, how many protocol instances each actor runs. Refreshes live. |
| **Console panel** | What happened, in order — this page's own protocol events *and* the backend's message deliveries, tagged with the transport that actually carried each one. Copy or download the whole log as JSON. |
| **HTTP** | `GET /api/v1/debug/state` and `GET /api/v1/debug/events` return exactly what those two render; `GET /api/v1/debug/config` returns the resolved configuration. The full API is described in [`apps/backend/openapi.yaml`](apps/backend/openapi.yaml); a test keeps it in step with the router. |

The API lives under `/api/v1` and answers in one envelope: `{"result": …,
"timestamp", "request_id"}` on success, `{"error": {"code", "message"}, …}` on
failure, with a stable `code` such as `NOT_FOUND` or `RELAY_DISABLED`. Every
response carries an `x-request-id` header — send your own to find that request
in the node's logs. `GET /health` and the DeRec transport (`/derec/*`) stay at
the root with their bodies unchanged. [`AGENTS.md`](AGENTS.md) has the full
error-code table, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#backend-layering)
how the backend is layered.

The transport badge on each channel row is worth knowing about: `HTTPS`,
`GRPC` or `GRPC+HTTPS` tells you what that peer advertises. A trailing `~`
means the badge was derived from a single known address rather than the peer's
full advertised list, so it may be incomplete.

If a message is not arriving, `routes` in the Inspect section usually explains
it. A channel in the `pinned` tier means a contact was minted and the handshake
never completed; `bound` means it did.

## Running it

The backend serves a single local node. Every vault set up in any browser that
opens the app registers its own owner actor against it — another tab, an
incognito window or another machine on the network simply adds more owners.
There is no grouping above that: everything the server knows lives in one actor
registry.

### Security: trusted networks only

> **Run this only on your own machine or a LAN you trust. Never expose it on a
> public network.**
>
> It is a developer tool and has none of the protections a service would: no
> authentication, permissive CORS, and it listens on all interfaces. Anyone who
> can reach its port can read every actor through `GET /api/v1/actors` — including
> channel shared keys — and can delete or disable the shared helpers everyone
> else is paired with. The node prints the same warning at boot.

### In Docker

One image serves the UI and the API on the same origin and keeps its state in a
volume. It is published as `ghcr.io/derecalliance/reference-app` for
`linux/amd64` and `linux/arm64`:

```
docker run -d --name derec -p 5000:5000 -p 50051:50051 \
  -v derec-data:/var/lib/derec ghcr.io/derecalliance/reference-app:0.0.8-alpha.1
```

**[docs/DOCKER.md](docs/DOCKER.md) is the image's reference:** tags and
versions, ports, volumes, every setting with its default, environment files,
Compose, and recipes for LAN use, other ports and two nodes.

From a checkout, `./start.sh` runs the same image (see
[Getting started](#getting-started)), and the root
[`compose.yaml`](compose.yaml) and [`compose.postgres.yaml`](compose.postgres.yaml)
run it with plain Compose. Add `-f compose.build.yaml`, or use
`./start.sh --build`, to build the image from your checkout instead (tagged
`derec/reference-app:dev`).

### The SDK

Both halves are built against SDK **0.0.8**, and the app's version is the same
number.

Both are taken from the registries: `derec-library` and `derec-proto` from
crates.io, `@derec-alliance/web` from npm. No sibling checkout is needed for
anything, including the Docker build and the end-to-end tests.

The backend generates its own gRPC transport service, because the published
`derec-proto` ships message types only. The `.proto` files that needs are
vendored in `apps/backend/proto/`, and `tests/proto_drift.rs` checks them
against the pinned release — so bumping the SDK means re-copying them from the
`derec-proto` crate, and the test tells you when you forgot. It reads the
release from the cargo registry cache (run a build first), and skips when the
pinned version is not there.

### Plaintext endpoints in local development

The protocol refuses plaintext endpoints by default — `http://` and, since
0.0.3, `grpc://`. Loopback is exempt for the endpoint a node configures for
*itself*, but **not** for one a peer supplies — and every peer here is
`http://localhost:5000/derec/...`, so pairing fails without opting in. Both
halves do, and both derive it rather than hardcoding it. The web app:

```ts
.withUnsafeConnection(!ownTransportUri.startsWith('https://'))
```

The backend, for each provisioned actor, opts in when any transport it
advertises is `http://` or `grpc://`:

```rust
.with_unsafe_connection(config.own_transports.iter().any(|t| {
    t.uri.starts_with("http://") || t.uri.starts_with("grpc://")
}))
```

Served over https, the guardrail comes back on by itself. It is a guardrail
rather than transport security — the SDK opens no sockets — governing which
endpoints get recorded, propagated and replied to.

### End-to-end tests

Browser-level tests live in `apps/web/e2e` and run under Playwright. The config
starts both halves of the stack itself — `cargo run` for the backend and the
Vite dev server — so there is nothing to launch first:

```
cd apps/web
npm run test:e2e          # headless
npm run test:e2e:ui       # interactive runner
npm run test:e2e:headed   # watch a real browser
npm run test:e2e:report   # open the last HTML report
```

The suite runs on ports of its own — the backend on 5100 (gRPC on 50151) with
an in-memory database, Vite on 5180 — and never adopts a server it did not
start, so a normal `npm run dev` session keeps running alongside a test run.
Neither side can reach the other: the run never touches your node on 5000, and
an app tab you have open on 5173 never ends up served by the suite (which
shares no `localStorage` with it, being a different origin).

Two constraints shape how these tests are written:

- **A separate device needs a separate browser context.** Vaults live in
  `localStorage`, which every page of a context shares, and each is held by one
  tab through a Web Lock. Several vaults in one tab is a supported case
  (`multi-vault.spec.ts`), but the other side of a pairing that should behave
  like another device — a replica device, a browser-to-browser peer — needs its
  own `BrowserContext`. `newOwnerContext()` in `e2e/app.ts` is the helper for
  that.
- **The backend is shared state.** One actor registry and one helper pool
  serve every test, so the suite runs single-worker and serially. A test should
  treat the helper pool as something that may already exist.

What the specs cover:

| Spec | Covers |
| --- | --- |
| `smoke` | the app loads, the setup wizard, pre-pairing, independent owners in separate contexts |
| `multi-vault` | several vaults in one tab kept apart; an off-screen vault flagging a decision |
| `pairing` | all three contact modes, including the `NoKeys` fingerprint gate and its refusal path |
| `browser-pairing` | two browsers pairing with `NoKeys` and confirming on both sides |
| `share-contact` | the Share Contact modal's layout and superseded contacts |
| `qr-scan` | pairing by camera, with a faked decoder, and releasing the camera |
| `sharing` | the secret lifecycle: protect, verify, discover, a second secret, **Remove Secret** |
| `recovery` | reconstruction, every version found, `restore`, unpairing |
| `replicas` | replica groups against provisioned helpers: fingerprint gate, a three-member group, mirroring, sync check, forget, eviction |
| `browser-replica` | two browsers pairing as replicas in both directions, the mirrored copy arriving only after both confirm, the adoption dialog appearing, and the replica group in View Payload |
| `grpc` | the transport matrix described below |
| `participants` | the Participants section: provisioning, deleting, pre-pairing limits |
| `settings` | the Settings section's protocol defaults and their reset |
| `wasm-concurrency` | overlapping calls into the WASM SDK, across and within protocol instances |
| `browser-check` | the run is really Google Chrome |
| `lan`, `lan-secure` | opt-in, see below |

`lan.spec.ts` and `lan-secure.spec.ts` need the machine's network address and
are skipped unless `LAN_HOST` is set:

```
LAN_HOST=192.168.0.28 npm run test:e2e -- lan
```

They run in **Google Chrome**, not Playwright's bundled Chromium — the config
pins `channel: 'chrome'`, and `browser-check.spec.ts` fails the run if anything
else is launched. For an app whose purpose is interoperability testing, which
browser engine actually executed the WASM is part of the result.

Failures retain a trace, a video and a screenshot under `test-results/`; open a
trace with `npx playwright show-trace <path>`. Uncaught page errors are captured
too, including the plain objects thrown by the WASM bindings, which otherwise
surface as an unhelpful bare `Object`.

### Reaching it from a phone on the same network

Two processes have to be reachable, and the backend has to *advertise* an
address the phone can use:

```
# terminal 1 — backend, advertising this machine's LAN address
cd apps/backend
DEREC_BASE_URL=http://192.168.0.28 cargo run

# terminal 2 — dev server bound to the network rather than loopback
cd apps/web
npm run dev:lan
```

Then open `http://192.168.0.28:5173/reference-app/` on the phone, substituting
your own address (`ipconfig getifaddr en0` on macOS; Vite also prints it as
`Network:` on startup).

The front end needs no configuration: with `VITE_API_URL` unset it assumes the
backend is on port 5000 of **whatever host served the page**, so the phone talks
to the laptop rather than to itself. (With the Docker image this is simpler
still: the page and the API share an origin, so open
`http://192.168.0.28:5000` once `DEREC_BASE_URL` is set.)

`DEREC_BASE_URL` is the one that must be set. It is not merely where the backend
listens — it is stamped into every transport URI handed to a peer, and that peer
posts to it. Left at `localhost`, pairing appears to work and then the peer
sends protocol messages to its *own* loopback. The backend logs a warning at
startup when it detects this — worded for a container when it runs in one,
since there even another container on the same host cannot reach loopback.

`base_url` is a scheme and a host, nothing else. A port — even the scheme's
default (`http://host:80`) or an empty one (`http://host:`) — a user name (even
an empty `http://@host`), a path, a query, or a missing slash (`http:/host`)
aborts the boot with a message naming the setting to use instead: each of them
used to boot and advertise an address like `http://host:80:5000/derec/…` that
nothing can dial.

#### Making the LAN origin a secure context

`http://` on a LAN address is not a [secure context], and browsers withhold a
lot there — `getUserMedia`, `BarcodeDetector`, and `crypto.randomUUID` among
them. The camera is the visible casualty; `randomUUID` is why plain LAN http
broke the setup wizard outright until the app stopped depending on it. Web
Locks is withheld too; without it the app still runs, but no longer stops two
tabs from opening the same vault.

On Android, tell Chrome to treat the origin as secure. No certificates, nothing
to change here:

1. Open `chrome://flags` on the phone.
2. Find **Insecure origins treated as secure**.
3. Add your address with the port the phone opens — `http://192.168.0.28:5173`
   for the dev server, or the Docker node's own, e.g. `http://192.168.0.28:5000`
   (the address `./start.sh --lan` prints) — and set the dropdown to
   **Enabled**.
4. Relaunch Chrome when prompted.

Scanning then works: the origin is a secure context, so the APIs above come
back. `e2e/lan-secure.spec.ts` verifies exactly this using Chrome's
`--unsafely-treat-insecure-origin-as-secure`, which is the desktop equivalent of
that flag — including that the **Scan QR** button appears.

It is per-device and Chrome-only, and you redo it if the laptop's address
changes. Two alternatives, both avoiding that:

- **Android over USB.** `adb reverse tcp:5173 tcp:5173 && adb reverse tcp:5000
  tcp:5000`, then open `http://localhost:5173/reference-app/` on the phone.
  `localhost` *is* a secure context, so nothing else is needed.
- **Real https**, which is what iOS would need. More involved than it looks:
  protocol messages are posted to peers' *absolute* transport URIs, so the
  backend needs a certificate too and its outbound client has to trust it.

[secure context]: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts

### Pairing by camera

Where the browser can, the "Let them initiate" dialog offers **Scan QR** beside
the paste field: it opens the camera, decodes the peer's code and drops the
payload into the same textarea a paste would fill, so validation, role selection
and submission stay a single path.

Decoding uses the browser's own `BarcodeDetector` rather than a bundled
library — Chromium ships it with `qr_code` support, and this app's whole pairing
gesture is "show a code on one screen, read it on another". Where it is missing
(Firefox, and Safari at the time of writing), on an insecure origin, or on a
machine with no camera, the button is withheld and a short note says which of
those it is. Paste has always worked and remains the fallback.

### Known gaps

One gap remains, and it is in the library:

- **Source succession is not implemented.** Evicting or unpairing the group's
  `ReplicaSource` leaves the group without one. Removing a `Destination` works.

One rule is worth knowing when reading the sharing code: **never derive a
publishing round's version.** Rounds are keyed by version and several run
concurrently — confirming a replica's fingerprint publishes one — so anything
that guesses (`bag.version + 1`) or takes the first version it sees in a batch
of events will end up watching a round nobody dispatched. Read it back from
`ProtectSecretStarted`. Both bugs of this shape have been fixed and are covered
by `replicas.spec.ts`.

### Configuring it

Three layers, one merged result. Each overrides the one before it:

1. **built-in defaults**
2. **a TOML config file**
3. **environment variables** (`DEREC_*`)

Anything settable in the file is settable from the environment, and the other
way round.

Worked examples of all of it live in [`examples/`](examples/) — every key
documented inline, nothing to look up:

| File | Copy it to | For |
| --- | --- | --- |
| `examples/config.example.toml` | `apps/backend/config.toml` | the TOML file |
| `examples/.env.example` | `.env` | environment variables |
| `examples/compose.sqlite.yaml`, `examples/compose.postgres.yaml` | run in place (see [docs/DOCKER.md](docs/DOCKER.md#docker-compose)) | running it in Docker |

**Where the file is read from.** `DEREC_CONFIG_PATH` names it. Unset, the node
reads its default path — `config.toml` in the working directory under
`cargo run` (so `apps/backend/config.toml` when run from `apps/backend`), or
`/etc/derec/config.toml` in the image — and no file there is fine: the node
runs on the defaults and the environment. Set `DEREC_CONFIG_PATH` to a file that
does not exist and the boot fails: you named a file, so its absence is a
mistake rather than a choice.

**How variables are read.** A variable set to an empty value (`DEREC_PORT=`)
counts as unset — compose turns an undefined `${VAR}` into an empty string —
and the banner lists it as ignored. Values are trimmed, numbers are range
checked, text settings keep numeric-looking values (`DEREC_STATIC_DIR=2024`),
and booleans accept `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off` in any
case. `port` and `grpc_port` must differ while gRPC is enabled.

Every key is optional — omit one and its built-in default applies. A file that
cannot be read, parsed or validated aborts the boot rather than silently
falling back.

What the two tables mean:

- **`[server]`** is how this process runs — listener and public ports, the
  address it advertises, its database, the UI it serves. The backend applies
  these directly.
- **`[defaults]`** is mostly *defaults for the front end*: served from
  `GET /api/v1/config`, prefilled into the setup wizard and the Settings section, and
  still editable there. The protocol settings a node actually runs with are
  whatever the front end sends when it provisions actors. The exception is the
  transport keys — `grpc_enabled`, `grpc_port` and `grpc_relay_enabled` — which
  the backend **enforces**: they decide whether the gRPC listener runs and on
  which port, whether gRPC helpers can be provisioned at all, and whether
  `/derec/relay` answers.

The image does not preset any `DEREC_*` variable; its container-appropriate
values — data in `/var/lib/derec`, the UI served from `/app/static`, the config
file at `/etc/derec/config.toml` — are its built-in defaults, so the boot
banner reports them as `default` and any of them can be overridden from the
file or the environment.

How the environment is assembled, highest first:

| | Source | Beats |
| --- | --- | --- |
| 4 | `environment:` or `-e` on the container | everything |
| 3 | `env_file:` in compose — injects real variables | the file and the defaults |
| 2 | a `.env` in the working directory — fills only variables **not already set** | the config file |
| 1 | the TOML config file | the built-in defaults |

Tiers 3 and 4 look the same to the app — both are just the environment by the
time it starts, and compose resolves that precedence itself.

Every setting, with its variable, default and meaning, is listed in
[docs/DOCKER.md](docs/DOCKER.md#reference). The defaults there are the
image's; under `cargo run` only three differ: the database is `derec.db` in
the working directory, `static_dir` is empty (no UI, so the Vite dev server is
not shadowed) and the config file is `config.toml` in the working directory.

`public_port` and `public_grpc_port` default to the listener ports (`port` and
`grpc_port`); set them only when something in between remaps the ports, as
`docker run -p 8080:5000` does. `base_url` is a scheme and host only — no port
and no path; a value with either aborts the boot and names the setting to use
instead.

`BASE_URL`, `PORT` and `STATIC_DIR` are no longer read (they are now
`DEREC_BASE_URL`, `DEREC_PORT` and `DEREC_STATIC_DIR`). Setting one without its
`DEREC_`-prefixed replacement aborts the boot with a message naming it, rather
than leaving a node quietly running on defaults.

A misspelled key in the file aborts the boot — the file is unambiguously yours.
An unrecognised `DEREC_` variable only warns: the environment is shared.

Validation runs on the **merged** result. `helper_transports` must sum to
`participant_count`, so overriding the count in `.env` while the file still
lists the old breakdown is a configuration that passes per-source and fails as
a whole. See `examples/.env.example`, which calls this out where you would hit
it.

#### Seeing what was loaded

The node prints its entire resolved configuration at boot — every setting, its
value, and where the value came from:

```
configuration
  file   /etc/derec/config.toml  loaded
  env    3 DEREC_* variables

  [server]
  base_url                  http://192.168.0.28  env DEREC_BASE_URL
  port                      5000                 default

  [defaults]
  participant_count         3                    env DEREC_PARTICIPANT_COUNT
  protocol_timeout_secs     300                  default
  unpair_ack                required             file
  ...
```

Every setting is listed, not only the overridden ones — if you set something
and nothing happened, seeing that key marked `default` is the answer. The same
data is available as JSON from `GET /api/v1/debug/config`, and in the Settings
section.

## Transports

The backend speaks HTTP and gRPC. A browser owner only ever speaks HTTP itself
— it has no HTTP/2 trailer access — so gRPC exists here to prove the protocol
is transport-agnostic and to let the reference app interoperate with a peer
that only offers gRPC, not to give the browser a second way to talk.

### The gRPC listener

`grpc_enabled` (default `true`) and `grpc_port` (default `50051`) control the
backend's own gRPC server. It is separate from the HTTP listener `DEREC_BASE_URL`
points at, and provisioned helpers can only advertise a `grpc://` endpoint
while it is running — turn `grpc_enabled` off to run HTTP-only. A gRPC helper
advertises `grpc://<base_url host>:<public_grpc_port>`.

### Message size

One limit everywhere: a DeRec message may be at most **4 MiB** — what the gRPC
listener accepts — whether it arrives over gRPC, is posted to
`POST /derec/{actor_id}`, or is relayed. The relay's JSON body carries the
message base64url-encoded, a third larger, so that route accepts a body of up
to about 5.4 MiB to fit a full 4 MiB message. Other JSON routes keep Axum's
2 MiB.

A browser owner's mailbox holds at most 1000 messages or 16 MiB of message
bytes — counted as posted, not as the base64 the table stores — so four
maximum-size messages fit. Past either cap a new message is refused (HTTP
`503`, gRPC `RESOURCE_EXHAUSTED`) and nothing already queued is dropped.

### Three helper modes, not three transports

A provisioned helper advertises `http`, `grpc`, or `both`; the transport
counters in the Settings section (**gRPC only** / **Both transports**, with
**HTTP** left to absorb the rest) set the shared pool's target composition the
same way its participant count does — a target, not an order to create, since
the pool is shared across every owner. What differs across the three is which
endpoint(s) a peer offers, not which protocol carries the messages an owner
actually sends: every provisioned actor answers over whichever protocol a
peer's contact reaches it on regardless of its own advertised mode.

### The relay

A browser cannot dial gRPC directly, so `POST /derec/relay` asks the backend
to dial an endpoint on the owner's behalf — the backend already terminates
transport for every actor here, so this is a small extension of that rather
than a new role. `grpc_relay_enabled` (default `true`) gates it.

Without a limit the relay would be an open proxy on an unauthenticated node,
so it delivers to:

- **this node**, under any address it answers to now (its `base_url` host or
  loopback, on the listen or public port) or has advertised before — delivered
  in-process, never dialled, so a browser still holding a helper's address
  from before the node's address changed keeps working even when the old port
  is gone;
- an endpoint some actor on this node currently advertises;
- **another node**, only if its host or `host:port` is listed in
  `server.relay_allowed_hosts` (`DEREC_RELAY_ALLOWED_HOSTS`), comma-separated —
  e.g. `DEREC_RELAY_ALLOWED_HOSTS=192.168.0.30:50051,node-b` — or `*` for any
  host. Empty by default. `*` exists for a trusted LAN where interop peers come
  and go faster than a list can be kept; boot warns while it is set.

So a browser owner on node A reaching a gRPC-only helper on node B needs B's
address in A's `relay_allowed_hosts`; without it the relay answers `403` with a
message naming that setting. Every refusal is recorded in `GET /api/v1/debug/events`
with its reason, attributed to the requesting owner when the request carries
its `actor_id`. With gRPC disabled on this node, a relay to this node's own
gRPC address is `409` saying so. This is also
the point where a message can cross from one transport to the other: pairing
with a grpc-only helper sends the request out over gRPC through the relay, and
the helper's reply comes back over HTTP to the owner's mailbox, same as any
other message.

Turn `grpc_relay_enabled` off and a browser owner has no way left to reach a
grpc-only helper — not a bug, the deliberately-observable consequence of a
browser's own transport limits. `apps/web/e2e/grpc.spec.ts` exercises exactly
this: an http-only helper, a grpc-only helper reached through the relay (with
a network-level check that the relay was actually the path a message took),
a helper offering both, and — with `/derec/relay` stubbed to fail — the
grpc-only helper's pairing request surfacing an error rather than hanging.

## Replicas

A replica is a second device belonging to the same owner, kept in sync so it can take over if the primary device is lost. Pairing is unidirectional: the existing device is the `ReplicaSource` (it holds the secret), the new device is the `ReplicaDestination` (it receives a mirrored copy). Each side needs a stable per-device replica id, set when the protocol instance is built; the destination's id survives adoption deliberately — it identifies the device, not the vault it holds.

### Setting one up

A replica is a pairing mode, not a kind of actor, so any helper can back one. **+ Add** in the Replicas tab provisions a helper under the name you type and pairs it in replica mode from this vault's `ReplicaSource` side — no second browser context involved. That is the primary path, and the one `replicas.spec.ts` exercises.

A replica backed by a *real second device* works too, and is what the feature ultimately models. To model a separate device, put the destination vault in **another browser context** — an incognito/private window, a different browser profile, a different browser or another machine — rather than beside the source in the same browser, whose storage every vault there shares. Set up a vault there, then pair it from the primary vault's `ReplicaSource` side. `browser-replica.spec.ts` covers this, in both directions.

### Fingerprint confirmation (required before syncing)

After the pairing handshake, the replica channel sits in `Pending` — it cannot receive anything yet. Each side independently derives the same `XXXX-XXXX-XXXX-XXXX` code from the shared key. A helper-backed replica confirms its own side automatically — it is an unattended fixture with no operator to read a code back to — so all that is left is confirming this device's side in the dialog that appears. Between two browsers there is no such shortcut: compare the two codes out of band (read them to each other, screenshot, etc.), then confirm on each side separately.

Only once **both** sides have confirmed does the channel move to `Paired`. This gate is enforced by the protocol library itself — it selects share targets from its own `Paired` channel table — not by app code, so there is no client-side bypass. A mirrored copy pushed before the destination has confirmed is ignored; the destination pulls it once it confirms.

### Adoption (destructive — erases the destination vault)

The first time a `ReplicaDestination` receives the source's mirrored secret, adopting it **wipes that vault's existing contents** and replaces them with the source owner's — secrets, helper roster, everything. The destination keeps adopting the *source's* secret id (its own replica id is untouched, as noted above), and afterwards enables auto reply-to so helpers — whose stored endpoint still points at the source — route their responses to the new device instead.

Because this is destructive, adoption sits behind a confirmation dialog whose default action is **Cancel** (autofocused, and what Escape/backdrop-click resolve to). Confirming requires a deliberate click on a separate, clearly-marked destructive action. Cancelling discards the offered payload and destroys nothing — the source's next sync re-offers it.

### Status

Exercised end to end and covered by `apps/web/e2e/replicas.spec.ts`: pairing
behind the fingerprint gate, a three-member group, mirroring with per-member
acknowledgement, sync check, and eviction. Those tests pair the group's
`Destination`s with **provisioned helpers** — a helper paired in replica mode
follows the identical protocol path an owner's second device would.

`apps/web/e2e/browser-replica.spec.ts` covers the browser-to-browser variant:
pairing as replicas in both directions with both sides confirming the
fingerprint, the copy arriving only once both have confirmed, the adoption
dialog being offered, and the replica group showing in View Payload. Confirming
adoption itself — the destructive step above — is not automated.

---

## Contributing

Contributions are welcome. Development setup, testing and the contribution
workflow are documented in `CONTRIBUTING.md`; the people behind the project are
listed in `AUTHORS.md`.

---

## License

Licensed under the Apache License, Version 2.0, the same license as the
[DeRec SDK](https://github.com/derecalliance/lib-derec).

See the `LICENSE` file for details.
