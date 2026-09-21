# Driving this app as an agent

This is the DeRec reference app: a local container that runs both sides of the
[DeRec protocol](https://github.com/derecalliance/protocol/blob/main/protocol.md)
so you can watch a flow happen and see where it breaks. It exists to be
inspected — there is no authentication, and exposing its internals is the
product, not an oversight.

Everything below is plain HTTP against `http://localhost:5000`. You do not need
to drive the browser.

## Start here

```
GET /debug/state    # everything that exists right now
GET /debug/events   # what happened, in order, and over which transport
```

Those two answer most questions. `GET /openapi.yaml` is not served — the spec
lives at `apps/backend/openapi.yaml` in the repository, and a test keeps it in
step with the router.

## The two things worth knowing before you read anything

**Every `u64` travels as a decimal string.** Channel ids and secret ids exceed
JavaScript's exact integer range, so they are never JSON numbers. Compare them
as strings; do not parse them into floats.

**What a node advertises is not what it can dial.** A helper's *transport mode*
(`http`, `grpc`, `both`) says what peers may dial it on. Every provisioned actor
can dial both regardless. Conflating the two produces wrong conclusions fast.

## Recipes

### "Is anything actually using gRPC?"

```
GET /debug/events
```

Each event carries `carrier`: `http`, `grpc`, or `grpc_via_relay`. That is what
*actually* carried the message, not what the peer advertises. If you expected
gRPC and see only `http`, the peer is advertising both and the dialer picked
HTTP — check its `transports` order in `/debug/state`.

`grpc_via_relay` means a browser owner's message that this backend dialled on
its behalf. A browser cannot speak gRPC (no HTTP/2 trailer access from
JavaScript), so every browser→gRPC message looks like this. Seeing zero of them
while a browser is paired with a gRPC-only helper means the relay is off or the
pairing never happened.

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
play.

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
