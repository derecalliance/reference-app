# Participants

The node's shared pool of provisioned helpers: provisioning it, transport modes, taking one offline, deleting one, and linking channels on a helper.

## What the pane shows

**Participants** in the left navigation lists every helper the node runs (browser vaults are not listed). It refreshes every 4 seconds and works with no vault at all.

| Column | Shows |
| --- | --- |
| **Name** | Unique on the node, 1 to 64 characters. |
| **Transport** | `http`, `grpc` or `both`: the endpoints the helper advertises. |
| **Status** | *online*, or an *offline* chip. |
| **Actions** | **Take offline** / **Bring online**, **Delete**. |

## Provisioning

| Control | Effect |
| --- | --- |
| **Name** + **Provision** | Creates one HTTP helper under that name. A name already in use is refused (`409`). |
| **Provision up to N** | Brings the pool up to the target *N* (Settings → *Participants*, default 7) with the transport mix from Settings. Only the shortfall per transport mode is created; it is disabled once the pool is at or above the target. |

The pool is shared by every owner on the node, so a target never removes anything: asking for fewer than exist leaves the extra helpers alone. Two tabs provisioning at the same moment cannot both fill an empty pool; the node counts and creates under one lock.

New helpers are created with this browser's protocol timeout and unpair acknowledgement policy (see [Settings](11-settings.md)). Setting up a vault never provisions helpers.

## Transport modes

| Mode | Advertises | Notes |
| --- | --- | --- |
| `http` | `http://<base_url host>:<public_port>/derec/<id>` | Reachable from any browser directly. |
| `grpc` | `grpc://<base_url host>:<public_grpc_port>` | A browser reaches it only through the node's relay. Needs `grpc_enabled`. |
| `both` | Both endpoints | Peers may use either. |

The mode is what a helper **advertises**, not what it can dial: every hosted helper can send over both protocols. See [Transports](13-transports.md).

## Taking a participant offline

**Take offline** simulates an unreachable peer without stopping anything. The node keeps accepting messages for it and discards them (outcome `dropped` in `/api/v1/debug/events`). Owners see its rounds end in *No answer*, and its rows tagged *Offline*. **Bring online** resumes delivery; nothing discarded meanwhile comes back.

## Deleting a participant

**Delete** asks first, then removes the helper from the node entirely: its actor, stored channels and shares, and registry entry. It cannot be undone, and since the pool is shared it disappears for every owner.

Owners paired with it keep their channel, which now reads *Removed from node*. To clear it, unpair from the owner side; if the unpair cannot be acknowledged, use **Forget this channel…**.

## Linking channels on a helper

A hosted helper has no screen of its own, so the operator links for it. **Link** on a paired helper's row in a vault's side panel opens **Link on …**, which lists the helper's other channels by peer name. Choosing one declares that both channels belong to the same owner, so the helper can answer that owner's discovery after a recovery. Names are labels, not proof: in a real deployment the helper would authenticate the owner first. See [Recovery and restore](06-recovery-and-restore.md).
