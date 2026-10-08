# Troubleshooting

The messages the app and the node actually show, grouped by area, with what each means and what to do. Search for a few words of the message you see.

First stops for anything not listed: the **Console** (expand it, filter to the vault), **Inspect**, and `GET /api/v1/debug/events` for what the node delivered, dropped or refused.

## The node

| Message | Meaning | What to do |
| --- | --- | --- |
| *Can't reach the DeRec server* / *Cannot reach the DeRec server at … Is the backend running?* | The page cannot reach the backend. | Start it (`./start.sh`, or `cargo run` in `apps/backend`), then **Retry**. From source, the page looks for port 5000 of the host that served it; set `VITE_API_URL` otherwise. |
| *Could not poll the mailbox: the node could not be reached (…)* | A running vault lost the node. | Restart the node. Messages for browser owners are kept in their mailboxes meanwhile. |
| *DEREC_BASE_URL is loopback (…)* (boot log) | Peers would be told `localhost`. | Fine on one machine. For phones, other machines or other containers, set `DEREC_BASE_URL` to the LAN address (or `./start.sh --lan`). |
| *base_url must not include a port…* / *…with no path* / *…a scheme and host* | `base_url` is scheme and host only. | Remove the port or path; set ports with `DEREC_PUBLIC_PORT`. |
| *… names …, but there is no such file* | `DEREC_CONFIG_PATH` points nowhere, or a mount did not happen. | Fix the path or mount, or unset the variable. |
| *invalid configuration: …* | A value or combination fails validation; each line names the setting and its source. | Fix it, or remove a pinned value that no longer fits `participant_count`. |
| *helper_transports sums to N but participant_count is M* | The transport mix and the count disagree after merging file and environment. | Unset the mix, or change both. |
| *database is locked*, now and then | SQLite on a bind mount (macOS, Windows). | Use a named volume. |
| *port is already allocated* (Docker) | Port 5000 is taken, often by the macOS AirPlay Receiver. | `./start.sh` picks a free one; with Compose set `DEREC_HOST_PORT=8080`. |

## Setting up and the pool

| Message | Meaning | What to do |
| --- | --- | --- |
| *No participants are online on this node — provision some under Participants.* | The pool is empty or all offline. | **Participants** → **Provision up to N**. |
| *Secret protection is disabled — X of N required participants paired.* | Fewer helper channels than the vault's threshold. | Pair more helpers from the side panel. |
| *The minimum in Settings (…) cannot protect a secret* | Settings → *Minimum* is below 2 or invalid. | Fix it under Settings, or **Reset to node**. |
| *"…" could not be opened — it is already open in another tab.* | Another tab took the vault. | Use that tab, or close it and **Claim** here. |
| *a helper named "…" already exists; choose another name* | Helper names are unique on the node. | Pick another name. |
| *gRPC helpers requested but grpc_enabled is false* | The node runs no gRPC listener. | Set the transport mix to HTTP only, or enable gRPC on the node. |

## Pairing

| Message | Meaning | What to do |
| --- | --- | --- |
| *Pairing request timed out. The peer may not have responded.* | No answer within the protocol timeout. | Check the peer is running (a browser vault's tab must be open) and that its address is reachable. Check `routes` in Inspect: `pinned` means the handshake never finished. |
| *The peer rejected the pairing request.* | The other side clicked Reject. | Ask them. |
| *Could not reach the participant (the node's gRPC relay is off, or the node is unreachable). Details: …* | The request never left. | Turn the relay on, or pair with an HTTP participant; check the node is up. |
| *This participant is reachable over gRPC only, and the node's gRPC relay is off* | A browser cannot dial gRPC itself. | Enable `grpc_relay_enabled`, or use an HTTP helper. |
| Channel stuck at *Unconfirmed* | A *No keys* pairing waiting for fingerprints. | **Confirm fingerprint** on both sides. |
| *Scanning unavailable* | Not a secure context, no `BarcodeDetector`, or no camera; the reason is on hover. | Paste the payload, or see the secure-context flag in [Running the app](14-running-the-app.md). |
| *Removed from node* | The helper was deleted from the node. | **Unpair**, then **Forget this channel…** if it cannot acknowledge. |
| *Unpair did not go through* | The peer did not acknowledge. | **Try again**, or **Forget this channel…** if it is gone for good. |
| *Only the owner can unpair* | This vault is the helper on that channel. | Ask the owner to unpair. |
| Pairing "works" and then nothing arrives | Usually a loopback `base_url` across devices, or a port remapped without `DEREC_PUBLIC_PORT`. | See [Node configuration](15-node-configuration.md). |

## Protecting secrets

| Message | Meaning | What to do |
| --- | --- | --- |
| *Secret protection failed. Only X of the required T helpers confirmed. The secret bag has been rolled back.* | Too few helpers stored the version. | Check the failed rows (*Rejected*, *No answer*, *Not reachable*), fix those helpers, add again. |
| *Cannot reach the DeRec server, so no share requests went out and the bag is unchanged.* | The node is down. | Start it and retry. |
| *None of the N share request(s) could be delivered, so the bag is unchanged.* | Every send failed. | Check the node, the relay and the helpers' addresses in Inspect. |
| *The protocol dispatched no share requests…* | No helper channel could receive a share. | Pair helpers as Owner (not replica channels). |
| *The vault's secrets would total …, over the 32 KB…* | The bag would exceed the browser limit. | Use a smaller secret, or remove one. |
| *This browser's storage for the app is full…* | `localStorage` is out of room. | Remove vaults or secrets you no longer need. |
| *Last share: No answer* / *Last share: Not reachable* on a channel | The newest share to that helper failed. | Bring it online (Participants) or fix its address; the next publish retries. |

## Verification

| Message | Meaning | What to do |
| --- | --- | --- |
| *Publishing vN is still in progress — verify once it completes.* | A round is open. | Wait for it to commit or roll back. |
| *vN was restored from a recovered bag… cannot be verified.* | A restore keeps no proof material. | Publish a new version, then verify it. |
| *Rejected: …* | The helper refused the challenge (for example it no longer holds the version). | Check the helper; verify a newer version. |
| *Verification timed out* | No answer within the protocol timeout. | Check the helper is online. |
| *No participant confirmed vN, so there is nobody to challenge.* | That version has no confirmed holders. | Verify another version. |

## Recovery

| Message | Meaning | What to do |
| --- | --- | --- |
| *No paired helper to ask. Pair with the helpers that hold your shares, then discover again.* | Nothing to discover from. | Pair with the old helpers. |
| *Nothing found* on a helper | It has not linked this channel to your old one. | **Link** on the helper's side, then discover again. |
| *No answer* on a helper | It could not be reached; the reason is on hover. | Check it is online and reachable. |
| *Only X of the T helpers needed hold this version.* | Not enough holders. | Pair and link more helpers, or recover another version. |
| *… refused — it holds no share of vN* | The helper does not hold that version (it may have been dropped by a later `keepList`). | Recover a newer version, or rely on the other helpers. |
| *… sent a corrupted recovery share (…)* | The helper sent a share that failed its checks. | The recovery continues without it. Consider **Unpair…**. |

## Replicas

| Message | Meaning | What to do |
| --- | --- | --- |
| *This vault has diverged from its replica group* / *Publishing is paused until you resolve the conflict* | Two members hold different copies of a version. | **Get the group's copy**, then **Resolve…** and **Publish this version**. See [Replicas](07-replicas.md). |
| *vN was not delivered to a replica — it stays behind until it is reachable and you use Sync now* | A mirror failed. | Bring the member back, then **Sync now**. |
| *Expired* / *This channel expired before both devices confirmed* | Not confirmed within the protocol timeout. | Pair again and confirm in time. |
| *The channel key changed while you were comparing.* | The code changed under the dialog. | Close it and confirm with the new code. |
| *… never announced a replica id, so there is no group member to remove* | The pairing never completed far enough. | Use **Forget**. |
| *This device is blocked: adopting a mirrored vault failed after its own vault was erased.* | An adoption failed part-way. | Inspect the device; remove the vault from the browser and pair again. |
| A *Review…* banner and a **Replace this vault?** dialog, with no adoption question in the fingerprint dialog | A replica confirmed before this version of the app; it still uses the older adoption flow. | **Erase and adopt** to take the source's vault, or **Reject** (nothing is erased; it is offered again on the next sync). |
| *This vault was removed from its replica group by another member.* | Another member evicted this device. | Pair and mirror again to rejoin. |

## Tabs and browsers

| Message | Meaning | What to do |
| --- | --- | --- |
| *"…" is open in another tab* | One tab per vault. | Close it there, then **Claim**. |
| *Web Locks are unavailable and one-tab-per-vault is only enforced on a best-effort basis* | Not a secure context. | Open the app at `localhost` or over https, or keep each vault in one tab. |
| *That vault is not saved in this browser* | The link names a vault this browser does not hold. | Open it in the browser that holds it. |
| *Could not copy the log — this browser blocked clipboard access here* | No clipboard on this origin. | Use **Download**. |
| Odd failures after the node's data was erased | Browser vaults point at actors the node no longer has. | **Reset browser data** in every browser you used. |

## Relay and mailbox (in /api/v1/debug/events or the Console)

| Message | Meaning | What to do |
| --- | --- | --- |
| *relay target … is not this node and not an allowed host* (`403`) | The browser asked to reach another node. | Add that node to `relay_allowed_hosts` on this node. |
| *relay disabled on this node* (`503 RELAY_DISABLED`) | `grpc_relay_enabled = false`. | Enable it. |
| *… is this node's gRPC address, but gRPC is disabled here* (`409`) | `grpc_enabled = false`. | Enable gRPC or use HTTP helpers. |
| *the recipient's mailbox is full; it has not polled for a while* (`503 MAILBOX_FULL`) | A browser owner's mailbox hit 1000 messages / 16 MiB. | Open that vault so it drains. |
| `outcome: "dropped"` | The target helper is offline. | **Bring online** under Participants. |
| An inbound gRPC message `refused` although its channel is listed in `routes` | Several routes claim the channel with the same `side` and tier (for example two replicas mirroring one source), so the node will not pick one. | Check `routes` in `/api/v1/debug/state`: delivery prefers a bound `endpoint`, then a bound `mirror`, then a pin, and skips claimants with no gRPC endpoint. Remove the duplicate replica, or pair over HTTP. |
