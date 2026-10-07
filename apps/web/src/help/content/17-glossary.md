# Glossary

Short definitions of the terms used in this app and its help, with a pointer to the topic that explains each.

| Term | Meaning |
| --- | --- |
| **Actor** | An entry in the node's registry: an owner (a browser vault) or a helper (hosted by the node). See [Concepts](01-concepts.md). |
| **Adoption** | A replica destination replacing its own vault with the source's. On SDK 0.0.7, confirming the fingerprint is the decision to adopt. See [Replicas](07-replicas.md). |
| **Authentication method** | How the app decides two channels belong to the same user. Only `user` (manual linking) is selectable. |
| **Bag (secret bag)** | All of a vault's secrets, published together as one versioned unit. |
| **bound / pinned** | Channel router tiers for gRPC: `bound` once pairing completed, `pinned` while a minted contact waits for its handshake. See [Inspect and Console](12-inspect-and-console.md). |
| **Carrier** | What actually carried a message: `http`, `grpc`, `grpc_via_relay` or `http_via_relay`. |
| **Channel** | One pairing between two actors, with its own shared key and id. |
| **Claim** | Taking over an existing owner actor's mailbox (wizard), or opening a vault another tab has released (vault list). |
| **Commit / rollback** | A publishing round commits when at least *threshold* helpers confirm; otherwise the bag is rolled back. See [Protecting secrets](04-protecting-secrets.md). |
| **Contact** | What one side shares to be paired with: a QR code or its JSON payload. |
| **Contact mode** | *Inline keys*, *Hashed keys* or *No keys*: how a contact delivers the keys. See [Pairing](03-pairing.md). |
| **Discovery** | Asking paired helpers which secrets and versions they hold for you. See [Recovery and restore](06-recovery-and-restore.md). |
| **Fingerprint** | A `XXXX-XXXX-XXXX-XXXX` code both ends derive from a channel's shared key, compared by a person before a *No keys* or replica channel is used. |
| **Helper** | An actor that holds shares for an owner. Hosted helpers run on the node; a browser vault can be one too. |
| **keepList** | The versions an owner tells helpers to keep on each publish. This app lists the three newest committed versions (SDK 0.0.7). |
| **Link** | Declaring on a helper's side that a new channel belongs to an owner it already helps, so it can answer that owner's discovery. |
| **Mailbox** | A browser owner's store-and-forward queue on the node, drained by polling. |
| **Node** | One running backend: actor registry, mailboxes, hosted helpers and debug surface. |
| **Owner** | The actor that protects a secret. Every vault is an owner. |
| **Participant pool** | The node's provisioned helpers, shared by every owner; sizes are targets. See [Participants](10-participants.md). |
| **Pre-pairing** | Pairing pool helpers automatically at setup, skipping the QR exchange. A testing shortcut. |
| **Protocol timeout** | The single timeout a vault uses for expired messages, stale rounds and every wait in the UI. Default 300 s. |
| **Recommended** | The paired-helper count below which a vault shows a warning. |
| **Recover / restore** | Recover rebuilds a secret version and shows it; restore replaces this vault with it. Two separate steps. |
| **Relay** | `POST /derec/relay`: the node dialling an endpoint for a browser, which cannot speak gRPC. See [Transports](13-transports.md). |
| **Replica** | Another device of the same owner mirroring the whole vault. A pairing mode, not an actor kind. |
| **Replica conflict** | Two members holding different copies of one version. Publishing is paused until it is resolved. |
| **Replica id** | A stable per-device id within a replica group. |
| **Replica source / destination** | The device that keeps and mirrors its vault / the device that receives it, giving up its own. |
| **Round** | One publish of a bag version to every paired helper. |
| **Share** | One helper's piece of a bag version. *Threshold* shares rebuild it. |
| **Threshold** | Shares needed to rebuild a secret, and paired helpers needed to protect one. The vault's *Minimum*, frozen at setup; at least 2. |
| **Transport mode** | What a hosted helper advertises: `http`, `grpc` or `both`. Not what it can dial. |
| **Vault** | One owner identity in a browser: an owner actor plus the keys, channels, bag and held shares stored for it. |
| **Verification** | Challenging helpers to prove they still hold their shares. See [Verification](05-verification.md). |
| **Version** | One published state of the bag. Every publish takes a new number, assigned by the library. |
