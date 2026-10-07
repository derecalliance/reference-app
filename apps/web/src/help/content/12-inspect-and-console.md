# Inspect and Console

The two places that show what is happening: the Inspect section (the node's own view of itself) and the Console panel (what happened, in order). Both read the same data the debug endpoints return.

## Inspect

**Inspect** in the left navigation renders `GET /api/v1/debug/state` verbatim, refreshed every 2 seconds.

| Control | Effect |
| --- | --- |
| **Live** | Untick to freeze the view. |
| **Refresh** | Read it once now. |
| **Copy JSON** | Copies the whole state. |

**Server**

- **Base URL**: the address the node stamps into every endpoint. A `localhost` value carries a note: peers on another device cannot reach it, so set `DEREC_BASE_URL` to a LAN address (and `DEREC_PUBLIC_PORT` / `DEREC_PUBLIC_GRPC_PORT` when ports are remapped).
- **gRPC**: the listener's address and whether the relay is enabled, or *disabled — helpers cannot advertise a gRPC endpoint*.

**Actors**: every actor on the node.

| Column | Shows |
| --- | --- |
| **Name** | With a *browser* flag for vaults and an *offline* flag for helpers taken offline. |
| **Role** | `owner` or `helper`. |
| **Transport** | `http`, `grpc` or `both`, derived from the endpoints it advertises. |
| **Endpoints** | Every URI it advertises. |
| **Instances** | Protocol instances it runs. More than one means it mirrors another owner's vault as a replica. |

**Channel routes**: how an inbound gRPC message finds its actor. gRPC carries no actor id in its URI, so the channel id on the envelope is the key.

- `bound`: the pairing completed. The steady state.
- `pinned`: a contact was minted and the handshake never finished. A channel stuck here is the most common cause of "it paired and then nothing".

A channel in neither tier cannot be routed over gRPC; its messages are refused. The footer says how many events have fallen out of the retained window.

## Console

The **Console** bar at the bottom of every page expands into a log, newest first. It holds two kinds of entry:

- this page's own protocol steps, from every vault it runs;
- the node's message deliveries from `GET /api/v1/debug/events`, polled every 2 seconds, with role *Server* and flow *Transport*.

Each row shows a role badge (*Owner*, *Participant*, *Server*), a flow badge (*Setup*, *Pairing*, *Unpairing*, *Sharing*, *Verification*, *Discovery*, *Recovery*, *Protocol*, *Transport*), the step (for example `start_pairing`, `ShareRejected`, `→ HTTP`, `← GRPC`), a description and the time.

| Control | Effect |
| --- | --- |
| **⎘** on a row | Copy that entry as JSON. |
| **↗** on a row | Open its payload and response. |
| **Show entries for** | *All vaults*, one vault, or *Node only* (the server's entries). Shown once a vault has logged. |
| **Copy all** / **Copy shown (N)** | Copy the entries the filter shows as JSON, oldest first. |
| **Download** / **Download shown (N)** | The same, as a `derec-console-<timestamp>.json` file. |
| **Clear** | Empty the log in this page. |

Copying needs clipboard access, which a plain-http LAN origin may block; use Download there. The log lives only in this page and is lost on reload.

## Over HTTP

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1/debug/state` | Actors, endpoints, routes, protocol instances, `advertised_addresses`. |
| `GET /api/v1/debug/events?after=<seq>` | Message deliveries since `seq`, with `carrier`, `outcome` and `detail`, plus `latest_seq` to poll with. A bounded window of 2000 events; a non-zero `dropped` means older ones are gone. |
| `GET /api/v1/debug/config` | The resolved configuration and where each value came from. |

Every `/api/v1` answer is an envelope: the payload is under `result`, beside a `timestamp` and a `request_id`. A failure is `{"error": {"code", "message"}, …}` instead, where `code` is a stable name such as `NOT_FOUND` or `RELAY_DISABLED`. Every response also carries an `x-request-id` header; send your own to have it echoed and tagged on the node's log lines, which is the quickest way to find one request in `docker logs`.

Event fields worth knowing:

| Field | Values |
| --- | --- |
| `carrier` | `http`, `grpc`, `grpc_via_relay`, `http_via_relay`: what actually carried the message. |
| `outcome` | `delivered`; `dropped` (the actor is offline, the message was discarded); `refused` (no route, no inbox, or refused, with the reason in `detail`). |

`AGENTS.md` in the repository has recipes for driving the node over HTTP.
