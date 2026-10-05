# Examples

Worked configuration files for the DeRec reference app. None of these is read
where it sits — each is a template to copy, with every key documented inline.

| File | Copy it to | For |
| --- | --- | --- |
| `config.example.toml` | `apps/backend/config.toml` for `cargo run`; mount at `/etc/derec/config.toml` in the image | the TOML config file |
| `.env.example` | `.env` (repo root for compose; `apps/backend/` for `cargo run`) | environment variables |
| `docker-compose.example.yaml` | `compose.yaml` (repo root) | running it in Docker |

The paths inside `docker-compose.example.yaml` are relative to the **repo
root**, so copy it up rather than running it in place — or pass
`--project-directory .` if you would rather leave it here. It runs on a fresh
checkout as-is: the `.env` and the config file are both optional.

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
