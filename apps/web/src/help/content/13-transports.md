# Transports

How messages travel: HTTP and polling, the gRPC listener, the relay a browser uses to reach gRPC peers, message size limits, and how to see which transport carried a message.

## HTTP and mailboxes

Every actor has an HTTP endpoint, `POST /derec/{actor_id}`.

- A message for a **hosted helper** is handed straight to its actor.
- A message for a **browser owner** is stored in its **mailbox** until the page drains it (`GET /derec/{actor_id}/mailbox`). Mailboxes are durable: undelivered messages survive a node restart and a claim.
- A browser posts its own outbound messages directly to the peer's advertised HTTP endpoint.

## The gRPC listener

| Setting | Default | Effect |
| --- | --- | --- |
| `grpc_enabled` (`DEREC_GRPC_ENABLED`) | `true` | Runs the gRPC listener. While it is off, helpers can only be HTTP, and asking for gRPC helpers is refused. |
| `grpc_port` (`DEREC_GRPC_PORT`) | `50051` | Where it listens. Must differ from `port`. |
| `public_grpc_port` (`DEREC_PUBLIC_GRPC_PORT`) | `grpc_port` | The port peers are told to dial. |

A gRPC helper advertises `grpc://<base_url host>:<public_grpc_port>`. gRPC has no path to name an actor, so inbound gRPC messages are routed by channel id through the `bound` and `pinned` tiers shown in [Inspect](12-inspect-and-console.md).

Each route also has a `side`. `endpoint` is the actor at one end of the pairing. `mirror` is a replica that holds a copy of its source's helper channel after hydrating, so the same channel id can have several claimants. Delivery prefers a bound endpoint, then a bound mirror, then a pin. Over gRPC it sets aside claimants that serve no gRPC endpoint, and it refuses a genuine tie rather than guess, which shows as a `refused` event.

What a helper **advertises** (`http`, `grpc`, `both`) says how peers may reach it. Every hosted helper can **send** over both protocols regardless.

## The relay

A browser cannot speak gRPC (JavaScript has no access to HTTP/2 trailers), so `POST /derec/relay` asks the node to dial an endpoint on a browser owner's behalf. `grpc_relay_enabled` (`DEREC_GRPC_RELAY_ENABLED`, default `true`) turns it on.

The relay is not an open proxy. It delivers only to:

- **this node**, under any address it answers to now or has advertised before. Delivered in-process, without a dial;
- an endpoint some actor on this node advertises;
- **another node**, only if its host or `host:port` is listed in `relay_allowed_hosts` (`DEREC_RELAY_ALLOWED_HOSTS`), comma-separated, for example `192.168.0.30:50051,node-b`. `*` allows any host, for a trusted LAN only; the node warns at boot while it is set. Empty by default.

| Refusal | Cause |
| --- | --- |
| `403` *relay target … is not this node and not an allowed host* | Another node, not in `relay_allowed_hosts`. Add it on **this** node. |
| `409` *relay target … is this node's gRPC address, but gRPC is disabled here* | `grpc_enabled = false`. |
| `503` *relay disabled on this node* | `grpc_relay_enabled = false`. |

Every refusal is also an event in `/api/v1/debug/events`, with the reason.

With the relay off, a browser has no way to reach a gRPC-only helper. The app disables **Pair** for such a helper, with the reason. That is deliberate: it is the observable consequence of a browser's transport limits.

A message can cross transports at the relay: pairing with a gRPC-only helper sends the request over gRPC through the relay, and the helper's reply comes back over HTTP to the owner's mailbox.

## Message size

| Limit | Value |
| --- | --- |
| One DeRec message, on every transport | 4 MiB |
| Relay request body (the message is base64url inside JSON) | about 5.4 MiB |
| Other JSON routes | 2 MiB |
| A browser owner's mailbox | 1000 messages or 16 MiB of message bytes |

Past the mailbox cap a new message is refused (HTTP `503`, gRPC `RESOURCE_EXHAUSTED`, *the recipient's mailbox is full; it has not polled for a while*) and nothing already queued is dropped.

## Timeouts

Calls from the node to peers time out after 5 s to connect, 15 s per HTTP request and 10 s per gRPC call, so one unreachable peer cannot hold a helper up.

## Which transport carried a message

- The **transport badge** on a channel row says what the peer advertises: `HTTPS`, `GRPC` or `GRPC+HTTPS`. A trailing `~` means it was derived from a single known address and may be incomplete.
- The **Console** and `/api/v1/debug/events` say what actually carried each message: `carrier` is `http`, `grpc`, `grpc_via_relay` or `http_via_relay`. Seeing no `grpc_via_relay` while a browser is paired with a gRPC-only helper means the relay is off or the pairing never happened.

## Plaintext endpoints

The protocol refuses `http://` and `grpc://` endpoints by default. Both halves of the app opt in when their own endpoint is plaintext, so local development works; served over `https://`, the guardrail comes back on by itself.
