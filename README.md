# DeRec Reference App

A minimal reference implementation of the [DeRec protocol](https://github.com/derecalliance/protocol/blob/main/protocol.md), providing both an Owner and a Helper for interoperability testing.

- `apps/web` — React + Vite static frontend. Executes DeRec flows (pairing, sharing, verification, recovery, replicas) client-side and polls the backend for messages.
- `apps/backend` — Rust + Axum thin backend. Actor registry and message relay only; no protocol logic lives here.

See `CLAUDE.md` for the full architecture and design principles.

## Running it

The backend serves a single local node. Every browser context that opens the app
registers itself as an owner actor against it — a second tab, an incognito
window or another machine on the network is simply another owner. There is no
grouping above that: everything the server knows lives in one actor registry.

### Plaintext endpoints in local development

Both halves consume the SDK from the registries — `@derec-alliance/web` from
npm, `derec-library` from crates.io — so there is nothing to build from source.
The npm version is **pinned**, because the package publishes under the `alpha`
dist-tag while `latest` still points at an older release.

The protocol refuses plaintext `http://` endpoints by default. Loopback is
exempt for the endpoint a node configures for *itself*, but **not** for one a
peer supplies — and every peer here is `http://localhost:5000/derec/...`, so
pairing fails without opting in. Both apps do, and both derive it rather than
hardcoding it:

```ts
.withUnsafeHttp(!ownTransportUri.startsWith('https://'))
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
- **The backend is shared state.** One actor registry and one participant pool
  serve every test, so the suite runs single-worker and serially. A test should
  treat the participant pool as something that may already exist.

The specs cover the setup wizard, all three contact modes (including the
`NoKeys` fingerprint gate and its refusal path), replica groups (pairing,
mirroring, sync check, eviction), the secret lifecycle (protect, verify,
discover), recovery (reconstruction and `restore`), and unpairing.

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
BASE_URL=http://192.168.0.28 cargo run

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

`BASE_URL` is the one that must be set. It is not merely where the backend
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

### Configuring defaults

The setup wizard's starting values come from a TOML file the backend reads once
at boot, so a developer running the image does not have to retype them on every
run. Copy `apps/backend/config.example.toml` to `config.toml` beside the binary,
or mount it anywhere and point `DEREC_CONFIG_PATH` at it:

```
docker run -v ./my-config.toml:/etc/derec/config.toml \
           -e DEREC_CONFIG_PATH=/etc/derec/config.toml ...
```

Every key is optional — omit one and its built-in default applies. These are
defaults only: the wizard stays editable, and the settings a node actually runs
with are whatever the front end sends when it provisions actors. A file that
cannot be read, parsed or validated aborts the boot rather than silently falling
back, so a broken config surfaces immediately. No file at all is fine and uses
the built-in values.

## Replicas

A replica is a second device belonging to the same owner, kept in sync so it can take over if the primary device is lost. Pairing is unidirectional: the existing device is the `ReplicaSource` (it holds the secret), the new device is the `ReplicaDestination` (it receives a mirrored copy). Each side needs a stable per-device replica id, set when the protocol instance is built; the destination's id survives adoption deliberately — it identifies the device, not the vault it holds.

### Setting one up

The app currently supports one user per browser context, so a replica needs a **second** browser context — an incognito/private window, a different browser profile, or a different browser entirely. This is a limitation of the frontend, not of the protocol. Open the app in that second context and run **Set up** to register it as its own owner actor on the same backend, then pair it from the primary device's `ReplicaSource` side.

### Fingerprint confirmation (required before syncing)

After the pairing handshake, the replica channel sits in `Pending` — it cannot receive anything yet. Each side independently derives the same `XXXX-XXXX-XXXX-XXXX` code from the shared key. Compare the two codes out of band (read them to each other, screenshot, etc.), then confirm on each side separately.

Only once **both** sides have confirmed does the channel move to `Paired`. This gate is enforced by the protocol library itself — it selects share targets from its own `Paired` channel table — not by app code, so there is no client-side bypass.

### Adoption (destructive — erases the destination's vault)

The app holds one vault per user. The first time a `ReplicaDestination` receives the source's mirrored secret, adopting it **wipes that device's existing vault** and replaces it with the source owner's — secrets, helper roster, everything. The destination keeps adopting the *source's* secret id (its own replica id is untouched, as noted above), and afterwards enables auto reply-to so helpers — whose stored endpoint still points at the source — route their responses to the new device instead.

Because this is destructive, adoption sits behind a confirmation dialog whose default action is **Cancel** (autofocused, and what Escape/backdrop-click resolve to). Confirming requires a deliberate click on a separate, clearly-marked destructive action. Cancelling discards the offered payload and destroys nothing — the source's next sync re-offers it.

### Status

Exercised end to end and covered by `apps/web/e2e/replicas.spec.ts`: pairing
behind the fingerprint gate, a three-member group, mirroring with per-member
acknowledgement, sync check, and eviction.

That coverage uses **provisioned** replicas — backend fixtures — rather than a
second browser context, because one context can then drive both ends of the
fingerprint comparison. The protocol path is identical, but the browser-to-
browser variant is still only manually verified, and adoption (the destructive
step above) has no automated coverage at all: it is gated on a human confirming
a dialog that erases the device's vault.
