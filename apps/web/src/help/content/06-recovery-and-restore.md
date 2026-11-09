# Recovery and restore

Getting a secret back on a new device: re-pairing with the old helpers, linking, discovery, recovering a version, refused and corrupted shares, helpers that disagree, and restoring the secret from the recovered bag.

## The idea

A recovering owner does not need the old device or the old actor. They **set up a new secret**, pair with the helpers that hold their shares, and each helper is told that the new channel belongs to the owner it already helps. That last step, **linking**, stands in for the authentication a real helper would perform (a call, an ID check), so it is always a human decision on the helper's side.

Recovery then has two separate steps, as the SDK requires: **recover** rebuilds the secret and shows it to you without writing anything, and **restore** replaces this device's secret with the recovered one.

## 1. Pair with the old helpers

On the new device (another browser profile, an incognito window, or another machine), set up a secret. Setting *Pre-pair locally* to 0 lets you choose the helpers yourself. Pair with at least *threshold* of the helpers that hold your shares, the usual way (see [Pairing](03-pairing.md)).

## 2. Link each channel on the helper's side

Until it is linked, a helper answers discovery with nothing for this device.

| Helper | Where to link |
| --- | --- |
| A provisioned helper on **this node** | Side panel → expand the helper → **Link**. Pick the channel whose peer is your old secret, then **Link**. |
| A provisioned helper on **another node** | Channels tab → **Link on its node** on that channel's row. The app calls that node's own link endpoint. If the channel does not say which node runs the helper (a gRPC-only helper), paste its mailbox URL, `http://host:port/derec/<actor id>`, shown as the HTTPS address on the helper's Share Contact. |
| Another **browser owner** acting as helper | Its owner links from their side: **Link to existing** on the *Incoming Pairing Request*, or **Link** on the channel row afterwards. |

A successful link reports *Channels linked — the helper can now answer discovery for this owner.*

## 3. Discover

On the **Recovery** tab, *Recovery-Paired Helpers* lists every paired helper channel (replica channels are never asked). Click **Discover All** (or **Re-discover All**).

| Tag | Meaning |
| --- | --- |
| **Pending** | Asked, no answer yet. |
| **Discovered** | The helper reported versions it holds for you. |
| **Nothing found** | It answered with nothing. Usually it has not linked this channel yet; ask it to, then discover again. |
| **No answer** | The helper could not be reached or did not answer. The reason is on hover. |

*Available Secrets* groups the answers by secret, one row per version, newest first, with how many helpers hold it. Versions this device's own record shows were rolled back are hidden, with a note saying how many.

## 4. Recover a version

Click **Recover** on a version row. The row shows *Recovering…* and *N shares received…*, then the secret appears under *Recovered Secrets*.

From SDK 0.0.11 the library decides a recovery **once**, after every helper it asked has answered (with a share, a refusal or an unusable share) or after 60 seconds without an answer. It then tries every group of matching shares, so nothing appears before the slowest helper answers or times out. A helper that never answered is listed on the row as not answering in time. The outcome is one of: recovered, **disputed** or **conflict** (see [Helpers that disagree](#helpers-that-disagree)), or **Incomplete**.

Status tags on a version row:

| Tag | Meaning |
| --- | --- |
| **Ready** | Enough helpers hold it (shown only when this device knows the threshold). |
| **Needs N** | Fewer helpers hold it than the threshold this device knows. |
| **Recovering…** | Shares are arriving. |
| **Incomplete** | The last attempt failed; the reason (shares collected, helpers without a usable share, helpers that did not answer in time) is shown and **Try Again** is offered. |
| **Recovered** | Rebuilt; see *Recovered Secrets*. |
| **Disputed** | Rebuilt, but the helpers disagree about this version; see *Recovered Secrets* before restoring. |

A fresh device does not know the threshold, so it shows only how many helpers hold the version, and **Recover** tells you whether that was enough.

## Refused and corrupted shares

A helper that answers without a usable share does not block the recovery. The other helpers' shares complete it, and the row lists who sent nothing usable:

- *Bob refused — it holds no share of vN* (status `UNKNOWN_SHARE_VERSION`), or the helper's own memo.
- *Bob sent a share that was set aside (Malformed | InvalidProof | Forged)*.

A **corrupted** share also raises a standing red warning at the top of the secret's page, *Bob sent a corrupted recovery share*, because an honest helper never sends one: it may be damaged or compromised (for `Malformed`, see the upgrade case below). It offers **Unpair…** (always confirmed) and **Dismiss**.

| Reason | Meaning |
| --- | --- |
| `Malformed` | The answer held no readable share of this secret and version. Besides a damaged helper, this is what a version protected before an SDK upgrade that changed the share format looks like: its shares still **verify** (verification hashes the bytes the helper holds) but no longer decode. Protect a new version and recover that one. |
| `InvalidProof` | The share failed its own integrity proof. |
| `Forged` | The share belongs to a group that reconstructs to no valid secret, or rebuilds a secret on its own. An honest split produces neither (SDK 0.0.11). |

A share that is valid but merely **disagrees** with the others is not reported as corrupted any more (SDK 0.0.11 removed `Inconsistent`): when a forged group wins, that share is the honest helper's. It is shown as a dispute instead. Warnings saved before the upgrade may still say `Inconsistent`.

## Helpers that disagree

A recovery needs shares from at least two helpers, so one helper can no longer have this device recover a secret it made up. Several colluding helpers still can, so the library never picks a side when the helpers' shares do not agree:

- **Disputed** — one secret was rebuilt, but other helpers hold valid shares of a different one that did not rebuild. The card is tagged **Disputed** and says who stands behind the secret and who disputes it.
- **Conflict** — two or more different secrets were rebuilt. Each appears as its own card, tagged **Candidate 1 of 2** and so on, naming the helpers behind it and those behind the others.

A critical notification says so as well. Either side may be yours: colluding helpers can forge a complete secret, and the honest ones may be too few to rebuild theirs. Reveal the items on each card and restore only the one you recognise. **Recover from bag** asks again, naming the helpers behind that secret. The helpers behind the other one may be compromised; unpairing them is your call, and the app never does it for you. Restoring one candidate clears the others.
## 5. Restore, or join the group

If the recovered secret still lives on a **replica**, the card also offers **Join group…**. While any replica is live, the library recommends joining over restoring: restoring next to a live replica makes this device claim the lost device's place. Neither path brings back verification copies of earlier versions.

**Join group…** lists the live members (the replica destinations; the source is normally the device that was lost, and stays in the group until you remove it from a live member):

- **Join through *member*** — for a member this node runs: pairs with it as its replica destination at once, nothing to copy.
- **Pair as replica destination** — for any member: on that device, **Share Contact**; here, paste it into **Pair** as *Replica destination*. Confirm the fingerprint, and this device receives and adopts the secret.

Known SDK 0.0.9 limitation: the member hands the secret over as soon as it confirms the code, and this device ignores that handover until it has confirmed too — after which it cannot ask again. Confirm the code here before the member does. A member this node runs confirms on its own at once, so joining through one does not complete yet.

### Restore

A recovered secret card shows the version, the secret id, every item (masked; reveal to check) and the helpers the bag names. Recovering writes nothing to this device's secret.

Click **Recover** on the card and confirm **Recover from bag**. This:

- replaces every channel, item and share this device holds with what the bag carries, and leaves recovery mode;
- takes back the channels to the helpers the bag names and tells each where to reach this device;
- unpairs, on both sides, any other channel (one paired only to recover).

It cannot be undone. The restored version cannot be verified (no proof material survives a restore); publish a new version to verify again.

### Restoring a secret that has replicas

The bag also carries the secret's replica group, and restoring brings it back: the Replicas tab lists the replica again, and the next published version is mirrored to it as before.

A replica group only accepts versions from one of its own members, so the restored secret has to be one:

- **On the device that held the group**, the secret keeps the identity it had.
- **On a new device**, the secret takes over the identity of the device the bag was protected from — the group's source — because that is the device it replaces. The console logs *This device now answers to the replica group as its source*. Its next publish tells the replica where it is now. Keep only one of the two devices publishing: the old one, if it still runs, answers under the same identity.

A secret restored on a new device by an earlier version of the app has no such identity, and every publish stops with *this secret belongs to a replica group that does not list this device*. Recover it again (Discover, Recover, Recover from bag) to fix it.

## Shares held for others

The **Shares** tab is the other side: the shares this secret holds as a helper for other owners, per channel and version, with the raw share in base64 or hex.
