# Node configuration

Every setting the node reads, as a `config.toml` key and a `DEREC_*` variable, with its default and meaning; where the file is read from; precedence; validation; and how to see what was loaded.

## Layers and precedence

Three layers, each overriding the one before:

1. built-in defaults;
2. a TOML config file;
3. environment variables (`DEREC_*`).

Anything settable in the file is settable from the environment, with a flat, prefixed name: `server.base_url` → `DEREC_BASE_URL`, `defaults.helper_transports.http` → `DEREC_HELPER_TRANSPORTS_HTTP`.

Under Docker Compose the environment itself is layered, highest first: `environment:` / `-e`, then `env_file:`, then a `.env` in the working directory (which fills only variables not already set), then the config file.

## Where the file is read from

| Run as | Default path |
| --- | --- |
| `cargo run` | `config.toml` in the working directory (`apps/backend/config.toml`) |
| Docker image | `/etc/derec/config.toml` |
| anywhere | `DEREC_CONFIG_PATH=<path>` |

No file at the default path is fine: the node runs on defaults and the environment. A path named by `DEREC_CONFIG_PATH` that does not exist aborts the boot. `examples/config.example.toml` documents every key inline.

## [server]: how the node runs

| Key | Variable | Default | Meaning |
| --- | --- | --- | --- |
| `base_url` | `DEREC_BASE_URL` | `http://localhost` | Scheme and host stamped into every endpoint handed to a peer. **No port, path, user name or query**: any of those aborts the boot. Use a LAN address to pair across devices or containers. |
| `port` | `DEREC_PORT` | `5000` | HTTP listener for the UI, the API and HTTP protocol traffic. Must differ from `grpc_port` while gRPC is on. |
| `public_port` | `DEREC_PUBLIC_PORT` | `port` | The HTTP port peers are told to dial, when something remaps it (`-p 8080:5000`). |
| `public_grpc_port` | `DEREC_PUBLIC_GRPC_PORT` | `grpc_port` | The gRPC port peers are told to dial. |
| `database_url` | `DEREC_DATABASE_URL` | `derec.db` in the working directory; `/var/lib/derec/derec.db` in the image | A bare path is SQLite (created if missing). Anything with `://` is passed through, for example `postgres://…`. `sqlite::memory:` is a scratch node that forgets everything, for throwaway sessions only. |
| `static_dir` | `DEREC_STATIC_DIR` | empty under `cargo run`; `/app/static` in the image | Built front end to serve. Empty serves no UI, which is right beside a Vite dev server. |
| `relay_allowed_hosts` | `DEREC_RELAY_ALLOWED_HOSTS` | empty | Other nodes the relay may dial, as comma-separated `host` or `host:port` entries, or `*` for any host. See [Transports](13-transports.md). |

## [defaults]: front-end defaults, plus three enforced keys

Most of these are **defaults for the front end**: served from `GET /api/v1/config`, prefilled into the setup wizard and Settings, and editable there per browser. The values a vault or helper actually runs with are whatever the front end sends. The three gRPC keys are the exception: **the node enforces them**.

| Key | Variable | Default | Meaning |
| --- | --- | --- | --- |
| `participant_count` | `DEREC_PARTICIPANT_COUNT` | `7` | Target pool size. At least 1. |
| `pre_paired_count` | `DEREC_PRE_PAIRED_COUNT` | 3, or `participant_count` if lower | Helpers to pre-pair at setup. |
| `min_participants` | `DEREC_MIN_PARTICIPANTS` | 3, or `participant_count` if lower | Threshold for new vaults. |
| `recommended_participants` | `DEREC_RECOMMENDED_PARTICIPANTS` | 5, kept between the minimum and the count | Warning level. |
| `protocol_timeout_secs` | `DEREC_PROTOCOL_TIMEOUT_SECS` | `300` | The single protocol timeout. Greater than 0. |
| `authentication_method` | `DEREC_AUTHENTICATION_METHOD` | `user` | `user` (channels linked by hand). `application` is reserved. |
| `unpair_ack` | `DEREC_UNPAIR_ACK` | `required` | `required` or `not_required`. |
| `auto_accept_unpair_requests` | `DEREC_AUTO_ACCEPT_UNPAIR_REQUESTS` | `true` | Accept incoming unpairs without a dialog. |
| `auto_accept_store_share_requests` | `DEREC_AUTO_ACCEPT_STORE_SHARE_REQUESTS` | `false` | A vault acting as helper stores shares without a dialog. |
| `auto_accept_verify_share_requests` | `DEREC_AUTO_ACCEPT_VERIFY_SHARE_REQUESTS` | `false` | A vault acting as helper answers verification without a dialog. |
| `grpc_enabled` | `DEREC_GRPC_ENABLED` | `true` | **Enforced.** Runs the gRPC listener; off means HTTP-only helpers. |
| `grpc_port` | `DEREC_GRPC_PORT` | `50051` | **Enforced.** gRPC listener port. |
| `grpc_relay_enabled` | `DEREC_GRPC_RELAY_ENABLED` | `true` | **Enforced.** Whether `POST /derec/relay` answers. |
| `helper_transports.http` | `DEREC_HELPER_TRANSPORTS_HTTP` | `participant_count` | Transport mix for provisioning. The three must sum to `participant_count`. |
| `helper_transports.grpc` | `DEREC_HELPER_TRANSPORTS_GRPC` | `0` | gRPC-only helpers. Needs `grpc_enabled`. |
| `helper_transports.both` | `DEREC_HELPER_TRANSPORTS_BOTH` | `0` | Helpers advertising both. Needs `grpc_enabled`. |

Leave the four derived counts and the transport mix unset unless you mean to pin them: unset, they adapt to `participant_count`; pinned, they are checked as written, so a later change of the count must change them too.

## Variables that are not settings

| Variable | Meaning |
| --- | --- |
| `DEREC_CONFIG_PATH` | Path of the config file. |
| `DEREC_DATA_DIR` | Image only: the directory the entrypoint hands to the runtime user (uid 10001). Set it when the database is on a bind mount other than `/var/lib/derec`. |
| `LAN_IP`, `DEREC_HOST_PORT`, `DEREC_HOST_GRPC_PORT` | Read by Compose and `./start.sh`, not by the node. See [Running the app](14-running-the-app.md). |
| `VITE_API_URL` | Front end only, at build or dev time: where the page finds the backend. Unset, port 5000 of the host that served the page. |

## How values are read

- An empty variable (`DEREC_PORT=`) counts as unset; the boot banner lists it as ignored.
- Values are trimmed. Numbers are range-checked. Booleans accept `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`, any case.
- A misspelled key in the file aborts the boot. An unknown `DEREC_*` variable only warns.
- Validation runs on the **merged** result, so a count overridden in the environment can conflict with a breakdown pinned in the file.
- `BASE_URL`, `PORT` and `STATIC_DIR` are no longer read; setting one without its `DEREC_` replacement aborts the boot.

A node that cannot run correctly refuses to start and says why: invalid configuration (naming the setting and where it came from), an unwritable data directory, or a port already in use.

## Seeing what was loaded

- The boot log prints every setting, its value and its source (`default`, `file`, or `env DEREC_…`).
- `GET /api/v1/debug/config` returns the same as JSON.
- **Settings → Node configuration** renders it, with a source chip per row. See [Settings](11-settings.md).

If you set something and nothing happened, the key marked `default` there is the answer. Configuration is read once at boot: restart the node after changing it.
