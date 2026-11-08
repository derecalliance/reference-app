# Glossary

Short definitions of the terms used in this app and its help, with a pointer to the topic that explains each.

| Term | Meaning |
| --- | --- |
| **Actor** | An entry in the node's registry: an owner (one per secret, run in the browser) or a helper (hosted by the node). See [Concepts](01-concepts.md). |
| **Adoption** | A replica destination replacing its own secret with the source's. On SDK 0.0.7, confirming the fingerprint is the decision to adopt. See [Replicas](07-replicas.md). |
| **Authentication method** | How the app decides two channels belong to the same user. Only `user` (manual linking) is selectable. |
| **bound / pinned** | Channel router tiers for gRPC: `bound` once pairing completed, `pinned` while a minted contact waits for its handshake. See [Inspect and Console](12-inspect-and-console.md). |
| **Carrier** | What actually carried a message: `http`, `grpc`, `grpc_via_relay` or `http_via_relay`. |
| **Channel** | One pairing between two actors, with its own shared key and id. |
| **Claim** | Taking over an existing owner actor's mailbox (wizard), or opening a secret another tab has released (secret list). |
| **Commit / rollback** | A publishing round commits when the helpers that confirm hold at least *threshold* subshares; otherwise the bag is rolled back. See [Protecting secrets](04-protecting-secrets.md). |
| **Contact** | What one side shares to be paired with: a QR code or its JSON payload. |
| **Contact mode** | *Inline keys*, *Hashed keys* or *No keys*: how a contact delivers the keys. See [Pairing](03-pairing.md). |
| **Discovery** | Asking paired helpers which secrets and versions they hold for you. See [Recovery and restore](06-recovery-and-restore.md). |
| **Fingerprint** | A `XXXX-XXXX-XXXX-XXXX` code both ends derive from a channel's shared key, compared by a person before a *No keys* or replica channel is used. |
| **Helper** | An actor that holds shares for an owner. Hosted helpers run on the node; a browser owner can be one too. |
| **Item** | One entry you add to a secret: a name and its data. Called a *user secret* by the DeRec SDK. See [Protecting secrets](04-protecting-secrets.md). |
| **Item bag (bag)** | All of a secret's items, published together as one versioned unit. |
| **keepVersion** | The one earlier version an owner tells helpers to keep on each publish, beside the one being sent; `0` keeps none. Replaced `keepList` in SDK 0.0.10. This app keeps the newest committed version unless you choose at each publish. |
| **Link** | Declaring on a helper's side that a new channel belongs to an owner it already helps, so it can answer that owner's discovery. |
| **Mailbox** | A browser owner's store-and-forward queue on the node, drained by polling. |
| **Node** | One running backend: actor registry, mailboxes, hosted helpers and debug surface. |
| **Owner** | The actor that protects a secret. Every secret in this browser has its own owner actor. |
| **Participant pool** | The node's provisioned helpers, shared by every owner; sizes are targets. See [Participants](10-participants.md). |
| **Pre-pairing** | Pairing pool helpers automatically at setup, skipping the QR exchange. A testing shortcut. |
| **Protocol timeout** | The single timeout a secret uses for expired messages, stale rounds and every wait in the UI. Default 30 s. |
| **Recommended** | The paired-helper count below which a secret's page shows a warning. |
| **Recover / restore** | Recover rebuilds a secret version and shows it; restore replaces this device's secret with it. Two separate steps. |
| **Relay** | `POST /derec/relay`: the node dialling an endpoint for a browser, which cannot speak gRPC. See [Transports](13-transports.md). |
| **Replica** | Another device of the same owner mirroring the whole secret. A pairing mode, not an actor kind. |
| **Replica conflict** | Two members holding different copies of one version. Publishing is paused until it is resolved. |
| **Replica id** | A stable per-device id within a replica group. |
| **Replica source / destination** | The device that keeps and mirrors its secret / the device that receives it, giving up its own. |
| **Round** | One publish of a bag version to every paired helper. |
| **Secret** | What DeRec protects for one owner: an owner actor plus the keys, channels, item bag and held shares this browser stores for it, identified on the wire by its Secret ID. Called a vault in earlier versions of this app. See [Concepts](01-concepts.md). |
| **Share** | One helper's piece of a bag version. *Threshold* shares rebuild it. |
| **Kept version** | The earlier version a publish tells helpers to keep; they delete the rest. Set on the Settings tab → *Earlier version helpers keep*. See [Protecting secrets](04-protecting-secrets.md#what-helpers-keep). |
| **Recoverable** | A version whose verified helpers hold at least its threshold of subshares between them. See [Verification](05-verification.md#recoverable). |
| **Verification copy** | This device's copy of what a helper holds for a version, used only to verify it. Deleting it never affects recovery. |
| **Subshare** | One Shamir piece of a bag version. A helper's share holds one subshare per unit of its weight. |
| **Threshold** | Subshares needed to rebuild a secret, and what paired helpers must hold between them to protect one. Set on the Channels tab as a percentage of the helpers' subshares (default 50%) or a fixed number; at least 2. |
| **Weight** | How many subshares a helper holds, 1 by default and always below the threshold. Kept by the library across publishes. See [Protecting secrets](04-protecting-secrets.md#helper-weights). |
| **Transport mode** | What a hosted helper advertises: `http`, `grpc` or `both`. Not what it can dial. |
| **Verification** | Challenging helpers to prove they still hold their shares. See [Verification](05-verification.md). |
| **Version** | One published state of the bag. Every publish takes a new number, assigned by the library. |
