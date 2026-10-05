# Examples

Worked configuration files for the DeRec reference app, every key documented
inline.

| File | Use it | For |
| --- | --- | --- |
| `compose.sqlite.yaml` | in place: `docker compose -f examples/compose.sqlite.yaml up -d` — or `docker compose up` at the repo root, whose `compose.yaml` includes it | running it in Docker on SQLite (the default) |
| `compose.postgres.yaml` | in place: `docker compose -f examples/compose.postgres.yaml up -d` | running it in Docker on PostgreSQL |
| `config.example.toml` | copy to `apps/backend/config.toml` for `cargo run`; mount at `/etc/derec/config.toml` in the image | the TOML config file |
| `.env.example` | copy to `.env` (repo root for compose; `apps/backend/` for `cargo run`) | environment variables |

The compose files run where they sit: their paths are relative to this
directory, and both work on a fresh checkout with no `.env` and no config file.
They share the project name `derec`, so one replaces the other rather than
running beside it. [`../start.sh`](../start.sh) runs either one, picks free
ports, and waits until the node is healthy.

A repo-root `.env` is read by `docker compose up` at the root and by
`./start.sh`. When running an example with `-f` directly, compose looks for
`.env` next to the file instead, so pass `--env-file .env` to use the root one.

Configuration is layered, lowest first: built-in defaults, then the TOML file,
then environment variables. Anything settable one way is settable the other,
and validation runs on the merged result. The participant thresholds and the
transport breakdown adapt to `participant_count` unless you pin them, which is
why the example leaves them commented out. The [main README](../README.md#configuring-it)
has the precedence table and the full key-to-variable mapping.

The node prints every setting it resolved, and where each value came from, at
boot; the same data is served as JSON from `GET /debug/config`. A configuration
it cannot use stops the boot with a message naming the file or variable at
fault.
