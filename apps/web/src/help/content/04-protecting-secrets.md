# Protecting secrets

Adding and removing items, what every publish uses (the threshold and helper weights from the Channels tab, the version helpers keep), the Settings tab, what each progress state means, rollback, Republish and cleaning up verification copies.

## Add Item

**Add Item** in the secret's header (or on the empty Items tab) opens a form:

| Field | Notes |
| --- | --- |
| **Name** | A label, for example *Google Password*. |
| **Item Data** | The value, hidden while typing; the eye button reveals it. |

Below the fields, the form shows what this publish uses (see [Publish choices](#publish-choices)): the threshold and every paired helper's weight, read-only, and which earlier version helpers keep. Only channels on which you are the **owner** receive shares; replica channels never do.

**Add Item** is disabled, with the reason on hover, when:

- fewer helper channels are paired than the secret's threshold: *Need at least N paired participants (currently X)* — or, once helpers are weighted, *Need N subshares across paired participants (currently X)*;
- the secret has an unresolved replica conflict (see [Replicas](07-replicas.md)).

The data field enforces the 32 KB limit for the whole bag: *Up to 32 KB across all of this secret's items (… used)*. Over it, the form says so and nothing is sent.

## A publishing round

Adding an item publishes the **whole bag** as a new version, split into one share per paired helper:

1. The library assigns the version number and sends a share to every paired helper. A helper whose fingerprint has not been confirmed — or was refused (*Doesn’t match*) — is still pending in the library, gets nothing, and does not count towards the minimum needed to publish.
2. Each helper stores its share and confirms, refuses, or stays silent.
3. When every helper has answered or timed out, the round resolves:
   - at least *threshold* confirmed subshares (one per helper, unless helpers are weighted — see below): the version **commits** and becomes the current bag;
   - fewer: it is **rolled back** and the bag stays as it was.

Several rounds can run at once. Pairing a helper after a bag exists, and confirming a replica fingerprint, publish too, so version numbers can skip ahead of what you added yourself.

## Round progress

The progress dialog lists every helper the round went to, and only those: a helper the library did not send it to is not waited on, and is not counted as having failed to store the version.

| State | Meaning |
| --- | --- |
| **Waiting…** | No answer yet. |
| **Confirmed** | The helper stored its share. |
| **Rejected** | The helper answered and refused. Ask it why; the library's memo is on hover. |
| **No answer** | Nothing came back before the round closed. The helper may be offline. |
| **Not reachable** | The request never left: the node, the relay or the address failed. Nothing the helper did. |

The summary line reads, for example, *3 of 5 confirmed · 1 no answer · 1 waiting (need 3)*.

- **Threshold reached** while others are still waiting: the version commits once they answer or time out. Closing the dialog is safe; the round keeps running, and the Items tab shows *Publishing vN: X of Y confirmed (need T)* until it resolves.
- **Rolled back**: *Secret protection failed. Only X of the required T helpers confirmed. The item bag has been rolled back.* With weighted helpers it counts subshares: *Only X of the required T subshares were confirmed (N helpers).*
- **Committed with failures**: *New version published, but N helpers did not store it (…). The items are recoverable with the X confirmed helpers.*

A helper whose newest share met silence or a send failure shows *Last share: No answer* or *Last share: Not reachable* on its Channels row.

## The Items tab

- **Items** card: the current version tag, every item (masked; the eye reveals it), and a trash button per item to remove it.
- **Helper Shares**: who confirmed this version, with ✓ for verified, ✗ for a helper that refused verification, ○ for not yet verified, and a *Failed* list for helpers that did not store it.
- **View Payload**: the version as it is distributed, structured or as raw bytes, values masked until you click **Reveal values**. It includes the replica group when there is one.
- **Verify Shares**: see [Verification](05-verification.md).
- **Show Previous Versions**: the earlier versions this device recorded, one row each, with their own Payload, Verify and Remove. Remove deletes a version from this device — its record and its verification copies — and sends nothing: helpers that keep it still hold their shares, so it can still be recovered.
- **Secret ID** and **Threshold** of the bag, and **Helper weights** (below).

## Remove Item

The trash button on an item publishes a **new version without it**, with the same publish choices as Add Item. It does not edit earlier versions: the versions helpers still keep contain the item, and recovering one of those brings it back. Helpers keep at most one earlier version: under "keep the newest committed version", it is gone from them once one newer version has committed; under "choose at each publish", pick **None** to have helpers drop every earlier version now.

## Publish choices

Every publish dialog — Add Item, Remove Item, Republish — shows two things:

- **Threshold and weights**, read-only: *Threshold T of N subshares across M helpers*, with every helper's weight. Both are set on the **Channels** tab (see [Threshold and helper weights](#helper-weights)); a dialog cannot change them. Each version keeps the threshold it was published with, shown on its card.
- **Earlier version helpers keep**: under "keep the newest committed version", a line naming what helpers keep and what they drop, e.g. *Helpers will keep v4 and this new version; v3, v2 will be dropped*. Under "choose at each publish", one choice among the committed versions (the newest to start) or **None**. A round still being published is named too: helpers that store this version drop it.

The library checks every rule again; anything it refuses is reported and nothing is sent.

## The Settings tab

The secret's **Settings** tab holds everything this secret runs and publishes with, saved together with **Save** (**Discard changes** goes back to what is saved). Saving sends nothing. These are this device's — a replica of the secret keeps its own.

### Protocol

Each secret has its own protocol settings. A new secret starts from the app's defaults, marked *(default)* in each list; **Use the defaults** puts them all back. The node's own `[defaults]` and the general Settings page do not change them.

| Setting | Default | Effect |
| --- | --- | --- |
| **Protocol timeout (s)** | 30 | 10 to 86400. How long a flow waits for a peer, and how old an inbound message may be (the protocol's replay window). Also set in the setup wizard. |
| **Unpair acknowledgement** | Not required | *Required*: an unpair this secret starts keeps its state until the peer answers or the timeout passes. *Not required*: the state is dropped at once and a later answer is ignored. |
| **Incoming unpair requests** | Accept automatically | Or *Ask me*: an *Incoming Unpair Request* dialog. |
| **Incoming share storage requests** | Accept automatically | Or *Ask me*. When this secret's owner acts as a helper for another owner. |
| **Incoming verification requests** | Accept automatically | Or *Ask me*. When this secret's owner acts as a helper for another owner. |
| **Authentication method** | You link them | How the app decides two channels belong to the same person: by hand (*Link to existing*). *By the application* is reserved and not selectable. |

The three incoming-request choices apply at once. The **timeout** and the **unpair acknowledgement** are fixed into the secret's protocol when it starts, so a change to either applies the next time the secret starts — reload the page to apply it now. Until then the tab says which one is waiting.

### Publishing and verification

These apply from the next publish or check. The threshold and helper weights are on the Channels tab.

| Setting | Choices |
| --- | --- |
| **Earlier version helpers keep** | **The newest committed version** (default) or **Choose at each publish**. In "choose" mode, a publish the library starts on its own keeps the newest committed version; the Console says which version every round kept. A secret set to "keep the last N" before SDK 0.0.10 reads as the default. |
| **Old verification copies** | **Manually**, or **Automatically** after each new version, either following what helpers keep or keeping the last N. See [Cleaning up](#cleaning-up-verification-copies). |
| **Periodic verification** | Off, or every *amount* minutes, hours or days. See [Verification](05-verification.md). |

## What helpers keep

Every publish tells helpers the **one** earlier version to keep (the protocol's `keepVersion`, SDK 0.0.10). A helper holds at most that version and the one being sent:

- the version your rule keeps — the newest committed one, or the one you picked — or none;
- a helper deletes every other version it holds, so the shares of **rolled-back rounds** go on the next publish;
- so would a round **still open**, which is why the app publishes [one round at a time](#one-round-at-a-time);
- if this device knows no committed version yet (an empty bag), the version just below the one being sent is kept, in case it committed elsewhere.

## One round at a time

A version is settled once every helper has answered its round, or the round has timed out. Until then nothing that publishes can start: **Add Item**, **Remove**, **Republish…**, **Retry**, **Pair** and **Share Contact** (a completed pairing publishes the secret), **Unpair**, and a replica's **Sync now** and **Remove from group** are disabled and say which version is still being published, and confirming a fingerprint that would publish is refused. This includes the rounds the library starts on its own. An unpair still waiting for the helper's answer holds them back the same way, because it publishes when it completes.

When a round closes without every helper storing its share, a banner says so at the top of the secret's page:

- **Warning** — the helpers that stored it hold enough subshares to recover the version. **Dismiss** accepts it as it is.
- **Danger** — the round did not reach its threshold: the change was rolled back and the version is not recoverable. Helpers keep the last committed version. **Discard vN** drops the change.

**Retry** publishes the same items again as a new round (a new version number). The banner stays until a round settles with every helper, or you dismiss it.

## Unpairing a helper publishes a new version

When you unpair a helper that holds a share of the secret, the app publishes the current items again, as a new version, to the helpers that remain, with the threshold and weights set on the **Channels** tab. The unpaired helper's share then belongs to a version nothing else is built on. With the unpair acknowledgement *Required* this happens once the helper acknowledges (or the unpair times out); with *Not required*, the default, at once. Nothing is published when the secret holds no items, when the helper had no share (paired after the last publish), or when the remaining helpers' weights fall below the threshold: then the current version stays as it is, with one helper fewer able to answer, and the app says so. Should something else be in flight when the unpair completes, the publish follows once it settles.

**Forget this channel…** is different: it drops the channel on this device only, without the protocol, and publishes nothing. Use **Republish…** afterwards.

## Republish

**Republish…** next to the threshold on the Items tab publishes the current items again as a new version, with the Channels tab's threshold and weights. It is how a changed threshold or weights, or a different kept version, take effect without changing the items.

## Cleaning up verification copies

This device keeps a copy of exactly what it sent each helper for a version — on a replica, what it mirrored — only to check that helper's answers. Deleting a version's copies never affects recovery; that version just can no longer be verified from here (*no proof*).

- On the publishing device the library already removes copies that can no longer be verified. On a replica it never does, so they grow by one per helper per version.
- The **Verification Copies** tab lists every stored version, latest first, with how many helpers' copies it holds, their size, whether the version is still in this device's history, whether helpers still keep it (verifying it fails once they drop it) and how many of its helpers verified. Delete one version from its row, or check several and **Delete selected**; **Select by rule** checks what the secret's rule would delete.
- In automatic mode, the same happens after each new version lands, and the Console logs what went.
- The latest version and any round still open are always kept. Shares this secret holds *for* other owners are never listed: they are theirs.

## Threshold

The threshold starts as the secret's *Minimum*, chosen when the secret was created (see [Setting up a secret](02-setting-up-a-secret.md)). From SDK 0.0.9 it belongs to each version: change it on the **Channels** tab and the next publish splits at it, while the versions already distributed keep theirs. It is at least 2: the library refuses a threshold one helper could meet alone. A restored secret takes the threshold its recovered version was split with.

## Helper weights

From SDK 0.0.9 a helper can hold more than one piece of the secret. A helper's **weight** is how many *subshares* it holds, and the threshold counts subshares, not helpers. Every helper weighs 1 until you change it, so by default the two are the same.

Weighting lets fewer, more trusted helpers recover together. With a threshold of 3 and one helper at weight 2, that helper and any one other can recover — and a publish still commits with a third helper offline. No helper can ever weigh as much as the threshold: it could then recover alone.

- **Threshold**: at the top of the **Channels** tab, set one of two ways (the **?** beside *Threshold* sums up the one chosen):
  - **Percentage of subshares** (a new secret's default, at 50%): the threshold is **at least** that share of the subshares the paired helpers hold between them, rounded up and never below 2, worked out again at every publish from who is paired. *60% → threshold 3* says what it comes to now. 50% of 4 subshares is 2; 60% of 5 is 3. When the percentage would let one heavily weighted helper recover alone, the threshold is raised to one more than that helper's weight and marked *(raised)*; the **i** beside it explains why.
  - **Fixed number**: the threshold stays at that number however many helpers there are. Secrets set up before percentages existed, and secrets restored or joined from a group (which take the group's number), are on this.

  Every publish uses it. The tab shows how many subshares the helpers hold between them, and *the library last published at N* when that differs: the library reuses the last published number for the publishes it starts on its own (pairing a helper, confirming a fingerprint) — a percentage is only worked out again by the app's own publishes.
- **Weight**: each paired helper's row on the Channels tab has one. Each weight is from 1 to one below the threshold, and together they must reach the threshold. Under a percentage the threshold rises above the heaviest weight on its own, so any weight is allowed as long as another helper holds a subshare too.
- Both are preferences of this secret: setting them sends nothing until the next publish. While they would make the SDK refuse a round — a weight at or above the threshold, or helpers that cannot reach it — every publish is disabled and says what to fix on the Channels tab.
- **Last published**: the library remembers the weights of the last publish and reuses them for the publishes it starts on its own; a newly paired helper starts at 1. When that differs from the weight set, the row shows *· last published N*.
- Round progress marks a helper holding more than one subshare with *×N*. A restored secret keeps the weights its recovered version carried.

