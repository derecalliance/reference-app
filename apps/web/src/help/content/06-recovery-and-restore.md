# Recovery and restore

Getting a secret back on a new device: re-pairing with the old helpers, linking, discovery, recovering a version, refused and corrupted shares, and restoring the vault from the recovered bag.

## The idea

A recovering owner does not need the old device or the old actor. They **set up a new vault**, pair with the helpers that hold their shares, and each helper is told that the new channel belongs to the owner it already helps. That last step, **linking**, stands in for the authentication a real helper would perform (a call, an ID check), so it is always a human decision on the helper's side.

Recovery then has two separate steps, as the SDK requires: **recover** rebuilds the secret and shows it to you without writing anything, and **restore** replaces this vault with the recovered one.

## 1. Pair with the old helpers

On the new device (another browser profile, an incognito window, or another machine), set up a vault. Setting *Pre-pair locally* to 0 lets you choose the helpers yourself. Pair with at least *threshold* of the helpers that hold your shares, the usual way (see [Pairing](03-pairing.md)).

## 2. Link each channel on the helper's side

Until it is linked, a helper answers discovery with nothing for this device.

| Helper | Where to link |
| --- | --- |
| A provisioned helper on **this node** | Side panel → expand the helper → **Link**. Pick the channel whose peer is your old vault, then **Link**. |
| A provisioned helper on **another node** | Channels tab → **Link on its node** on that channel's row. The app calls that node's own link endpoint. If the channel does not say which node runs the helper (a gRPC-only helper), paste its mailbox URL, `http://host:port/derec/<actor id>`, shown as the HTTPS address on the helper's Share Contact. |
| Another **browser vault** acting as helper | Its owner links from their side: **Link to existing** on the *Incoming Pairing Request*, or **Link** on the channel row afterwards. |

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

Status tags on a version row:

| Tag | Meaning |
| --- | --- |
| **Ready** | Enough helpers hold it (shown only when this device knows the threshold). |
| **Needs N** | Fewer helpers hold it than the threshold this device knows. |
| **Recovering…** | Shares are arriving. |
| **Incomplete** | The last attempt failed; the reason is shown and **Try Again** is offered. |
| **Recovered** | Rebuilt; see *Recovered Secrets*. |

A fresh device does not know the threshold, so it shows only how many helpers hold the version, and **Recover** tells you whether that was enough.

## Refused and corrupted shares

From SDK 0.0.7 a helper that answers without a usable share no longer blocks the recovery. The other helpers' shares complete it, and the row lists who sent nothing usable:

- *Bob refused — it holds no share of vN* (status `UNKNOWN_SHARE_VERSION`), or the helper's own memo.
- *Bob sent a share that was set aside (Malformed | InvalidProof | Inconsistent)*.

A **corrupted** share also raises a standing red warning at the top of the vault page, *Bob sent a corrupted recovery share*, because an honest helper never sends one: it may be damaged or compromised. It offers **Unpair…** (always confirmed) and **Dismiss**.

| Reason | Meaning |
| --- | --- |
| `Malformed` | The answer held no readable share of this secret and version. |
| `InvalidProof` | The share failed its own integrity proof. |
| `Inconsistent` | The share disagreed with the shares the secret was rebuilt from. |

## 5. Restore

A recovered secret card shows the version, the secret id, every user secret (masked; reveal to check) and the helpers the bag names. Recovering writes nothing to the vault.

Click **Recover** on the card and confirm **Recover from bag**. This:

- replaces every channel, secret and share this device holds with what the bag carries, and leaves recovery mode;
- takes back the channels to the helpers the bag names and tells each where to reach this device;
- unpairs, on both sides, any other channel (one paired only to recover).

It cannot be undone. The restored version cannot be verified (no proof material survives a restore); publish a new version to verify again.

### Restoring a vault that has replicas

The bag also carries the vault's replica group, and restoring brings it back: the Replicas tab lists the replica again, and the next published version is mirrored to it as before.

A replica group only accepts versions from one of its own members, so the restored vault has to be one:

- **On the device that held the group**, the vault keeps the identity it had.
- **On a new device**, the vault takes over the identity of the device the bag was protected from — the group's source — because that is the device it replaces. The console logs *This device now answers to the replica group as its source*. Its next publish tells the replica where it is now. Keep only one of the two devices publishing: the old one, if it still runs, answers under the same identity.

A vault restored on a new device by an earlier version of the app has no such identity, and every publish stops with *this vault belongs to a replica group that does not list this device*. Recover it again (Discover, Recover, Recover from bag) to fix it.

## Shares held for others

The **Shares** tab is the other side: the shares this vault holds as a helper for other owners, per channel and version, with the raw share in base64 or hex.
