# Documentation

| Document | What it is |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the app is built and why: the actor registry, the shared helper pool, what the backend does and deliberately does not do, persistence on both sides, transports and the debug surfaces. **Start here.** |
| [`../README.md`](../README.md) | Running, configuring and testing the app. |
| [`../AGENTS.md`](../AGENTS.md) | Driving a running node over HTTP, for LLMs and coding agents. |
| [`../apps/backend/openapi.yaml`](../apps/backend/openapi.yaml) | The HTTP API, kept in step with the router by a test. |

## `superpowers/` is history, not documentation

`superpowers/specs/` and `superpowers/plans/` are dated design notes and
implementation plans, written before or during the work they describe. They
record why a decision was made at the time, which is useful when you are asking
"why is it like this?" — but they are never updated afterwards, and several
describe designs that were later changed or abandoned (a distinct replica actor
kind and one owner per browser context, among others).

When a plan or spec disagrees with the code or with the documents above, the
code and the documents above are right.
