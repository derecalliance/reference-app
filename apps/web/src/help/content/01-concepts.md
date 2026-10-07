# Concepts

The words this app uses, and how its pieces fit together: node, actors, vaults, the participant pool, channels, replicas and versions.

## The node

The backend is a single local **node**: one process, one flat registry of actors, a store-and-forward mailbox per browser actor, and the helpers it hosts. Nothing groups actors above that registry. A second tab, an incognito window or a phone on the LAN simply adds more actors to the same list.

The node holds **no protocol logic**. Pairing, sharing, verification and recovery run in the DeRec SDK, in the page for browser owners and inside the backend for hosted helpers. It has no authentication either, so run it only on a machine or LAN you trust.

## Actors

| Role | Created by | Where its protocol runs |
| --- | --- | --- |
| **Owner** | A browser vault, through `POST /api/v1/owners` | In the page. The server gives it an address and a mailbox, and never sees its keys. |
| **Helper** | **Participants** → Provision, or `POST /api/v1/helpers` / `POST /api/v1/helpers/ensure` | In the backend. It answers pairing, share storage, verification and recovery requests unattended, and confirms its own pairing fingerprint. |

## Vault

A **vault** is one owner identity: an owner actor on the node, plus the keys, channels, secret bag and held shares this browser keeps for it in `localStorage` (under `derec:vault:{id}:…`).

- A browser can hold many vaults, and one tab runs all of them at once.
- A vault can also act as a **helper** for another vault. The shares it holds for others appear on its **Shares** tab.
- The URL of a vault is `#/vault/{owner actor id}`.

## The participant pool

The **participant pool** is the node's set of provisioned helpers. It belongs to the server, not to the owner that asked for it, and every owner on the node pairs with the same helpers.

- Pool sizes are **targets**. **Provision up to N** creates only the shortfall, and asking for fewer removes nothing, because another owner may be paired with one.
- Setting up a vault reads the pool. It never grows it.

## Channels and roles

A **channel** is one pairing between two actors. Pairing is **unidirectional**: whoever initiates declares a role on the wire and the other side takes the complement.

| You declare | The peer becomes | Meaning |
| --- | --- | --- |
| Owner | Helper | You protect your secret; the peer holds a share. |
| Helper | Owner | You hold a share; the peer protects their secret. |
| Replica source | Replica destination | You mirror your vault to the peer. |
| Replica destination | Replica source | You receive the peer's vault, erasing this one. |

Only the owner side of a channel can unpair it.

## Replicas

A **replica** is another device of the same owner that mirrors the **whole vault** rather than holding one share of it. It is a **pairing mode, not a kind of actor**: any helper, or any browser vault, can be paired in replica mode. A helper paired that way runs one extra protocol instance for the owner it mirrors. See [Replicas](07-replicas.md).

## Secret bag and versions

All of a vault's secrets travel together as one **secret bag**.

- Every publish (adding or removing a secret, resolving a replica conflict, some pairings) creates a **new version** of the bag, split into one share per paired helper.
- A version **commits** when at least *threshold* helpers confirm their share. Otherwise it is **rolled back** and the bag stays as it was.
- From SDK 0.0.7 each publish tells helpers which versions to keep (the owner's `keepList`). This app lists the **three newest committed versions** plus the one being distributed. Helpers delete anything else, including the shares of rolled-back rounds.

## Threshold and recommended count

| Value | Set from | Effect |
| --- | --- | --- |
| **Threshold** (Minimum) | Settings → *Minimum*, copied into the vault when it is created and never changed afterwards | The number of shares needed to rebuild the secret, and the number of paired helpers needed before **Add Secret** is enabled. At least 2. |
| **Recommended** | Settings → *Recommended* | Below it the vault shows a warning banner. Advisory only. |

## Secret size limit

A vault's secrets may add up to **32 KB** (UTF-8 bytes of every name and value). The limit is the browser's, not the protocol's: `localStorage` holds about 5 MB per origin, and each version is stored several times over (one share per helper, every kept version, the library's own copy). Over the limit, **Add Secret** refuses before anything is sent.

## Polling

There are no websockets. Each running vault polls its mailbox every 0.5 s while something is in flight and every 5 s when idle. A message delivered more than once is handled once.
