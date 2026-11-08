# Concepts

The words this app uses, and how its pieces fit together: node, actors, secrets and items, the participant pool, channels, replicas and versions.

## The node

The backend is a single local **node**: one process, one flat registry of actors, a store-and-forward mailbox per browser actor, and the helpers it hosts. Nothing groups actors above that registry. A second tab, an incognito window or a phone on the LAN simply adds more actors to the same list.

The node holds **no protocol logic**. Pairing, sharing, verification and recovery run in the DeRec SDK, in the page for browser owners and inside the backend for hosted helpers. It has no authentication either, so run it only on a machine or LAN you trust.

## Actors

| Role | Created by | Where its protocol runs |
| --- | --- | --- |
| **Owner** | A browser secret, through `POST /api/v1/owners` | In the page. The server gives it an address and a mailbox, and never sees its keys. |
| **Helper** | **Participants** → Provision, or `POST /api/v1/helpers` / `POST /api/v1/helpers/ensure` | In the backend. It answers pairing, share storage, verification and recovery requests unattended, and confirms its own pairing fingerprint. |

## Secret

A **secret** is what DeRec protects for one owner identity: an owner actor on the node, plus the keys, channels, item bag and held shares this browser keeps for it in `localStorage` (under `derec:secret:{id}:…`). Earlier versions of this app called it a *vault*.

- A browser can hold many secrets, and one tab runs all of them at once.
- A secret's owner can also act as a **helper** for another secret. The shares it holds for others appear on its **Shares** tab.
- The URL of a secret is `#/secret/{owner actor id}`. Old `#/vault/…` links still open.

## Items

An **item** is one entry you add to a secret: a name and its data, such as a password or a recovery phrase. A secret holds any number of items; DeRec protects them together.

## The participant pool

The **participant pool** is the node's set of provisioned helpers. It belongs to the server, not to the owner that asked for it, and every owner on the node pairs with the same helpers.

- Pool sizes are **targets**. **Provision up to N** creates only the shortfall, and asking for fewer removes nothing, because another owner may be paired with one.
- Setting up a secret reads the pool. It never grows it.

## Channels and roles

A **channel** is one pairing between two actors. Pairing is **unidirectional**: whoever initiates declares a role on the wire and the other side takes the complement.

| You declare | The peer becomes | Meaning |
| --- | --- | --- |
| Owner | Helper | You protect your secret; the peer holds a share. |
| Helper | Owner | You hold a share; the peer protects their secret. |
| Replica source | Replica destination | You mirror your secret to the peer. |
| Replica destination | Replica source | You receive the peer's secret, erasing this one. |

Only the owner side of a channel can unpair it.

## Replicas

A **replica** is another device of the same owner that mirrors the **whole secret** rather than holding one share of it. It is a **pairing mode, not a kind of actor**: any helper, or any browser secret, can be paired in replica mode. A helper paired that way runs one extra protocol instance for the owner it mirrors. See [Replicas](07-replicas.md).

## Item bag and versions

All of a secret's items travel together as one **item bag**.

- Every publish (adding or removing an item, resolving a replica conflict, some pairings) creates a **new version** of the bag, split into one share per paired helper.
- A version **commits** when the helpers that confirmed their share hold at least *threshold* subshares between them — one each, unless a helper is weighted (see [Protecting secrets](04-protecting-secrets.md#helper-weights)). Otherwise it is **rolled back** and the bag stays as it was.
- From SDK 0.0.10 each publish tells helpers the one earlier version to keep (the owner's `keepVersion`). This app keeps the **newest committed version** unless you choose at each publish. Helpers hold that version and the one being distributed, and delete anything else, including the shares of rolled-back rounds.

## Threshold and recommended count

| Value | Set from | Effect |
| --- | --- | --- |
| **Threshold** | The secret's **Channels** tab: a percentage of the helpers' subshares (a new secret starts at 50%) or a fixed number (starting from Settings → *Minimum*) | The number of subshares needed to rebuild the secret, and the number paired helpers must hold before **Add Item** is enabled. With no weighted helpers, one per helper. At least 2. |
| **Recommended** | Settings → *Recommended* | Below it the secret's page shows a warning banner. Advisory only. |

## Size limit

A secret's items may add up to **32 KB** (UTF-8 bytes of every name and value). The limit is the browser's, not the protocol's: `localStorage` holds about 5 MB per origin, and each version is stored several times over (one share per helper, every kept version, the library's own copy). Over the limit, **Add Item** refuses before anything is sent.

## Polling

There are no websockets. Each running secret polls its mailbox every 0.5 s while something is in flight and every 5 s when idle. A message delivered more than once is handled once.
