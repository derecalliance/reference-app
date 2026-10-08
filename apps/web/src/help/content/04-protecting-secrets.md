# Protecting secrets

Adding and removing secrets, how a publishing round works, the threshold, what each progress state means, rollback, and which versions helpers keep.

## Add Secret

**Add Secret** in the vault header (or on the empty Secrets tab) opens a form:

| Field | Notes |
| --- | --- |
| **Name** | A label, for example *Google Password*. |
| **Secret Data** | The value, hidden while typing; the eye button reveals it. |

The form lists the paired participants the new version will go to. Only channels where this vault is the **owner** receive shares; replica channels never do.

**Add Secret** is disabled, with the reason on hover, when:

- fewer helper channels are paired than the vault's threshold: *Need at least N paired participants (currently X)*;
- the vault has an unresolved replica conflict (see [Replicas](07-replicas.md)).

The data field enforces the 32 KB limit for the whole bag: *Up to 32 KB across all of this vault's secrets (… used)*. Over it, the form says so and nothing is sent.

## A publishing round

Adding a secret publishes the **whole bag** as a new version, split into one share per paired helper:

1. The library assigns the version number and sends a share to every paired helper. A helper whose fingerprint has not been confirmed — or was refused (*Doesn’t match*) — is still pending in the library, gets nothing, and does not count towards the minimum needed to publish.
2. Each helper stores its share and confirms, refuses, or stays silent.
3. When every helper has answered or timed out, the round resolves:
   - at least *threshold* confirmations: the version **commits** and becomes the current bag;
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
- **Rolled back**: *Secret protection failed. Only X of the required T helpers confirmed. The secret bag has been rolled back.*
- **Committed with failures**: *New version published, but N helpers did not store it (…). The secrets are recoverable with the X confirmed helpers.*

A helper whose newest share met silence or a send failure shows *Last share: No answer* or *Last share: Not reachable* on its Channels row.

## The Secrets tab

- **Secrets** card: the current version tag, every secret (masked; the eye reveals it), and a trash button per secret to remove it.
- **Helper Shares**: who confirmed this version, with ✓ for verified, ✗ for a helper that refused verification, ○ for not yet verified, and a *Failed* list for helpers that did not store it.
- **View Payload**: the version as it is distributed, structured or as raw bytes, values masked until you click **Reveal values**. It includes the replica group when there is one.
- **Verify Shares**: see [Verification](05-verification.md).
- **Show Previous Versions**: the earlier versions this device recorded.
- **Secret ID** and **Threshold** of the bag.

## Remove Secret

The trash button on a secret publishes a **new version without it**, through the same kind of round. It does not edit earlier versions: the versions helpers still keep (the three newest committed ones, see below) contain the secret, and recovering one of those brings it back. Once three newer versions have committed, helpers drop the last version that held it.

## What helpers keep

From SDK 0.0.7 the owner decides which versions helpers keep, and every publish carries that list (`keepList`):

- this app lists the **three newest committed versions**, and the library adds the version being distributed;
- it also lists every round that is **still open**, including the ones the library publishes on its own (pairing a helper, confirming a replica's fingerprint), which can stay open until the replica acknowledges. Such a round may still commit, so a newer publish must not make helpers drop it;
- a helper deletes every version the list does not name, so the shares of **rolled-back rounds** are dropped on the next publish;
- if this device knows no committed version yet (an empty bag), it sends no list, and helpers keep everything.

There is no setting for the number of versions kept.

## Threshold

The threshold is the vault's *Minimum*, fixed when the vault was created (see [Setting up a vault](02-setting-up-a-vault.md)). It cannot be changed afterwards, because the shares already distributed depend on it. It is at least 2: the library refuses a threshold one helper could meet alone.
