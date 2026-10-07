# Docker packaging and persistence

One image, one command, a working DeRec node with its UI:

```
docker run -p 5000:5000 -p 50051:50051 -v derec-data:/var/lib/derec \
           derec/reference-app
```

Open `localhost:5000` and the setup wizard is there; stop the container, start
it again, and the actors, channels and shares are still there. That is the whole
deliverable. `2026-09-01-node-separation-admin-ui-design.md` deferred packaging
to a follow-up spec; this is it.

**This spec supersedes `docs/superpowers/plans/2026-09-02-persistence-and-supervision.md`.**
That plan was written and never executed — there is no `sqlx` in `Cargo.toml`
and no `migrations/` directory — and it still targets SDK 0.0.2. Its design
survives here, updated; the plan document is retired rather than carried
alongside, because a restart that resets is the exact bad experience packaging
is supposed to remove, and shipping an image without persistence would ship that
experience on purpose.

Everything below rests on one fact that changed since that spec was written:
**SDK 0.0.3 is published.** `derec-library` and `derec-proto` are on crates.io
(both 0.0.3, 2026-09-12) and `@derec-alliance/web` is on npm at `latest`
0.0.3. The repo has not caught up — both halves still consume a sibling
checkout, and the README still says the release does not exist. Packaging is
what forces the issue, because a build context rooted at this repo cannot see a
sibling directory at all.

## The dependency switch comes first

`apps/backend/Cargo.toml` drops the two `path =` attributes and keeps the
version pins. `apps/web/package.json` takes `"@derec-alliance/web": "^0.0.3"`
from npm. The lockfiles are regenerated. After this, nothing in the repo needs
`../../../lib-derec` to exist.

This is the riskiest change in the spec and it has nothing to do with Docker.
If the local `lib-derec` checkout carries commits past the 0.0.3 tag, the app
starts building against genuinely different SDK code, and the symptom may be a
protocol failure at runtime rather than a compile error. It therefore lands
first, on its own, with the full suite green before any Dockerfile exists.

Two workarounds die with the `file:` dependency, and leaving them would be
leaving a half-migration:

- `vite.config.ts` loses `linkedSdkDirs()`, its `server.fs.allow` entry and
  `optimizeDeps.exclude`. All three exist only because npm installs a `file:`
  dependency as a symlink that resolves outside the project root; the file's own
  comment says they become a no-op the moment the dependency goes back to a
  registry version.
- `deploy-web-app.yml` gains `working-directory: apps/web`. It runs `npm ci` at
  the repo root today, where there is no `package.json`, and even pointed at the
  right directory it would fail on the `file:` dependency because CI has no
  sibling checkout. **The Pages deploy is broken right now**; the switch fixes
  it.

The Playwright suite gets the same benefit for free: it can run on a machine
that has never cloned `lib-derec`.

### Vendored protos

`build.rs` compiles `derectransport.proto` with `tonic-prost-build`, because the
published `derec-proto` ships prost types only — the gRPC service is generated
here, not upstream. Those `.proto` files come from the sibling checkout today.

The crate does ship them: `derec-proto`'s `include` covers `protobufs/**` and
`grpc/**`. But it declares no `links` key, so there is no `DEP_DEREC_PROTO_*`
variable pointing at them, and a consumer cannot locate a dependency's source
directory without guessing at the registry cache layout. Guessing inside
`build.rs` would break under sparse-vs-git registries, vendored builds, or a
non-default `CARGO_HOME`.

So the protos are **vendored into `apps/backend/proto/`**: the 15 files
`derectransport.proto` needs transitively — itself, `derecmessage.proto`, and
the 13 reached from there. `contact.proto`, `derecsecret.proto` and
`committedderecshare.proto` are not in the import graph and are not copied.
`build.rs` points its include paths and its `rerun-if-changed` lines at the new
directory.

The cost is 15 checked-in files that must be re-synced on an SDK bump. A drift
test covers it; see Testing.

## The image version is the SDK version

The SDK cannot be selected at runtime — `derec-library` is compiled into the
binary and `@derec-alliance/web` is WASM that Vite bundles into the built assets
— and it is deliberately not selectable at build time either. There is no
version argument.

The image tag tracks the SDK it was built against: `reference-app:0.0.4` runs
SDK 0.0.4, and someone who wants a different SDK pulls a different image. The
guarantee is legible from outside the image, which a build argument would
destroy: with one, any image-to-SDK combination could be produced and only the
default would ever have been exercised.

Bumping the SDK is therefore an ordinary dependency change — manifests,
lockfiles, re-vendored protos, tests — that produces a new tag. Note the tag
names the SDK, not the crate versions inside the repo, which are unrelated to
what the image promises.

## Configuration

Two ways in, one merged result: a TOML file and environment variables, with the
environment winning. Anything settable one way is settable the other.

Today neither half of that is true. The TOML file holds front-end wizard
defaults only; `BASE_URL`, `PORT` and `STATIC_DIR` are environment-only; and
nothing is settable both ways.

### The ladder

Four tiers, and being exact matters because two of them get called ".env":

| | Source | Beats |
| --- | --- | --- |
| 4 | `environment:` or `-e` on the container | everything |
| 3 | `env_file:` in compose — injects real variables into the container | the file and the defaults |
| 2 | a `.env` beside the process, read by dotenv — fills only variables **not already set** | the config file |
| 1 | the TOML config file | the built-in defaults |

Tiers 3 and 4 are indistinguishable to the process — both are simply the
environment by the time it starts, and compose resolves that precedence itself.
Tier 2 is the one this app controls, and dotenv's not-overriding default is
already the right behaviour for it.

`dotenv` 0.15 is unmaintained (RUSTSEC-2021-0141) and becomes `dotenvy`, which
keeps the same non-overriding semantics.

### One file, two domains

The file grows a `[server]` table — `base_url`, `port`, `database_url`,
`static_dir` — beside the wizard values, which move under `[defaults]`.

Moving them rather than leaving them at the top level is not tidiness. TOML
assigns every key following a table header to that table, so a file mixing
top-level scalars with a `[server]` table parses correctly only while the
scalars stay first, and appending a key in the obvious place produces an error
that does not explain itself. `deny_unknown_fields` is already on, so a
file in the old shape fails loudly rather than ignoring half of itself.

### Naming

Every variable carries `DEREC_`, with no unprefixed aliases: `DEREC_PORT`,
`DEREC_BASE_URL`, `DEREC_DATABASE_URL`, `DEREC_STATIC_DIR`,
`DEREC_PARTICIPANT_COUNT`, `DEREC_GRPC_PORT`, and so on for every key in both
tables. One namespace, one rule, and a stray `DEREC_*` is detectably a typo.

The names stay **flat** rather than encoding the table — `DEREC_PARTICIPANT_COUNT`,
not `DEREC_DEFAULTS__PARTICIPANT_COUNT`. Key names are unique across the two
tables, so a flat namespace is unambiguous, and a compose file is read far more
often than it is written. The cost is a small map from variable name to config
path, and a test asserting the flat namespace has no collisions — so a future
key added to one table that shadows a key in the other fails a test rather than
silently overriding the wrong field.

`VITE_API_SAME_ORIGIN` is untouched by this. It is a build-time Vite variable,
which must carry that prefix to be visible to the bundle at all, and it never
reaches the backend.

### Merging

`figment`, layering `Toml::file` under `Env::prefixed("DEREC_")` — and
deliberately **no defaults provider**. `Defaults::resolve` (`config.rs:132`)
already owns the built-in values, and it does more than substitute them: it
clamps `min_participants`, `recommended_participants` and `pre_paired_count`
against whatever `participant_count` ended up being, so that writing only
`participant_count = 4` means "four participants" rather than "four
participants and please fail because the stock recommendation of five no longer
fits". A figment defaults layer would populate every `Option` before `resolve`
ever saw it, turning every unset field into an explicit one and destroying that
behaviour. figment merges the `Option`s; `resolve` fills them; `validate` judges
the result.

Three properties matter more than the library choice:

**Validation runs on the merged result, never per-source.** `helper_transports`
must sum to `participant_count`. If the file sets the breakdown and a variable
overrides the count, validating the file alone passes and the node runs
inconsistent. This is the trap in the whole section.

**Partial overrides stay partial.** `RawDefaults` is all-`Option` deliberately —
`resolve()` adapts unset fields instead of validating one override against three
values nobody touched. Merging happens at the `Option` level; no layer may
deserialize into a fully-populated struct and silently assert defaults over the
layer beneath it.

**Unknown keys are handled differently per source.** A misspelled key in the
file aborts the boot, as it does today: the file is unambiguously the
developer's. An unrecognised `DEREC_*` variable warns instead, naming the known
keys. The environment is shared, and refusing to boot because something
unrelated shares the prefix is hostile.

figment also tracks which source each value came from, which is why it is worth
a dependency here rather than a hand-rolled merge. A developer who sets a
variable and sees no effect can see what outranked it instead of guessing — the
same reason the rest of this app exposes its internals.

Provenance is served from a **new `GET /debug/config`**, not from `GET /config`.
The latter returns a flat `Defaults` object that the front end deserialises
directly, and widening it to carry per-key origins would be an API change for
every consumer in exchange for data only a debugging view wants. `/debug/config`
sits with `/debug/state` and `/debug/events`, which is where the Inspect tab
already looks and where the "unauthenticated by design" comment already applies.

### Reporting what was loaded

Provenance is not only for the UI. The single most common failure with layered
configuration is a setting that was overridden by a layer the developer forgot
about, and in a container the only thing they have to look at is `docker logs`.
So the node prints its entire resolved configuration at boot, after merging and
validation and before it serves anything.

Every setting appears — not only the overridden ones. A developer who set a
variable and saw no effect needs to see that key reported as `default`, because
that *is* the diagnosis. Printing only what changed would hide exactly the case
the log exists to explain.

```
configuration
  file   /etc/derec/config.toml  loaded
  .env   not present
  env    7 DEREC_* variables

  [server]
  base_url                  http://192.168.0.28      env DEREC_BASE_URL
  port                      5000                     default
  database_url              /var/lib/derec/derec.db  env DEREC_DATABASE_URL
  static_dir                /app/static              default

  [defaults]
  participant_count         3                        env DEREC_PARTICIPANT_COUNT
  pre_paired_count          1                        env DEREC_PRE_PAIRED_COUNT
  min_participants          2                        env DEREC_MIN_PARTICIPANTS
  recommended_participants  2                        env DEREC_RECOMMENDED_PARTICIPANTS
  protocol_timeout_secs     300                      default
  authentication_method     user                     default
  unpair_ack                required                 file
  auto_accept_unpair_requests  true                  default
  grpc_enabled              true                     default
  grpc_port                 50051                    default
  grpc_relay_enabled        true                     default
  helper_transports.http    3                        env DEREC_HELPER_TRANSPORTS_HTTP
  helper_transports.grpc    0                        default
  helper_transports.both    0                        default
```

Three rules make it useful rather than decorative:

- **The origin column is the value's actual source, not a guess.** A key
  written into the file with the same value the built-in default has reports
  `file`, because that is where it came from and the developer editing that file
  needs to see their line took effect.
- **`database_url` is redacted** by the same rule the startup line already uses.
  It is the one setting likely to carry a password and the one most likely to be
  pasted into an issue.
- **Order is stable across runs**, grouped by table, so two logs can be diffed
  when a developer asks why the same image behaves differently on two machines.

The header lines matter as much as the table. "No config file found" is a
frequent surprise when `DEREC_CONFIG_PATH` points somewhere the mount did not
land, and today that case is a single line that scrolls past; here it sits
directly above the values it explains.

A test asserts the banner does not lie: a setting supplied by environment
reports `env`, one supplied by file reports `file`, and an untouched one reports
`default`. Without it the log is free to drift into being confidently wrong,
which is worse than having no log at all.

### The one wart

With no unprefixed aliases, the app reads `DEREC_DATABASE_URL` while `sqlx-cli`
expects `DATABASE_URL`. This affects nothing at runtime or build time:
migrations run at boot through `sqlx::migrate!` against the pool the app already
built, and the stores use the runtime query API rather than the compile-time
checked macros, so neither needs the variable. It surfaces only for a developer
running `sqlx migrate` by hand, and the README says so.

## Persistence

Today every registry is a `dashmap` in `state.rs` and every store is one of the
five `InMemory*` implementations in `stores.rs`. All of it dies with the
process. Under `cargo run` that is merely inconvenient; in a container it is the
defining problem, because `docker restart` or a host reboot throws away a paired
set of helpers and every share they hold, with nothing to show the developer
what happened.

### One abstraction, two engines

`sqlx` 0.8 over an `AnyPool`, with `runtime-tokio-rustls`, `sqlite` and
`postgres`. SQLite is compiled into the binary — there is no SQLite service and
nothing to install in the image — so Postgres becomes a URL away rather than a
rewrite.

The five SDK trait stores gain SQL implementations and the `dashmap` registries
become tables. A trait-conformance suite is written **first**, against the
existing in-memory stores, so it is proven meaningful before any SQL exists;
each SQL store then passes that same suite on both engines. The Postgres run is
opt-in — it executes when `TEST_DATABASE_URL` names a reachable database and
prints a skip otherwise, so nobody needs a Postgres to work on this repo.

One migration set in `apps/backend/migrations/` must run unmodified on both
engines: no `AUTOINCREMENT`, no `SERIAL`, no backticks, no type either engine
lacks. Binary goes in as base64 `TEXT` rather than reaching for a portable blob
type.

The schema is shared, not owned. Node separation is still ahead on the roadmap,
so no table may assume a single process holds all of them.

### Two constraints that are easy to get wrong

**`u64` ids are `TEXT`.** Every `secret_id`, `channel_id` and `replica_id` is a
`u64`; SQLite has no unsigned 64-bit integer and Postgres has no `u64`. Store
them decimal-encoded as `TEXT`. An `i64` bit-cast makes ordering and comparison
semantics wrong at the high end and stays invisible until it bites. This is the
decision the HTTP layer already made — `Actor::secret_id` serialises as a string
because `u64` exceeds JavaScript's exact integer range.

**The uniformity constraint.** No table, column or key may distinguish a
provisioned actor from a real one: no `is_bot`, no `provisioned`, no
role-dependent tables, no role-dependent code paths in the store layer. Being a
provisioned fixture is node configuration and must never reach a row.

Serialisation follows the SDK rather than inventing DTOs. `derec-library`'s
`serde` feature is required — enabling a feature is not a modification of the
SDK. `ChannelRecord`, `HelperChannel` and `ReplicaMember` derive serde
unconditionally; `SecretValue` does so behind that feature; `StateItem` has no
serde at all and round-trips through the SDK's own `StateItemRecord`; `Share`
has public scalar fields and maps straight to columns, its channel and replica
keying coming from method arguments rather than the struct. The SDK's own tests
name serde "the path a store implementation takes", so this is the endorsed
route and not a workaround.

### Restart recovery

Surviving state is only half of it. Helper actors go under an Actix `Supervisor`
so a restart rebuilds them from the database instead of coming back empty.
Supervision lands after the stores, because a supervised restart is only worth
having once there is state for it to recover.

### Configuration surface

One setting: `server.database_url` in the file, `DEREC_DATABASE_URL` in the
environment, layered as Configuration describes.

There is deliberately no `database_type`: the scheme already names the engine,
and a second setting could only ever contradict the URL, at which point this
spec would owe a precedence rule that nobody should have to learn.

| Value | Result |
| --- | --- |
| unset | the image default, `/var/lib/derec/derec.db` |
| a bare path — `./derec.db` | SQLite at that path; normalised to `sqlite://./derec.db?mode=rwc` |
| anything containing `://` | passed through untouched — Postgres URLs and tuned SQLite URLs both arrive this way |
| `sqlite::memory:` | the explicit way to ask for an ephemeral node |

Any password in the URL is redacted before it reaches the startup log — which
matters more now that the value can arrive from a file, an `env_file`, or the
command line, and a developer may not remember which.

### What makes it persistent is the volume

The app never detects a volume. Docker does not tell a process what backs a
path, and inspecting mountinfo to guess is both fragile and surprising. The
binary always writes to the configured path — exactly as the official Postgres
image always writes `/var/lib/postgresql/data` — and `VOLUME /var/lib/derec`
lets Docker decide what that means:

| Invocation | Survives `docker restart` | Survives `docker rm` + recreate |
| --- | --- | --- |
| no `-v` (anonymous volume) | yes | no |
| `-v derec-data:/var/lib/derec` | yes | yes |
| `DEREC_DATABASE_URL=sqlite::memory:` | no | no |

So the default already satisfies the restart case, and a named volume is what a
developer adds to keep data across recreation. This is the same bargain the
Postgres image offers, which is the point: it is a shape people already know.

**Prefer a named volume to a bind mount.** SQLite's locking over bind-mounted
host filesystems is unreliable on macOS and Windows, where the mount crosses
gRPC-FUSE or virtiofs, and the failure presents as intermittent `database is
locked` rather than as anything naming the mount. Named volumes live in the
VM's own filesystem and do not have the problem. The README says so explicitly.

The container runs as a non-root user, which makes directory ownership a real
concern. A fresh named or anonymous volume inherits the image's ownership of the
mount point, so that case is fine; a bind-mounted host directory keeps host
ownership and can surface as a permission error at boot. The entrypoint handles
it rather than leaving a developer to diagnose it.

## The image

Three stages, one published image.

**Web builder** — `node:22-bookworm-slim`. `npm ci` in `apps/web`, then
`npm run build -- --base=/`. The `--base` override is the only thing separating
this from the Pages build, which keeps the configured `/reference-app/`. Neither
`wasm-pack` nor `protoc` appears in this stage any more: the npm package ships
prebuilt WASM, which is most of why the switch to a released SDK makes a
single-image build tractable.

**Backend builder** — `rust:1.88-bookworm` plus `protobuf-compiler`. The pin is
not arbitrary: both SDK crates declare `rust-version = "1.88"` and edition 2024.
`protoc` is still needed, now for the vendored protos. Manifests are copied and
built before the sources so the dependency layer caches across ordinary edits —
note that `apps/backend/proto/` must be copied in *before* that
dependency-warming build, because it runs `build.rs` too.

**Runtime** — `debian:bookworm-slim` with `ca-certificates`, `curl` and
`sqlite3`, carrying the binary and the built `dist/`. Slim over distroless is a
deliberate call: `build_router` already carries the comment that this app "ships
as a developer's local container and exposing its internals is the point", and
the README frames the whole thing as built to be inspected. A shell to `docker
exec` into is worth a few megabytes in a tool whose purpose is debugging.
`curl` is there for the healthcheck.

`sqlite3` is there for the same reason the Inspect tab is. The CLI is not what
the app uses — SQLite is linked into the binary — but a developer who wants to
know why a channel is in the state it is in should be able to open the database
and look. Nothing else in the image depends on it, so it can go if size ever
becomes the binding constraint.

The stage also declares `VOLUME /var/lib/derec`, creates the non-root user the
process runs as, and owns the data directory to it. An entrypoint reconciles
ownership when a bind mount arrives with host ownership instead.

A `.dockerignore` excludes `target/`, `node_modules/`, `dist/`, `test-results/`,
`playwright-report/` and `.git`.

## Serving the UI from the backend

`build_router` gains `.fallback_service(ServeDir::new(static_dir))`, requiring
`tower-http`'s `fs` feature. The route table is entirely explicit paths, so a
fallback introduces no ambiguity, and there is no SPA fallback because the app
has no client-side routes.

It is driven by a new `server.static_dir` setting. Unset — the ordinary `cargo run`
plus Vite dev loop, and every integration test — nothing is mounted and
behaviour is byte-identical to today. The image sets it to `/app/static`.

### Resolving the API base

`resolveApiBase()` returns `protocol//hostname:5000` when `VITE_API_URL` is
unset. That is exactly right for the case it was written for: a phone opening
`http://192.168.0.28:5173` finds the backend at `http://192.168.0.28:5000`
with no configuration. It is wrong the moment the image is published on any
other host port — a page served at `:8080` would call `:5000` and find nothing.

The image's web build sets a new `VITE_API_SAME_ORIGIN=1`, under which the
function returns `window.location.origin`. Precedence is `VITE_API_URL`, then
same-origin, then the derived `:5000`, so the dev and LAN paths are untouched.

## Runtime surface

`EXPOSE 5000` — API and UI share the origin — and `50051` for gRPC. Both
listeners already bind `0.0.0.0` (`main.rs:87`, `grpc.rs:77`); nothing to change.

Image defaults: `DEREC_PORT=5000`, `DEREC_BASE_URL=http://localhost`,
`DEREC_STATIC_DIR=/app/static`,
`DEREC_DATABASE_URL=/var/lib/derec/derec.db`. `DEREC_CONFIG_PATH` is left unset,
because the loader already treats "no file" as the ordinary `docker run` case
and falls back to built-in values, while a file that cannot be read or parsed
aborts the boot.

Every one of these is a rename. `BASE_URL`, `PORT` and `STATIC_DIR` exist
unprefixed today and stop being read; see Risks.

Pairing across machines needs `-e DEREC_BASE_URL=http://<lan-ip>`, since it is
stamped into every transport URI handed to a peer. The loopback warning at
`main.rs:30` already names that failure mode for anyone who forgets.

### Mounts

Two, both optional: the data volume at `/var/lib/derec` described under
Persistence, and the read-only config TOML the README already advertises. The
node-separation spec's inherited "volume for the SQLite database" is satisfied
by the former.

### SIGTERM

`with_graceful_shutdown` listens for `ctrl_c()` alone (`main.rs:96`). `docker
stop` sends SIGTERM, which nothing handles, so every stop blocks for the full
timeout and is then SIGKILLed. A SIGTERM arm joins the existing SIGINT one.

This is a pre-existing bug, and containerizing is what makes it visible — but
persistence is what makes it matter. Before, a SIGKILLed process lost state that
was going to be lost anyway. With a database behind it, the same SIGKILL closes
the pool mid-write instead of draining it.

### Healthcheck

`HEALTHCHECK` against the existing `/health` route.

## What consuming it looks like

These are the target artefacts, and they double as the fixture for the
restart-survival CI job. The README carries the same three.

### `compose.yaml`

```yaml
name: derec

services:
  node:
    image: derec/reference-app:0.0.3   # tag == SDK version, always

    # Bulk configuration. `env_file` injects real environment variables into
    # the container, so everything here outranks config.toml.
    env_file: .env

    # Highest precedence — wins over .env and over the file.
    environment:
      # Peers post back to this address, so loopback works right up until a
      # second device joins. Note there is no port: the node appends its own.
      #
      # ${LAN_IP} is substituted by compose from the .env at the project root —
      # a different mechanism from `env_file` above, which passes variables
      # into the container rather than into this file.
      DEREC_BASE_URL: "http://${LAN_IP:-localhost}"
      DEREC_CONFIG_PATH: /etc/derec/config.toml

    ports:
      - "5000:5000"      # HTTP API and the UI, same origin
      - "50051:50051"    # gRPC transport

    volumes:
      - derec-data:/var/lib/derec              # named: survives `docker rm`
      - ./config.toml:/etc/derec/config.toml:ro

    restart: unless-stopped

    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:5000/health"]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 10s

volumes:
  derec-data:
```

### `.env`

```bash
# Injected by `env_file:` in compose.yaml. Real environment variables, so these
# outrank config.toml.

# Inside the container. The named volume is what makes it durable.
DEREC_DATABASE_URL=/var/lib/derec/derec.db

# A scratch node that forgets everything on exit:
# DEREC_DATABASE_URL=sqlite::memory:

# A smaller set than the file's 7, for a quicker loop.
#
# Changing the count means changing the breakdown too: it must sum to
# participant_count, and that check runs on the MERGED result. Override the
# count here and leave the file's 7/0/0 alone and the node refuses to boot.
DEREC_PARTICIPANT_COUNT=3
DEREC_PRE_PAIRED_COUNT=1
DEREC_MIN_PARTICIPANTS=2
DEREC_RECOMMENDED_PARTICIPANTS=2
DEREC_HELPER_TRANSPORTS_HTTP=3
DEREC_HELPER_TRANSPORTS_GRPC=0
DEREC_HELPER_TRANSPORTS_BOTH=0
```

That last block is the clearest illustration of why validation runs on the
merged result: overriding the count while the file still says `7/0/0` is a
configuration that passes per-source validation and fails as a whole. It is
also the first mistake a developer will make with this.

### `config.toml`

```toml
# Two tables:
#   [server]    how this node runs — addresses, ports, storage
#   [defaults]  starting values for the front-end setup wizard
#
# Every key is optional; omit one and the built-in default applies. An
# unrecognised key is a boot error, so a typo fails loudly.
#
# Every key is also an environment variable, which wins. Names are flat and
# prefixed — the table does not appear: `participant_count` is
# DEREC_PARTICIPANT_COUNT, `database_url` is DEREC_DATABASE_URL, and nested
# keys spell out, e.g. DEREC_HELPER_TRANSPORTS_HTTP.

[server]
# Stamped into every transport URI handed to a peer. The port is appended, so
# write the host only.
base_url = "http://localhost"
port = 5000

# A bare path is SQLite. Anything with a scheme passes through untouched, so
# `postgres://...` and a tuned `sqlite://...?cache=shared` both work here.
# `sqlite::memory:` asks for a node that forgets on exit.
database_url = "/var/lib/derec/derec.db"

# Built front-end assets. Unset serves no UI, which is what you want when Vite
# is serving it in dev.
static_dir = "/app/static"

[defaults]
# Participants to provision when setting up. At least 1.
participant_count = 7

# How many to pair automatically, skipping the QR exchange. A testing
# shortcut; must not exceed participant_count.
pre_paired_count = 3

# Paired participants required before secret protection is allowed.
min_participants = 3

# Paired participants below which the UI warns. Between min and count.
recommended_participants = 5

# The single protocol timeout, in seconds. Expired messages and stale rounds
# are discarded with it, and the UI uses it as its active deadline.
protocol_timeout_secs = 300

#   "user"         the helper links channels manually when accepting a pairing
#   "application"  reserved for a future identity-driven mode; not selectable
authentication_method = "user"

#   "required"      initiator keeps local state until the peer acknowledges
#   "not_required"  fire-and-forget; state drops immediately
unpair_ack = "required"

# Accept incoming unpair requests quietly, or surface a confirmation dialog.
auto_accept_unpair_requests = true

# The gRPC listener. Provisioned helpers can advertise grpc:// only while it
# runs; false gives an HTTP-only node.
grpc_enabled = true
grpc_port = 50051

# Whether the backend dials gRPC for a browser owner, which cannot itself.
# False makes a gRPC-only helper unreachable from a browser — worth observing
# on purpose.
grpc_relay_enabled = true

# Must sum to participant_count.
[defaults.helper_transports]
http = 7
grpc = 0
both = 0
```

Worth noting what the restructure removes. `config.example.toml:68-70` currently
carries a warning that `[helper_transports]` must be the last thing in the file,
because any plain key after a table header is parsed into that table. Explicit
`[server]` and `[defaults]` tables retire that note: `[defaults.helper_transports]`
nests properly and keys can sit wherever they read best.

## Testing

`apps/backend/tests/proto_drift.rs`, following the `openapi_drift.rs` idiom
already in the repo: locate `derec-proto-<version>/` under
`$CARGO_HOME/registry/src/*/` and diff each vendored file against the crate's
shipped copy.

This is the same registry-path guessing rejected for `build.rs`, and the
asymmetry is deliberate. In a test the guess fails *soft*: when the path does
not resolve the test skips with a printed note, costing coverage. In `build.rs`
the same guess fails the build on a machine whose only sin was a different
`CARGO_HOME`.

`apps/backend/tests/store_conformance.rs` is the suite every store
implementation must pass on every engine, and the order it is built in is the
point: it is written against the existing in-memory stores first, so it is known
to be a meaningful test before there is any SQL for it to bless. The SQL
implementations then have to pass the same assertions, on SQLite always and on
Postgres whenever `TEST_DATABASE_URL` is set. Postgres is not per-test isolated
the way `sqlite::memory:` is, so that run either uses ids unique per run or
truncates first — whichever, it must not assume an empty database.

A CI job builds the image, runs it, and asserts that `/health` answers and that
`/` serves the built `index.html`. Without it the single-command promise rots
silently — the image would keep building long after it stopped being usable.

That job also has to prove the headline claim rather than assume it: create an
actor against the running container, `docker restart`, and assert the actor is
still there. A persistence bug that only shows up across a process boundary is
invisible to every test that runs inside one, and it is precisely the failure
this spec exists to prevent. The same check against
`DEREC_DATABASE_URL=sqlite::memory:` must show the opposite, or the test is
passing for the wrong reason.

Configuration gets its own tests, because precedence is the kind of thing that
is assumed rather than verified: a file value overridden by a variable, a
variable left unset falling through to the file, a `.env` losing to a real
variable, an unknown file key aborting, an unknown `DEREC_*` variable only
warning, and — the one that actually bites — a merged-but-invalid combination
being rejected, with the count from the environment and the transport breakdown
from the file.

The Playwright suite needs no changes. Note that `pairing.spec.ts:35` flakes on
an owner-side mailbox poll stall; a failure there during the dependency-switch
phase should be re-run before being read as an SDK regression.

## Documentation

The README's "Building the SDK from source (temporary)" section is deleted —
the temporary period is over — and replaced with how to run the image. The
`docker run -v ./my-config.toml ...` snippet at line 232 stops being
aspirational and becomes the documented path. The vite.config comments about the
`file:` symlink go with the code they describe.

The README carries all four worked artefacts from *What consuming it looks
like*: the `compose.yaml`, the `.env`, the `config.toml`, and a plain `docker
run` form for someone who does not want compose at all. They are the first
thing a developer copies, so they belong in the README rather than only in a
spec nobody reads twice — and the comments inside them are doing real teaching,
particularly the `env_file`-versus-substitution distinction and the merged
validation trap.

Those files live in the repo as well as in the prose: `compose.yaml` and
`.env.example` at the root, and `config.example.toml` restructured into
`[server]` and `[defaults]`. A README example that has drifted from a working
file is worse than no example, and the CI job runs the real one.

Configuration also needs a table of every setting with its file key, its
variable name and its default — the reference a developer writing a compose
file actually wants — plus the precedence ladder and a sample of the boot
banner, so someone comparing their own logs knows what they are looking at.

Persistence needs its own short section: what `DEREC_DATABASE_URL` accepts, the
restart-versus-recreate table, why a named volume beats a bind mount, and how to
get an ephemeral node on purpose. `CLAUDE.md` currently describes a backend whose
state is a flat in-memory registry, which stops being true in phase 3 — its
backend-responsibilities list gains the database, and the claim that the front
end persists to IndexedDB should be corrected to `localStorage` while someone is
in there, since it has been wrong for a while.

## Implementation order

1. **Dependency switch.** Registry pins, regenerated lockfiles, vendored protos,
   `build.rs` repointed, vite.config workarounds removed, Pages workflow fixed.
   Full suite green — including Playwright — before anything else starts.
2. **Configuration.** `figment` and `dotenvy`, the `[server]`/`[defaults]` file
   shape, `DEREC_*` names with the collision test, merged-result validation,
   the boot banner with its provenance test, and provenance on `GET /config`.
   Lands before storage because storage is the first consumer of a setting that
   has to arrive both ways.
3. **Storage foundation.** `sqlx`, `db.rs`, the migration set, URL resolution,
   and the conformance suite written against the *in-memory* stores. No SQL
   store exists yet; the suite is being proven, not used.
4. **The SQL stores.** Channel, secret and user-secret, share, state — each
   passing the suite on both engines as it lands. The `dashmap` registries move
   onto tables and `stores.rs` is deleted once nothing imports it.
5. **Supervision.** Actix `Supervisor` and restart recovery, once there is
   state to recover.
6. **Backend packaging changes.** `ServeDir` fallback behind `static_dir`,
   SIGTERM handling.
7. **Frontend change.** `VITE_API_SAME_ORIGIN` in `resolveApiBase()`.
8. **The image.** Dockerfile, `.dockerignore`, `VOLUME`, non-root user and
   entrypoint, healthcheck.
9. **Verification.** Proto drift test, image smoke and restart-survival CI job,
   README rewrite.

Phases 1 and 2 are each separable and each worth having alone — the first
unbreaks the Pages deploy and removes the sibling-checkout requirement, the
second makes the app configurable the way a containerised app should be —
whether or not anything after them ships.

Phases 3 through 5 are the bulk of the work and the bulk of the risk — they
rewrite every store in the backend. Nothing about packaging is blocked by
starting them, but the image cannot ship before they finish, because an image
whose whole selling point is surviving a restart must actually survive one.

## Risks and non-goals

The dependency switch is the risk. A local `lib-derec` ahead of the 0.0.3 tag
means the registry build is not the code that has been exercised so far, and
protocol-level divergence is more likely to surface as a failing e2e than as a
compile error. Phase 1 exists as its own checkpoint for that reason.

Vendored protos can drift silently if the drift test skips in CI rather than
running. The image smoke job does not catch it, because generated code that is
merely stale still compiles and still boots. Version parity makes this narrower
than it sounds — there is exactly one SDK version an image can be built
against — but the drift test is still the only thing standing between a bumped
dependency and protos nobody re-copied.

**The `DEREC_` rename is a silent breaking change.** `BASE_URL`, `PORT` and
`STATIC_DIR` stop being read, and an environment that still sets them gets the
built-in defaults with no error — a node quietly advertising
`http://localhost:5000` to peers that cannot reach it. The existing loopback
warning catches that particular case, but not the general one. Since there are
no aliases by choice, the mitigation is to detect the old unprefixed names at
boot and fail with a message naming the replacement, rather than letting a
developer discover it through behaviour. In-repo references move in the same
phase; `apps/web/e2e/lan.spec.ts:15` documents starting the backend with a
matching `BASE_URL`, and `config.example.toml` and the README carry the names
throughout.

**Persistence is now the critical path**, and it is a rewrite of every store in
the backend rather than an additive change. Two of its constraints fail quietly
if missed: a `u64` stored as `i64` is wrong only at the high end, and a column
that distinguishes a provisioned actor from a real one breaks the uniformity
rule without breaking any test that does not look for it. Both are called out
above because neither announces itself.

Migration portability degrades silently in one direction. Everything is
developed against SQLite, so a construct that SQLite accepts and Postgres
rejects will not be noticed until someone sets `TEST_DATABASE_URL` — and the
Postgres conformance run skips by default, exactly like the proto drift test.
Two soft-skipping guards is the pattern worth watching in this spec: each is
cheap to leave un-run, and CI should force at least one Postgres run rather than
relying on a developer to opt in.

SQLite over a bind mount can produce intermittent `database is locked` on macOS
and Windows. Documented and steered away from, but not prevented — a developer
who bind-mounts anyway gets a failure that does not name its cause.

Out of scope:

- **Postgres as a supported deployment.** The design leans all the way toward
  it — `AnyPool`, engine-agnostic migrations, a URL that already accepts
  `postgres://`, and a conformance suite that runs against it on request — so
  reaching it later is configuration and verification rather than redesign. What
  this spec does not do is exercise it in CI by default, document it as a
  deployment mode, or ship anything to run it against. SQLite is the supported
  engine.
- Publishing to a container registry (ghcr or otherwise). When it happens, the
  version-parity rule above is what decides the tag.
- **Multi-arch builds.** Development happens on arm64; an interop tester on
  amd64 would need `buildx`. Worth revisiting the moment someone actually needs
  to pull this rather than build it.
- A compose file. A single image with two published ports does not need one.
- Authentication. The debug surface is unauthenticated by design and the image
  is not meant to be reachable from outside the developer's machine.
