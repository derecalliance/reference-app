# DeRec Reference App

A minimal reference implementation of the [DeRec protocol](https://github.com/derecalliance/protocol/blob/main/protocol.md), providing both an Owner and a Helper for interoperability testing.

- `apps/web` — React + Vite static frontend. Executes DeRec flows (pairing, sharing, verification, recovery, replicas) client-side and polls the backend for messages.
- `apps/backend` — Rust + Axum thin backend. Actor registry and message relay only; no protocol logic lives here.

See `CLAUDE.md` for the full architecture and design principles, and
[`AGENTS.md`](AGENTS.md) if you are an LLM or coding agent driving this over
HTTP rather than through the UI.

## Debugging it

This is a developer's tool, so it is built to be inspected. There is no
authentication anywhere — exposing the internals is the point, and it is not
meant to be reachable from outside your machine.

Three places show you what is happening, all reading the same data:

| | |
| --- | --- |
| **Inspect tab** | The server's own view of itself: actors and the endpoints they advertise, which tier of the channel router holds each channel, how many protocol instances each actor runs. Refreshes live. |
| **Console panel** | What happened, in order — this page's own protocol events *and* the backend's message deliveries, tagged with the transport that actually carried each one. Copy or download the whole log as JSON. |
| **HTTP** | `GET /debug/state` and `GET /debug/events` return exactly what those two render. The full API is described in [`apps/backend/openapi.yaml`](apps/backend/openapi.yaml); a test keeps it in step with the router. |

The transport badge on each channel row is worth knowing about: `HTTPS`,
`GRPC` or `GRPC+HTTPS` tells you what that peer advertises. A trailing `~`
means the badge was derived from a single known address rather than the peer's
full advertised list, so it may be incomplete.

If a message is not arriving, `routes` in the Inspect tab usually explains it.
A channel in the `pinned` tier means a contact was minted and the handshake
never completed; `bound` means it did.

## Running it

The backend serves a single local node. Every browser context that opens the app
registers itself as an owner actor against it — a second tab, an incognito
window or another machine on the network is simply another owner. There is no
grouping above that: everything the server knows lives in one actor registry.

### In Docker

One image serves the UI and the API on the same origin, and keeps its state.

Nothing is published yet, so build it first. The tag names the SDK it was built
against — the SDK is compiled in (`derec-library` into the binary,
`@derec-alliance/web` into the bundled WASM), so a different SDK means a
different image rather than a different flag:

```
docker build -f apps/backend/Dockerfile -t derec/reference-app:0.0.4 .
docker run -d --name derec -p 5000:5000 -v derec-data:/var/lib/derec \
  derec/reference-app:0.0.4
```

Then open `http://localhost:5000`. There is no separate front-end server: the
page is served by the backend and calls back to the same origin, so publishing
on another host port works without configuration.

It survives a restart. Helpers you provisioned come back with the identities
and settings they had — including the `replica_id` every replica-group
membership references — and their channels and shares are still there:

```
$ docker restart derec
$ docker logs derec | grep recovered
INFO derec_backend::recovery: node recovered from the database helpers=3 …
```

What that costs you, and what it does not:

| Invocation | Survives `docker restart` | Survives `docker rm` + recreate |
| --- | --- | --- |
| no `-v` | yes, on an anonymous volume | no |
| `-v derec-data:/var/lib/derec` | yes | yes |
| `-e DEREC_DATABASE_URL=sqlite::memory:` | no — a deliberately scratch node | no |

**Prefer a named volume to a bind mount.** SQLite's locking over bind-mounted
host filesystems is unreliable on macOS and Windows, where the mount crosses
gRPC-FUSE or virtiofs, and it presents as intermittent `database is locked`
rather than as anything naming the mount.

Pairing across machines needs the LAN address, exactly as it does outside
Docker — it is stamped into every transport URI handed to a peer:

```
docker run -d -p 5000:5000 -v derec-data:/var/lib/derec \
  -e DEREC_BASE_URL=http://192.168.0.28 derec/reference-app:0.0.4
```

`examples/docker-compose.example.yaml` is the same thing as a compose file. The
container runs as a non-root user (uid 10001) and answers a healthcheck on
`/health`; `docker stop` drains rather than being killed, which matters now that
there is a database to close cleanly.

### The SDK

Both halves track SDK **0.0.4**, taken from the registries: `derec-library`
and `derec-proto` from crates.io, `@derec-alliance/web` from npm. No sibling
checkout is required for anything, including the end-to-end tests.

The backend generates its own gRPC transport service, because the published
`derec-proto` ships message types only. The 15 `.proto` files that needs are
vendored in `apps/backend/proto/`, and `tests/proto_drift.rs` checks them
against the pinned release — so bumping the SDK means re-copying them, and the
test tells you when you forgot.

### Plaintext endpoints in local development

The protocol refuses plaintext endpoints by default — `http://` and, since
0.0.3, `grpc://`. Loopback is exempt for the endpoint a node configures for
*itself*, but **not** for one a peer supplies — and every peer here is
`http://localhost:5000/derec/...`, so pairing fails without opting in. Both
apps do, and both derive it rather than hardcoding it:

```ts
.withUnsafeConnection(!ownTransportUri.startsWith('https://'))
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

An already-running backend or dev server is reused rather than restarted, so a
normal `npm run dev` session does not conflict with a test run.

Two constraints shape how these tests are written:

- **One owner per browser context.** The app scopes an owner to `localStorage`
  plus a Web Lock, so a second owner — a replica device, the other side of a
  pairing — needs its own `BrowserContext`, not just another page.
  `newOwnerContext()` in `e2e/app.ts` is the helper for that.
- **The backend is shared state.** One actor registry and one helper pool
  serve every test, so the suite runs single-worker and serially. A test should
  treat the helper pool as something that may already exist.

The specs cover the setup wizard, all three contact modes (including the
`NoKeys` fingerprint gate and its refusal path), replica groups (pairing,
mirroring, sync check, eviction), the secret lifecycle (protect, verify,
discover), recovery (reconstruction and `restore`), unpairing, and — in
`grpc.spec.ts` — the transport matrix described below: an http-only helper, a
grpc-only helper reached through the relay, a helper offering both, and the
relay-off failure.

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
to the laptop rather than to itself.

`DEREC_BASE_URL` is the one that must be set. It is not merely where the backend
listens — it is stamped into every transport URI handed to a peer, and that peer
posts to it. Left at `localhost`, pairing appears to work and then the peer
sends protocol messages to its *own* loopback. The backend logs a warning at
startup when it detects this.

#### Making the LAN origin a secure context

`http://` on a LAN address is not a [secure context], and browsers withhold a
lot there — `getUserMedia`, `BarcodeDetector`, and `crypto.randomUUID` among
them. The camera is the visible casualty; `randomUUID` is why plain LAN http
broke the setup wizard outright until the app stopped depending on it.

On Android, tell Chrome to treat the origin as secure. No certificates, nothing
to change here:

1. Open `chrome://flags` on the phone.
2. Find **Insecure origins treated as secure**.
3. Add your address with the port — `http://192.168.0.28:5173` — and set the
   dropdown to **Enabled**.
4. Relaunch Chrome when prompted.

Scanning then works: the origin is a secure context, so all four APIs above come
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

Two ways in, one merged result: a TOML file and environment variables, with the
environment winning. Anything settable one way is settable the other.

Worked examples of all of it live in [`examples/`](examples/) — every key
documented inline, nothing to look up:

| File | Copy it to | For |
| --- | --- | --- |
| `examples/config.example.toml` | `apps/backend/config.toml` | the TOML file |
| `examples/.env.example` | `.env` | environment variables |
| `examples/docker-compose.example.yaml` | `compose.yaml` | running it in Docker |

Copy `examples/config.example.toml` to `config.toml` beside the binary, or
mount it anywhere and point `DEREC_CONFIG_PATH` at it:

```
docker run -v ./my-config.toml:/etc/derec/config.toml \
           -e DEREC_CONFIG_PATH=/etc/derec/config.toml ...
```

Every key is optional — omit one and its built-in default applies. The
`[defaults]` table is defaults only: the wizard stays editable, and the settings
a node actually runs with are whatever the front end sends when it provisions
actors. A file that cannot be read, parsed or validated aborts the boot rather
than silently falling back. No file at all is fine and uses the built-in values.

Precedence, highest first:

| | Source | Beats |
| --- | --- | --- |
| 4 | `environment:` or `-e` on the container | everything |
| 3 | `env_file:` in compose — injects real variables | the file and the defaults |
| 2 | a `.env` beside the process — fills only variables **not already set** | the config file |
| 1 | the TOML config file | the built-in defaults |

Tiers 3 and 4 look the same to the app — both are just the environment by the
time it starts, and compose resolves that precedence itself.

Variable names are flat and prefixed; the table a key lives in does not appear:

| File key | Variable |
| --- | --- |
| `server.base_url` | `DEREC_BASE_URL` |
| `server.port` | `DEREC_PORT` |
| `server.database_url` | `DEREC_DATABASE_URL` |
| `server.static_dir` | `DEREC_STATIC_DIR` |
| `defaults.participant_count` | `DEREC_PARTICIPANT_COUNT` |
| `defaults.pre_paired_count` | `DEREC_PRE_PAIRED_COUNT` |
| `defaults.min_participants` | `DEREC_MIN_PARTICIPANTS` |
| `defaults.recommended_participants` | `DEREC_RECOMMENDED_PARTICIPANTS` |
| `defaults.protocol_timeout_secs` | `DEREC_PROTOCOL_TIMEOUT_SECS` |
| `defaults.authentication_method` | `DEREC_AUTHENTICATION_METHOD` |
| `defaults.unpair_ack` | `DEREC_UNPAIR_ACK` |
| `defaults.auto_accept_unpair_requests` | `DEREC_AUTO_ACCEPT_UNPAIR_REQUESTS` |
| `defaults.grpc_enabled` | `DEREC_GRPC_ENABLED` |
| `defaults.grpc_port` | `DEREC_GRPC_PORT` |
| `defaults.grpc_relay_enabled` | `DEREC_GRPC_RELAY_ENABLED` |
| `defaults.helper_transports.http` | `DEREC_HELPER_TRANSPORTS_HTTP` |
| `defaults.helper_transports.grpc` | `DEREC_HELPER_TRANSPORTS_GRPC` |
| `defaults.helper_transports.both` | `DEREC_HELPER_TRANSPORTS_BOTH` |

`DEREC_CONFIG_PATH` names the config file and is not itself a setting.

`BASE_URL`, `PORT` and `STATIC_DIR` are no longer read (the last is now
`DEREC_STATIC_DIR`). Setting one without its
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
data is available as JSON from `GET /debug/config`.

## Transports

The backend speaks HTTP and gRPC. A browser owner only ever speaks HTTP itself
— it has no HTTP/2 trailer access — so gRPC exists here to prove the protocol
is transport-agnostic and to let the reference app interoperate with a peer
that only offers gRPC, not to give the browser a second way to talk.

### The gRPC listener

`grpc_enabled` (default `true`) and `grpc_port` (default `50051`) control the
backend's own gRPC server. It is separate from the HTTP listener `DEREC_BASE_URL`
points at, and provisioned helpers can only advertise a `grpc://` endpoint
while it is running — turn `grpc_enabled` off to run HTTP-only.

### Three helper modes, not three transports

A provisioned helper advertises `http`, `grpc`, or `both`; the setup wizard's
transport counters (**gRPC only** / **Both transports**, with **HTTP** left to
absorb the rest) set the shared pool's target composition the same way its
participant count does — a target, not an order to create, since the pool is
shared across every owner. What differs across the three is which endpoint(s)
a peer offers, not which protocol carries the messages an owner actually
sends: every provisioned actor answers over whichever protocol a peer's
contact reaches it on regardless of its own advertised mode.

### The relay

A browser cannot dial gRPC directly, so `POST /derec/relay` asks the backend
to dial an endpoint on the owner's behalf — the backend already terminates
transport for every actor here, so this is a small extension of that rather
than a new role. `grpc_relay_enabled` (default `true`) gates it. This is also
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

A replica is a pairing mode, not a kind of actor, so any helper can back one. **+ Add** in the Replicas section provisions a helper under the name you type and pairs it in replica mode from this device's `ReplicaSource` side — no second browser context involved. That is the primary path, and the one the e2e suite exercises.

A replica backed by a *real second device* still works, and is what the feature ultimately models. Because the app supports one user per browser context, that route needs a **second** browser context — an incognito/private window, a different browser profile, or a different browser entirely. This is a limitation of the frontend, not of the protocol. Open the app in that second context and run **Set up** to register it as its own owner actor on the same backend, then pair it from the primary device's `ReplicaSource` side.

### Fingerprint confirmation (required before syncing)

After the pairing handshake, the replica channel sits in `Pending` — it cannot receive anything yet. Each side independently derives the same `XXXX-XXXX-XXXX-XXXX` code from the shared key. A helper-backed replica confirms its own side automatically — it is an unattended fixture with no operator to read a code back to — so all that is left is confirming this device's side in the dialog that appears. With a second browser context there is no such shortcut: compare the two codes out of band (read them to each other, screenshot, etc.), then confirm on each side separately.

Only once **both** sides have confirmed does the channel move to `Paired`. This gate is enforced by the protocol library itself — it selects share targets from its own `Paired` channel table — not by app code, so there is no client-side bypass.

### Adoption (destructive — erases the destination's vault)

The app holds one vault per user. The first time a `ReplicaDestination` receives the source's mirrored secret, adopting it **wipes that device's existing vault** and replaces it with the source owner's — secrets, helper roster, everything. The destination keeps adopting the *source's* secret id (its own replica id is untouched, as noted above), and afterwards enables auto reply-to so helpers — whose stored endpoint still points at the source — route their responses to the new device instead.

Because this is destructive, adoption sits behind a confirmation dialog whose default action is **Cancel** (autofocused, and what Escape/backdrop-click resolve to). Confirming requires a deliberate click on a separate, clearly-marked destructive action. Cancelling discards the offered payload and destroys nothing — the source's next sync re-offers it.

### Status

Exercised end to end and covered by `apps/web/e2e/replicas.spec.ts`: pairing
behind the fingerprint gate, a three-member group, mirroring with per-member
acknowledgement, sync check, and eviction.

That coverage pairs the group's `Destination`s with **provisioned helpers** —
backend fixtures — rather than a second browser context: a replica is a
pairing mode, not a kind of actor, so a helper paired in replica mode follows
the identical protocol path an owner's second device would, and an unattended
fixture auto-confirms its own fingerprint, leaving this device to confirm only
its own. The browser-to-browser variant is still only manually verified, and
adoption (the destructive step above) has no automated coverage at all: it is
gated on a human confirming a dialog that erases the device's vault.
