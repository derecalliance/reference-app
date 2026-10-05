# DeRec reference app — web

The browser half of the [DeRec reference app](../../README.md): a React + Vite
static front end that runs the DeRec protocol itself, through the
`@derec-alliance/web` WASM SDK. Pairing, sharing, verification, recovery and
replica groups all execute in the page; the backend only registers actors,
relays messages and hosts provisioned helpers. See
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) for how the two halves
divide the work.

## Running it

The backend must be running (`cargo run` in `apps/backend`, or the Docker
image). Then:

```
npm ci
npm run dev        # http://localhost:5173/reference-app/
npm run dev:lan    # the same, bound to the network for a phone or second machine
```

Requires Node 22 or newer.

## How it finds the backend

Resolved once at load, in this order (`src/apiBase.ts`):

| Setting | Effect |
| --- | --- |
| `VITE_API_URL` | An explicit backend address; wins over everything. |
| `VITE_API_SAME_ORIGIN` | Call whatever origin served the page. The Docker image builds with this, because there the backend serves the UI. |
| neither | Port 5000 of whatever host served the page — so a phone that loaded the page from your laptop's LAN address talks to the laptop. |

Both are build-time Vite variables (set them in the environment or a
`.env.local`). Communication is plain HTTP polling: each vault polls its
actor's mailbox at `GET /derec/{actor_id}/mailbox` and posts outbound protocol
messages to the peer's advertised transport URI, or through `POST /derec/relay`
when the peer is reachable only over gRPC.

State lives in `localStorage`, namespaced per vault, with a Web Lock per vault
so only one tab runs a given vault at a time.

## Scripts

| Script | Does |
| --- | --- |
| `npm run build` | Type-check and build to `dist/` (served under `/reference-app/`; the image rebuilds with `--base=/`). |
| `npm run typecheck` | `tsc -b` only. |
| `npm run lint` | ESLint. |
| `npm test` | Unit and component tests (Vitest, jsdom). |
| `npm run test:e2e` | Browser end-to-end suite (Playwright, Google Chrome); starts its own backend and dev server. |
| `npm run test:e2e:ui` / `:headed` / `:report` | The same suite interactively, in a visible browser, or the last report. |

The end-to-end suite, its ports and its constraints are described in the root
README under [End-to-end tests](../../README.md#end-to-end-tests).
