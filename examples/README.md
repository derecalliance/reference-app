# Examples

Worked configuration files for the DeRec reference app. None of these is read
where it sits — each is a template to copy, with every key documented inline.

| File | Copy it to | For |
| --- | --- | --- |
| `config.example.toml` | `apps/backend/config.toml` | the TOML config file |
| `.env.example` | `.env` (repo root, or beside the binary) | environment variables |
| `docker-compose.example.yaml` | `compose.yaml` (repo root) | running it in Docker |

The paths inside `docker-compose.example.yaml` are relative to the **repo
root**, so copy it up rather than running it in place — or pass
`--project-directory .` if you would rather leave it here.

Configuration is layered: the TOML file underneath, environment variables on
top. Anything settable one way is settable the other, and validation runs on the
merged result — so a value overridden in `.env` has to stay consistent with what
the file still says. The [main README](../README.md#configuring-it) has the
precedence table and the full key-to-variable mapping.

The node prints every setting it resolved, and where each value came from, at
boot; the same data is served as JSON from `GET /debug/config`.
