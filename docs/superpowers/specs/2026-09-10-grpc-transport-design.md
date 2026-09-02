# gRPC transport

Add gRPC alongside HTTPS as a transport the reference app both serves and
dials, so the DeRec library's two-transport support can be exercised against
a real second protocol rather than described.

The goal is coverage, not production readiness. Three helper configurations —
HTTP only, gRPC only, both — pair, protect, verify and unpair against a browser
owner, and messages cross between the two transports in both directions.

The three exist to cover three distinct library behaviours, not three
transports: a peer offering only what we speak, a peer offering only what we
must reach some other way, and a peer offering a *choice* the library
deliberately declines to make for us.

## What the library gives us, and what it does not

`derec-library` never opens a socket. It hands finished envelope bytes to a
`DeRecTransport` the application supplies and expects inbound bytes back
through `DeRecProtocol::process`. Sockets, retries, TLS and addressing all
belong here.

`derec-proto` ships the service contract and nothing else:

```protobuf
service DeRecTransport {
  rpc Send(DeRecMessage) returns (google.protobuf.Empty);
}
```

Delivery is **push-only**. `Send` resolves to `Empty`, so a protocol response
never rides back on the call — the peer answers by opening its own `Send`
against the endpoint we advertised. Every participant that serves gRPC must
therefore also listen.

`smoke-tests/grpc` in the library repo is a working implementation of this seam
and is the reference for the client side here.

### Two independent axes

A node's **advertised endpoints** and the transports its `DeRecTransport` can
**dial** are separate concerns, and conflating them is the easiest mistake to
make in this design.

- "This helper accepts only gRPC" is a statement about what it advertises.
- It can still *send* over HTTP, because its transport dials whatever the peer
  offered.

Every provisioned actor therefore gets a transport that speaks both. What
varies per helper is only the endpoint set it publishes.

## Constraint: the browser cannot speak gRPC

There is no HTTP/2 trailer access from JavaScript, and grpc-web requires a
proxy. Every owner in this app is a browser tab, so a browser owner handed
`[grpc://…]` has nothing it can dial.

The backend already terminates transport for every actor — a browser owner's
own endpoint is `http://localhost:5000/derec/<uuid>`, and it receives by
draining a mailbox rather than by listening. Extending that to gRPC *egress* is
a small step, not a new architectural idea: the backend gains a relay route,
the browser posts an envelope plus the target URI, and the backend performs the
gRPC dial. The protocol does not care how delivery happened, only that it did.

The failure this hides is worth keeping visible, so the relay is switchable and
one test turns it off to observe what the library does when no advertised
endpoint is usable.

## Addressing: one port, routed by `channel_id`

Over HTTP the actor id lives in the path (`/derec/<uuid>`). gRPC has no
equivalent: tonic builds the request URI from the endpoint's authority plus the
fixed method path `/org.derecalliance.derec.protobuf.DeRecTransport/Send`, so a
path in `grpc://host:port/<uuid>` is dropped.

One listener serves the whole process and resolves the actor from the cleartext
`channel_id` on the `DeRecMessage` envelope — the same field `envelope.rs`
already reads to route a message to the right protocol *instance* within an
actor.

The alternative, a listener per gRPC-serving helper, was rejected: it consumes
a port per helper for an addressing problem the envelope already answers.

### The cold-start problem, and the shape that solves it

A channel-id index is only useful if it knows about a channel before the first
message arrives on it. `InstanceMap` already solves exactly this problem one
level down (channel → instance) with two tiers, and the router copies it:

| tier | written when | covers |
| --- | --- | --- |
| **bound** | `PairingCompleted`, and on teardown removal | the long-term channel id both sides rotated to |
| **pinned** | `POST /actors/:id/contact` mints a contact | the transient id that the *first* inbound `PairRequest` carries, which no channel store has yet seen |

A pin is dropped when the long-term id binds. `state.helper_channels` cannot
serve this purpose: it is written only on `PairingCompleted` and only for
helpers, so it misses the transient id entirely.

An unrecognised channel is refused, never guessed — the rule `InstanceMap`
already states. Guessing would hand a peer's message to an actor that does not
own it.

This index exists **solely** for gRPC ingress. HTTP keeps the actor in its path
and never consults it.

## Components

### Backend

**`src/grpc.rs` — ingress.** One tonic listener on `grpc_port`, started at boot
alongside the Axum server when `grpc_enabled`. Implements `Send`: resolve the
actor through the router, then dispatch into the *same* inbox path
`routes/derec.rs::deliver_message` uses — `ActorInbox::Browser(tx)` or
`ActorInbox::Provisioned(addr)`. Go-Offline (`disabled_helpers`) is honoured
identically, so a suspended helper drops gRPC traffic exactly as it drops HTTP.

`build.rs` follows the library's smoke test: `tonic_prost_build` with
`.extern_path(".org.derecalliance.derec.protobuf", "::derec_proto")`, so the
generated service speaks the exact `DeRecMessage` the library hands us and
nothing is re-encoded across a duplicate definition.

**`src/routing.rs` — the channel router.** The two-tier index above, held in
`AppState`. Pure data structure; no protocol logic.

**`src/stores.rs` — egress.** `GrpcTransport` modelled on the library's smoke
test (`grpc://` → `http://` for the dial), and a `CompositeTransport` that walks
the peer's endpoints in the peer's own order, dispatches each by its `protocol`
discriminant, and succeeds on the first delivery. Replaces `HttpTransport` as
the actor transport. This makes the failover branch written during the 0.0.3
migration reachable for the first time.

**Advertised endpoints.** `ProtocolConfig.transport_uri: String` becomes
`own_transports: Vec<Transport>`; `models::TransportProtocol` gains `Grpc`.
`actor.rs` already calls `with_own_transports`, so it takes the list unchanged.

**`POST /derec/relay` — the browser gateway.** Body
`{ "uri": "grpc://…", "data": "<base64url>" }`, matching how `MailboxMessage`
already carries wire bytes through JSON. The backend dials whatever the URI
names and answers `202` on delivery.

It relays **only to an endpoint currently advertised by a registered actor** —
without that check it is an open SSRF proxy, and this app is run on laptops on
shared networks. An unknown endpoint is `403`.

Governed by `grpc_relay_enabled`; when off, the route answers `503` and the
browser's transport reports the endpoint as undialable.

### Actor DTO

`Actor` gains `transports: Vec<Transport>` and **keeps** `transport` as the
first entry. Four front-end call sites consume `actor.transport.uri` as "an
address for this actor" (the `actorByUri` maps in `OwnerPage` and
`replicaFlows`, and `PeerActorCandidate`); the singular field spares them churn
for no loss of information. This mirrors the deprecated-singular shape the
library itself uses on the wire, and can be dropped later in one pass.

### Provisioning

A new `TransportMode` names what one helper serves:

```rust
pub enum TransportMode { Http, Grpc, Both }
```

The two provisioning requests take it differently, because they mean different
things. `AddHelperRequest` mints exactly one helper, so it carries a single
optional `transport_mode`. `EnsureHelpersRequest` states a pool target, so it
carries a breakdown. The mode does **not** go on the shared
`ProtocolSettingsRequest`: that struct is flattened into both, and a single mode
is meaningless for a pool target.

`EnsureHelpersRequest` is the wrinkle. It states a **target for a shared pool**,
not a quantity to create, so a breakdown must be a target *composition*:

```json
{ "total": 3, "transports": { "http": 1, "grpc": 1, "both": 1 } }
```

The server counts existing helpers **per mode** and creates only the per-mode
shortfall, under the single registry lock that already prevents two browser
contexts from each filling an empty pool. Asking for fewer of a mode than exist
removes nothing — the existing rule, now partitioned. The breakdown must sum to
`total`; a mismatch is a validation error rather than a silent reinterpretation.
Omitting `transports` entirely falls back to the operator default mix.

### Operator configuration

Four new keys, following the existing rules — every key optional, an
unrecognised key a boot error:

```toml
# Prefills the wizard's transport breakdown. Must sum to `participant_count`.
[helper_transports]
http = 7
grpc = 0
both = 0

# The gRPC listener. Set `grpc_enabled = false` to run HTTP-only.
grpc_enabled = true
grpc_port = 50051

# Whether the backend will dial gRPC on a browser owner's behalf. Turning this
# off is what makes a gRPC-only helper unreachable from a browser, which is a
# behaviour worth being able to observe deliberately.
grpc_relay_enabled = true
```

`helper_transports` is a **wizard prefill**, like every other key in this file —
"the settings a node actually runs with are whatever the front end sends".
It is therefore not a backend fallback, and there is no question of rescaling
it when a request asks for a different `total`. A provisioning request that
omits the mode entirely gets **HTTP**, which is exactly today's behaviour: an
existing deployment that upgrades and changes nothing gets the pool it had.
gRPC is opted into, per setup from the wizard or per deployment from this file.

`grpc_enabled = false` and a request asking for `grpc` or `both` helpers is a
validation error, not a silent downgrade to HTTP — a helper advertising an
endpoint nothing is listening on would pair successfully and then black-hole
every reply.

### What the `Both` helper is for

Not for exercising gRPC — the gRPC-only helpers do that, and they do it whatever
a two-endpoint peer happens to advertise. `Both` exists to prove the library
handles a peer offering **more than one** endpoint:

- both survive `admit_peer_endpoints` and are recorded on the channel record,
  in the peer's own order;
- both survive a restart, so failover still works after one;
- the library hands the whole list to `DeRecTransport::send` and takes no view
  on which to dial.

That last point is the design the library committed to in 0.0.3: it filters,
the application chooses. **Which endpoint this app picks is an app preference
and carries no protocol meaning**, so the order is arbitrary and fixed rather
than argued for: a `Both` helper advertises `[grpc, http]`, and
`CompositeTransport` walks the list as given.

The consequence worth testing is not which one wins but that the *other* one is
still there when the first fails — see the failover assertions below.

### Frontend

`makeTransport` stops filtering to HTTPS. HTTP endpoints post directly as
today; gRPC endpoints go through the relay; the existing in-order failover
wraps both. With the relay disabled, a gRPC-only peer yields no dialable
endpoint and the transport rejects — the failure the matrix wants to observe.

The setup wizard gains a transport breakdown beneath the participant counter,
constrained to sum to it. `GET /config` carries the default mix and the relay
flag.

## Testing

**Backend unit** — router: pin at mint, rebind on `PairingCompleted`, unpin the
transient id, refuse an unknown channel. `CompositeTransport`: dispatch by
discriminant, in-order failover, error only when every endpoint failed.

**Backend integration** — a gRPC `Send` reaches the right actor's inbox; a
`Send` on an unknown channel is refused; a disabled helper drops it; the relay
refuses a URI belonging to no registered actor.

**The multi-endpoint peer** — the assertions the `Both` helper exists for, read
straight off the channel store the way `helper_auto_confirm.rs` already reads
it:

- after pairing with a `Both` helper, the peer's channel record carries **two**
  `transports`, in the order the helper advertised — proving neither was
  dropped by `admit_peer_endpoints` nor collapsed by the singular-field
  compatibility path;
- with the first endpoint unreachable, delivery still succeeds on the second,
  and the record is unchanged — failover is the transport's business and must
  not rewrite what the peer advertised.

**E2E matrix** — for each of http-only, grpc-only and both: pair, protect,
verify. Plus relay-off against a grpc-only helper, asserting the browser
surfaces the no-usable-endpoint failure rather than hanging.

**Cross-transport** is not a separate case but a property of the matrix: a
browser owner is always HTTP, so pairing with a grpc-only helper *is* the
HTTP↔gRPC test — request out over gRPC via the relay, response back over HTTP
to the owner's mailbox.

## Implementation order

Each step leaves the app working and tested, so the sequence can be stopped at
any point:

1. **Ingress + router** — the listener and the channel index, with the router's
   unit tests. Nothing advertises gRPC yet, so behaviour is unchanged.
2. **Egress** — `GrpcTransport` and `CompositeTransport`. Still nothing
   advertises gRPC; the composite is exercised by unit tests only.
3. **Advertised endpoints + provisioning** — `own_transports`, `TransportMode`,
   the per-mode pool shortfall, the actor DTO, the config keys. Provisioned
   helpers can now serve gRPC, reachable from other provisioned actors.
4. **Relay + front end** — the gateway route, `makeTransport`, the wizard
   breakdown. Browser owners can now reach gRPC-only helpers.
5. **E2E matrix** — the four specs.

Steps 1–3 are backend-only and independently verifiable; step 4 is the first
that changes what a user sees.

## Risks and non-goals

- **`tonic` is a substantial new backend dependency.** Accepted: there is no
  way to serve gRPC without one, and the library deliberately ships no
  transport.
- **`grpcs://` is out of scope.** Default `tonic` has no TLS backend and cannot
  dial `https://`. We stay on plaintext `grpc://` loopback under the existing
  `with_unsafe_connection` posture — the same footing `http://` is already on
  here, and the guardrail returns by itself when served over TLS.
- **No grpc-web.** The relay is the browser's path to gRPC; adding a proxy
  contradicts this repo's minimal-infrastructure goal.
- **The relay is not a general proxy.** It dials only endpoints advertised by
  registered actors.
