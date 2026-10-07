# Replicas

Mirroring a whole vault onto another device of the same owner: adding a replica, fingerprint confirmation and the adoption decision, mirroring status, sync, conflicts, and removing a member.

## What a replica is

A replica is another of **your own devices** that holds a full copy of the vault, so it can take over if this one is lost. It is not a helper: it mirrors the whole secret, in the clear to its holder, instead of one share of it. Replica is a **pairing mode, not a kind of actor**, so any provisioned helper or any browser vault can be one.

- The device that holds the vault is the **Replica source**. The device that receives it is the **Replica destination**.
- All members of a replica group share one group channel. Each device has a stable **replica id** that identifies the device, not the vault it holds.
- Replica channels appear only on the **Replicas** tab, never on Channels, and never receive shares.

## Adding a replica

| Way | Steps |
| --- | --- |
| **Hosted, on this node** | Side panel → *Replicas* → **+ Add**, type a name, **Add Replica**. The app provisions a helper under that name (it joins the shared pool) and pairs it with this vault as *Replica source*. |
| **Another browser or device** | Use a separate browser context (another profile, an incognito window, another browser or machine); vaults in one browser share storage. Set up a vault there. Then one side shares a contact (**Share Contact**) and the other pairs with **Pair**, picking *Replica source* on the device that keeps its vault or *Replica destination* on the device that gives its vault up. |

Picking *Replica destination* asks first, in **Pair as replica destination?**: *This device's vault will be erased*. Nothing is erased by continuing; **Cancel** is the default. The receiving side of a replica pairing sees **Incoming replica pairing request**, again with **Reject** as the default.

## Fingerprint confirmation and adoption

After the handshake the replica channel is `Pending` and carries nothing. Each side derives the same `XXXX-XXXX-XXXX-XXXX` code, and a dialog, **Confirm "…"**, opens on its own whichever tab is showing.

**On the source**, compare the code with the other screen and click **Codes match**, or **Doesn't match**. Confirming publishes the vault to the replica at once. A hosted helper confirms its own side automatically.

**On the destination**, confirming is also the decision to **adopt** the source's vault (SDK 0.0.7). So the dialog asks that question **before** it confirms:

1. **Codes match** moves to a second step: *Confirming adopts …'s vault*.
2. **Adopt and confirm** confirms the fingerprint. From then on the source's vault is installed here as soon as it arrives, without asking again: every secret, helper channel and share this vault holds on this device is replaced. Other vaults in the browser are untouched.
3. **Don't adopt** (the default) confirms nothing. The channel stays unconfirmed, this vault is unchanged, and the row reads *Adoption declined*.

The channel becomes usable only when **both** sides have confirmed; the library enforces this, not the app. Closing the dialog changes nothing: reopen it from the row. An unconfirmed channel shows a countdown (*Confirm within m:ss…*) and is dropped after the protocol timeout, after which you pair again.

**Replicas confirmed before this version** of the app confirmed the fingerprint without the adoption question. When their source's vault arrives, they still show the older flow: a *Review…* banner at the top of the vault and a **Replace this vault?** dialog with **Reject** (the default) and **Erase and adopt**. Rejecting erases nothing; the source's next sync offers it again.

If an adoption fails after the vault was erased, the vault shows a blocked screen with the library's message, and adoption is not retried.

## Mirroring status

Each row on the Replicas tab shows a status tag and a line about what is mirrored:

| Tag | Meaning |
| --- | --- |
| **Pending confirmation** | Waiting for this device to confirm the fingerprint. |
| **Verified** | Confirmed; mirroring. |
| **Syncing…** | A destination still fetching the source's copy. It keeps asking until the source answers. |
| **Behind** | The member last acknowledged an older version than this vault holds. |
| **Codes didn't match** / **Adoption declined** / **Expired** | Nothing is pending; pair again to retry. |
| **Group member** | A member of the group this device has no channel with (for example a second destination of the same source). Only removal is offered. |

On a source, the line reads *Mirrored vN, acknowledged …* or *Behind: last mirrored vN … Use "Sync now"*. On a destination that adopted, *This vault is …'s, at vN. Versions … publishes are applied here automatically.*

## Sync now and Check sync

- **Sync now** (per row) publishes the current vault to that member now. Use it after a member was offline: a missed mirror is not retried on its own. Only one sync runs at a time.
- **Check sync** (section header) asks the group which version each member holds, and catches this device up if it is behind.
- **Go Offline** / **Go Online** (rows backed by a hosted helper) suspend or resume delivery to it, to observe a missed mirror.

## Conflicts

A conflict means two members hold **different copies of the same version**, for example both published while apart, or one was offline while another published. When this device detects one, it **must not publish again** until the conflict is resolved: a further version would replace every other member's copy and lose its change.

- A warning stays at the top of the vault: *This vault has diverged from its replica group*.
- **Add Secret** and removing a secret are disabled, with the reason on hover. Pairing a helper and confirming a replica fingerprint, which would also publish, are refused with the same reason.

To resolve it:

1. **Get the group's copy** if the other copy has not arrived yet.
2. **Resolve…** lists every secret in either copy, all kept by default. For a secret changed in both, pick *This device's*, the other member's, or *Neither*.
3. **Publish this version** publishes the merged bag once, as a new version that replaces both copies on every member and helper. The conflict also clears if another member publishes past it.

## Removing a member

| Action | Effect |
| --- | --- |
| **Forget** | Removes the row from **this device's list only**. The peer is not told and the protocol keeps mirroring to it. Use it for a row the protocol will not act on, such as a failed pairing. |
| **Remove from group** | The protocol's eviction, by replica id. Offered once the peer has announced its id. |

**Any member may remove any other, the source included**, with no role check; that is how a lost or stolen device is taken out of a group. The app always asks first. The removal is announced and carried by the next published roster; if the vault holds no secret yet, it completes on the next publish.

Removing the **source** promotes the first remaining member in this device's replica list to source, possibly this device.

## What the removed device sees

The removed member is not asked and gets no warning. When it sees a roster without itself, the protocol on that device erases its whole copy of the vault: secrets, helper channels and shares. The app then shows *This vault was removed from its replica group by another member…* and the vault holds nothing. The secret survives on the remaining members and the helpers. To come back, the device must be paired and mirrored again.
