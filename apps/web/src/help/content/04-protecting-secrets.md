# Protecting secrets

Adding and removing secrets, the choices every publish makes (threshold, helper weights, versions helpers keep), Vault Settings, what each progress state means, rollback, Republish and cleaning up verification copies.

## Add Secret

**Add Secret** in the vault header (or on the empty Secrets tab) opens a form:

| Field | Notes |
| --- | --- |
| **Name** | A label, for example *Google Password*. |
| **Secret Data** | The value, hidden while typing; the eye button reveals it. |

Below the fields, the form shows this publish's choices (see [Publish choices](#publish-choices)): the threshold, every paired helper's weight, and which earlier versions helpers keep. Only channels where this vault is the **owner** receive shares; replica channels never do.

**Add Secret** is disabled, with the reason on hover, when:

- fewer helper channels are paired than the vault's threshold: *Need at least N paired participants (currently X)* — or, once helpers are weighted, *Need N subshares across paired participants (currently X)*;
- the vault has an unresolved replica conflict (see [Replicas](07-replicas.md)).

The data field enforces the 32 KB limit for the whole bag: *Up to 32 KB across all of this vault's secrets (… used)*. Over it, the form says so and nothing is sent.

## A publishing round

Adding a secret publishes the **whole bag** as a new version, split into one share per paired helper:

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

- **Threshold reached** while others are still waiting: the version commits once they answer or time out. Closing the dialog is safe; the round keeps running, and the Secrets tab shows *Publishing vN: X of Y confirmed (need T)* until it resolves.
- **Rolled back**: *Secret protection failed. Only X of the required T helpers confirmed. The secret bag has been rolled back.* With weighted helpers it counts subshares: *Only X of the required T subshares were confirmed (N helpers).*
- **Committed with failures**: *New version published, but N helpers did not store it (…). The secrets are recoverable with the X confirmed helpers.*

A helper whose newest share met silence or a send failure shows *Last share: No answer* or *Last share: Not reachable* on its Channels row.

## The Secrets tab

- **Secrets** card: the current version tag, every secret (masked; the eye reveals it), and a trash button per secret to remove it.
- **Helper Shares**: who confirmed this version, with ✓ for verified, ✗ for a helper that refused verification, ○ for not yet verified, and a *Failed* list for helpers that did not store it.
- **View Payload**: the version as it is distributed, structured or as raw bytes, values masked until you click **Reveal values**. It includes the replica group when there is one.
- **Verify Shares**: see [Verification](05-verification.md).
- **Show Previous Versions**: the earlier versions this device recorded.
- **Secret ID** and **Threshold** of the bag, and **Helper weights** (below).

## Remove Secret

The trash button on a secret publishes a **new version without it**, with the same publish choices as Add Secret. It does not edit earlier versions: the versions helpers still keep contain the secret, and recovering one of those brings it back. Under "keep the last N", it is gone from helpers once N newer versions have committed; under "choose at each publish", uncheck the versions that hold it to have helpers drop them now.

## Publish choices

Every publish dialog — Add Secret, Remove Secret, Republish — shows three things, filled in from the vault's defaults and changeable for this publish only:

- **Threshold**: subshares needed to recover this version, from Vault Settings. Changing it shows **Remember this threshold for future publishes**; checked, it becomes the vault's default. Each version keeps its own threshold, shown on its card.
- **Helper weights**: every paired helper's weight, from its default on the Channels list (see [Helper weights](#helper-weights)). Each weight is from 1 to one below the threshold, and together they must reach the threshold, or no version could be published.
- **Versions helpers keep**: under "keep the last N", a line naming what helpers keep and what they drop, e.g. *Helpers will keep v4, v3 and this new version; v2 will be dropped*. Under "choose at each publish", a checklist of the committed versions (all checked to start); a round still being published is always kept and shown locked.

The library checks every rule again; anything it refuses is reported and nothing is sent.

## Vault Settings

**Vault Settings** in the vault header holds this vault's standing choices. Saving sends nothing; they apply from the next publish or check. They are this device's — a replica of the vault keeps its own.

| Setting | Choices |
| --- | --- |
| **Default threshold** | What every publish starts from. Shows *the library last published at N* when that differs: the library reuses the last threshold for the publishes it starts on its own (pairing a helper, confirming a fingerprint). |
| **Versions helpers keep** | **Keep the last N versions** (default 3) or **Choose at each publish**. In "choose" mode, a publish the library starts on its own sends no list, so helpers keep everything; the Console says so. |
| **Old verification copies** | **Manually**, or **Automatically** after each new version, either following what helpers keep or keeping the last N. See [Cleaning up](#cleaning-up-verification-copies). |
| **Periodic verification** | Off, or every *amount* minutes, hours or days. See [Verification](05-verification.md). |

## What helpers keep

Every publish tells helpers which versions to keep (the protocol's `keepList`):

- the versions your rule keeps — the N newest committed ones, or the ones you checked — and the library adds the version being sent;
- every round **still open**, including the ones the library publishes on its own, which can stay open until a replica acknowledges. Such a round may still commit, so a newer publish must not make helpers drop it;
- a helper deletes every version the list does not name, so the shares of **rolled-back rounds** go on the next publish;
- if this device knows no committed version yet (an empty bag), or in "choose" mode for a publish nobody chose for, no list is sent and helpers keep everything.

## Republish

**Republish…** next to the default threshold on the Secrets tab publishes the current secrets again as a new version, with the publish choices above. It is how changed default weights, a different threshold or a different set of kept versions take effect without changing the secrets.

## Cleaning up verification copies

This device keeps a copy of exactly what it sent each helper for a version — on a replica, what it mirrored — only to check that helper's answers. Deleting a version's copies never affects recovery; that version just can no longer be verified from here (*no proof*).

- On the publishing device the library already removes copies that can no longer be verified. On a replica it never does, so they grow by one per helper per version.
- **Clean up…** on the Secrets tab lists every stored version with how many copies it holds and their size, pre-selects what the vault's rule would delete, and deletes what you leave checked.
- In automatic mode, the same happens after each new version lands, and the Console logs what went.
- The latest version and any round still open are always kept. Shares this vault holds *for* other owners are never listed: they are theirs.

## Threshold

The threshold starts as the vault's *Minimum*, chosen when the vault was created (see [Setting up a vault](02-setting-up-a-vault.md)). From SDK 0.0.9 it belongs to each version: a publish can split at a different threshold, and the versions already distributed keep theirs. It is at least 2: the library refuses a threshold one helper could meet alone. A restored vault takes the threshold its recovered version was split with.

## Helper weights

From SDK 0.0.9 a helper can hold more than one piece of the secret. A helper's **weight** is how many *subshares* it holds, and the threshold counts subshares, not helpers. Every helper weighs 1 until you change it, so by default the two are the same.

Weighting lets fewer, more trusted helpers recover together. With a threshold of 3 and one helper at weight 2, that helper and any one other can recover — and a publish still commits with a third helper offline. No helper can ever weigh as much as the threshold: it could then recover alone.

- **Default weight**: each paired helper's row on the Channels list has one. It is a preference of this vault; setting it sends nothing.
- **Per publish**: every publish dialog starts from the defaults and can change any weight for that publish.
- **Last published**: the library remembers the weights of the last publish and reuses them for the publishes it starts on its own; a newly paired helper starts at 1. When that differs from the default, the row shows *· last published N*.
- Round progress marks a helper holding more than one subshare with *×N*. A restored vault keeps the weights its recovered version carried.

