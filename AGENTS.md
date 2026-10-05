# Driving this app as an agent

This is the DeRec reference app: a local container that runs both sides of the
[DeRec protocol](https://github.com/derecalliance/protocol/blob/main/protocol.md)
so you can watch a flow happen and see where it breaks. It exists to be
inspected — there is no authentication, and exposing its internals is the
product, not an oversight.

Everything below is plain HTTP against `http://localhost:5000` (gRPC, when
enabled, listens on 50051). You do not need to drive the browser. If the node is
published on other host ports, the ports actors *advertise* to peers are
`public_port` / `public_grpc_port` (`GET /debug/config`), not the ones the
process listens on.

Run it only on a trusted machine or LAN: anyone who can reach the port can read
every actor's channel keys from `GET /actors` and delete the shared helpers.

## Start here

```
GET /debug/state    # everything that exists right now
GET /debug/events   # what happened, in order, and over which transport
```

Those two answer most questions. `GET /openapi.yaml` is not served — the spec
lives at `apps/backend/openapi.yaml` in the repository, and a test keeps it in
step with the router.

## The things worth knowing before you read anything

**Every `u64` travels as a decimal string.** Channel ids and secret ids exceed
JavaScript's exact integer range, so they are never JSON numbers. Compare them
as strings; do not parse them into floats.

**Every API error has one shape:** a non-2xx status with a JSON body
`{"error": "<message>"}`. Read the status for the category and `error` for the
detail. That includes unknown paths (404) and wrong methods (405).

**A browser actor's mailbox is durable.** Undelivered messages are stored, so
they survive a restart and a claim (`POST /owners` with `claim_actor_id`). A
mailbox holds at most 1000 messages / 16 MiB of message bytes (as posted, not
the base64 stored); past that, delivery is refused with 503 (gRPC
`RESOURCE_EXHAUSTED`) and nothing already queued is dropped. One message may be
at most 4 MiB on every transport (gRPC, `POST /derec/{id}`, the relay).
Polling an unknown actor is 404, a provisioned actor 400.

**Names are 1–64 characters**, trimmed, no control characters — owner names,
helper names and names offered to `/helpers/ensure` alike. Helper names are
also unique (trimmed, case-insensitive): `POST /helpers` with a taken name is
409, and `/helpers/ensure` skips offered names the pool already has. An owner
is renamed with `PATCH /owners/{id}` `{"name": "..."}`.

**A browser owner's `last_polled_at`** on `GET /actors` is when it last drained
its mailbox (RFC 3339), or `null` if it has not since the node started — it is
held in memory and resets on restart. A stale value means the tab is closed or
stuck, so messages to it are queueing, not being read.

**What a node advertises is not what it can dial.** A helper's *transport mode*
(`http`, `grpc`, `both`) says what peers may dial it on. Every provisioned actor
can dial both regardless. Conflating the two produces wrong conclusions fast.

## Recipes

### "Is anything actually using gRPC?"

```
GET /debug/events
```

Each event carries `carrier`: `http`, `grpc`, `grpc_via_relay` or
`http_via_relay`. That is what *actually* carried the message, not what the peer
advertises. If you expected gRPC and see only `http`, the peer is advertising
both and the dialer picked HTTP — check its `transports` order in
`/debug/state`.

The `_via_relay` carriers mean a browser owner's message that this backend
dialled on its behalf through `POST /derec/relay`, over gRPC or HTTP
respectively. A browser cannot speak gRPC (no HTTP/2 trailer access from
JavaScript), so every browser→gRPC message is `grpc_via_relay`. Seeing zero of
them while a browser is paired with a gRPC-only helper means the relay is off or
the pairing never happened.

Relay refusals are events too (`outcome: "refused"`, with the reason in
`detail`), attributed to the requesting owner when the request sent its
`actor_id`. A `403` means the target is another node not listed in
`relay_allowed_hosts` (`DEREC_RELAY_ALLOWED_HOSTS`) — the relay reaches other
nodes only when the operator names them. A relay target that is this node,
under its current address or any it advertised before
(`advertised_addresses` in `/debug/state`), is delivered in-process; its detail
says "without a dial".

### "A message isn't arriving"

Look at `routes` in `/debug/state`. Each entry has a `tier`:

- `bound` — the pairing completed; this is the steady state.
- `pinned` — a contact was minted but the handshake never finished. A channel
  stuck here is the single most common cause of "it paired and then nothing".

A channel in **neither** tier cannot be routed over gRPC at all, and an inbound
gRPC message for it is refused rather than guessed at. You will see that as an
event with `outcome: "refused"` and no `actor_id`.

### "Which helper is which?"

```
GET /debug/state → actors[]
```

`transport_mode` is derived from the endpoints the actor actually advertises,
not stored separately, so it cannot disagree with `transports`. `disabled: true`
means the actor is simulating offline — it answers normally and discards
everything, which is deliberate and looks identical to a healthy peer from the
outside.

`instance_secret_ids` lists the protocol instances an actor runs: its own, plus
one per owner it mirrors as a replica. More than one means replica mode is in
play. Replica instances, and the routes of contacts minted but not yet paired
against (within their one-hour lifetime), are rebuilt from the database at
boot, so a restart does not strand either.

### "Set up a pool with a specific transport mix"

```
POST /helpers/ensure
{ "total": 3, "transports": { "http": 1, "grpc": 1, "both": 1 } }
```

This states a **target**, not a quantity to add. Helpers belong to the server,
so asking for fewer than exist removes nothing — another owner may be paired
with one. Only the per-mode shortfall is created. `transports` must sum to
`total`, and asking for gRPC helpers while `grpc_enabled` is false is refused
rather than silently downgraded.

### "Simulate an unreachable peer"

```
POST /helpers/{id}/toggle-status   { "disabled": true }
```

Messages to it are discarded, not queued. In the event log this shows as
`outcome: "dropped"` — distinct from `refused`, which means there was nowhere
to put it.

### "Poll for new activity"

`/debug/events` returns `latest_seq`. Pass it back as `after` to get only what
has happened since:

```
GET /debug/events?after=142
```

The log is a bounded window of 2000 events. `dropped` being non-zero means the
oldest entries are gone — that is how you tell truncation from silence.

## What this backend does not do

It holds **no protocol logic**. Pairing, sharing, verification and recovery are
all executed by the DeRec SDK — in the browser for owners, inside a provisioned
actor for helpers. This process is an actor registry, a message relay, and the
debug surface above. If you are looking for why a *protocol* decision was made,
it is in the library, not here.

## Driving the UI instead

The UI is for humans, but it is drivable: the end-to-end suite in
`apps/web/e2e` operates every flow through real Chrome and is the best worked
reference for how the screens fit together. `apps/web/e2e/app.ts` holds the
helpers. Prefer the HTTP surface above unless you specifically need to exercise
the browser-side SDK.

The browser is multi-vault: each vault is one owner actor (`role: owner` in
`/debug/state`), a tab runs every vault its browser holds, and a Web Lock keeps
any one vault to a single tab. Screens are hash routes — `#/` (vault list),
`#/new`, `#/new/claim`, `#/vault/{owner actor id}`.
