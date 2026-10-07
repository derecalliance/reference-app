# Identity and addresses

How a vault presents itself to peers, how Edit Identity changes its name or endpoint, what peers are told, and how replica groups learn the change.

## What peers see

Every vault has a **name** and an **endpoint**, the address peers post protocol messages to. The endpoint is the vault's mailbox on the node: `<node base URL>:<public port>/derec/<vault id>`, shown in the vault header next to `HTTPS`.

The node stamps its own address into every endpoint it hands out, from `DEREC_BASE_URL` and `DEREC_PUBLIC_PORT`. So the endpoint is only as reachable as that address: a loopback `http://localhost` works for browsers on the same machine and nothing else. See [Node configuration](15-node-configuration.md).

## Edit Identity

**Edit Identity** in the vault header changes the name, the endpoint, or both, and tells every paired peer.

| Field | Notes |
| --- | --- |
| **Name** | 1 to 64 characters, no control characters. Also renames the owner actor on the node. |
| **Follow the address the node advertises** | Checked by default. The endpoint is whatever the node lists for this vault, and it moves when the node is republished on another address or port. |
| **Endpoint** (when unchecked) | A pinned address. It must be a full `http://` or `https://` URL including the mailbox path, for example `http://192.168.0.28:5000/derec/<vault id>`; a browser vault cannot serve gRPC. Node address changes no longer move it. Warnings appear when peers may not be able to reach it. |

**Save and tell peers** then shows each peer's answer as it arrives:

| State | Meaning |
| --- | --- |
| **Waiting… Ns of Ts** | Sent; no answer yet. |
| **Updated** | The peer recorded the new values. |
| **Rejected** | The peer refused the update. |
| **Not delivered** | The message could not be sent. |
| **No answer** | Silent after the protocol timeout. |

Closing is safe; answers keep arriving in the Console. **Resend to N peers that didn't get it** sends the same update again to those peers only, and saving with no changes does the same. With nothing changed and nothing undelivered, the dialog says *Nothing changed, so no peer was told.*

New contacts carry the new name and address too.

## What is announced, and how

- **Helper channels** receive the protocol's `UpdateChannelInfo` message.
- **Replica group members** do not: a member's name and endpoint travel in the group roster. So for a vault in a replica group, Edit Identity **publishes a new version first**, which carries the updated roster to every member (and to the helpers' recoverable copy), and then announces to the helpers.
- Keep the old endpoint working until enough peers have the update.

## When the node's address changes

When the node restarts on a new `base_url` or port, it re-advertises every actor at the current address. Hosted helpers announce the move to the peers they are paired with.

A **browser vault announces its own move**, from its tab: while it runs and follows the node's address, it notices the new listing, publishes a new version to its replica group if it has one, and sends `UpdateChannelInfo` to its helpers. A vault whose tab is closed does this the next time it runs. A pinned vault never moves on its own; change it with Edit Identity.

The node also remembers every address it has advertised, so messages sent to an old one are still delivered in-process. A peer on another node that could not be told keeps the old address until it pairs again.
