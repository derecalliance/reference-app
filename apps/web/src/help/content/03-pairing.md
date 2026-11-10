# Pairing

How to pair a secret with helpers and with other browsers: who initiates, the three contact modes, QR codes, fingerprint confirmation, incoming requests and unpairing.

## Who initiates

Pairing is **unidirectional**. One side shares a **contact** (a QR code or its JSON payload). The other side reads it and **initiates**, declaring its own role; the side that shared the contact takes the complement. A contact carries no role, so nothing is inferred from it.

The contact mode is fixed when the contact is created, so **whoever creates the contact chooses the mode**.

A contact is good for **30 minutes** (SDK 0.0.11 gives pairing a lifetime; its default of 30 seconds is too short for copying a contact between windows, so this app sets its own). After that, reading it fails with *This contact has expired*, and a pairing request on it is ignored by the side that created it. Share a fresh contact. The contact a secret publishes for other browsers on this node is renewed on its own every 15 minutes.

## Pairing with a helper on this node

The side panel, **Pair with a participant**, lists the node's provisioned helpers. Expand a row for its actions:

| Action | What happens |
| --- | --- |
| **Pair** | The helper mints a contact in the selected contact mode and this secret's owner initiates as **Owner**. The usual way to add a helper. |
| **Let them initiate** | Paste your own contact (from the header's **Share Contact**) and the helper initiates. You pick the helper's role: *Helper* (default, it holds a share for you) or *Owner* (it protects a secret and you hold a share). |
| **Share Contact** | Shows the helper's contact, to pair it from another device or browser. |
| **Link** | Shown once paired. Tells the helper this channel belongs to an owner it already helps. Used in [recovery](06-recovery-and-restore.md). |
| **Confirm fingerprint** | Shown while a *No keys* channel is unconfirmed. |
| **Unpair** | Ends the pairing. |

Status tags on the row: *Available*, *Paired*, *Unconfirmed* (handshake done, fingerprint not yet confirmed), *Offline* (taken offline under Participants), *Removed from node* (gone from the node's roster; the node only deletes a participant no owner is paired with, so this means it was removed by hand or by an older build), *Unpairing…*.

If a helper advertises only gRPC and the node's relay is off, **Pair** is disabled with the reason. See [Transports](13-transports.md).

## Pairing with another browser

Use the two buttons in the secret's header:

- **Share Contact** shows this secret's contact as a QR code, with **Copy** buttons for the *QR Payload* (JSON) and *Raw Bytes (hex)* — the contact's protobuf `ContactMessage` bytes, the form other DeRec implementations exchange — and the transport it advertises. Changing the contact mode mints a new contact; the previous one becomes stale and is cleaned up.
- **Pair** takes the peer's contact. Paste it — the JSON payload, or the raw protobuf bytes as hex or base64, which is how a contact from another implementation (or from `POST /api/v1/actors/{id}/contact` with `Accept: application/octet-stream`) usually arrives — or click **Scan QR** where the browser supports it. Pick **your** role from *Owner*, *Helper*, *Replica source* or *Replica destination*; the dialog says what the other side becomes. Click **Pair as …**.

Picking *Replica destination* first asks for consent, because that side's secret is replaced. See [Replicas](07-replicas.md).

After **Pair as …**, the dialog waits for the peer:

- *Pairing Complete* when the handshake finishes.
- *The peer rejected the pairing request.*
- *Pairing request timed out. The peer may not have responded.* after the protocol timeout.

## Contact modes

| Mode | What the contact carries | Usable |
| --- | --- | --- |
| **Inline keys** (default) | The initiator's public keys. | Immediately. |
| **Hashed keys** | A SHA-384 commitment to the keys. The scanner fetches the real keys and checks them against it; a mismatch aborts the handshake. | Immediately. |
| **No keys** | Only the channel id, a six-digit nonce and the endpoint, short enough to read aloud. Nothing binds the keys to the contact. | Only after **both** sides confirm a fingerprint. |

## Fingerprint confirmation (No keys)

A *No keys* channel finishes its handshake in the protocol's `Pending` state. Until both sides confirm, it holds no shares, ignores anything sent on it, and is left out of the Channels tab and of every count.

- A dialog, **Confirm "…"**, opens on its own. It shows a code like `ABCD-EFGH-IJKL-MNOP` derived from the shared key. For a helper on this node it shows both sides' codes.
- **Codes match** confirms this device's side. The peer confirms on its own screen (a hosted helper confirms itself).
- **Doesn't match** leaves the channel unusable. (From SDK 0.0.10 a mismatch the library itself detects also deletes the pending pairing and its key.) Different codes mean something sat between the two devices during pairing: pair again over a channel you trust, or use inline or hashed keys.
- Closing the dialog writes nothing. Reopen it with **Confirm fingerprint** on the row. An unconfirmed channel is dropped after the protocol timeout.

## Scanning a QR code

**Scan QR** appears only when all of these hold. Otherwise the field reads *Scanning unavailable*, with the reason on hover, and pasting still works.

- The page is a secure context: `localhost`, `https://`, or an origin the browser was told to treat as secure. Plain `http://` on a LAN address is not. See [Running the app](14-running-the-app.md).
- The browser has `BarcodeDetector` with QR support (Chromium-based browsers; not Firefox or Safari at the time of writing).
- The device has a camera.

## Incoming requests

When another secret's owner pairs with yours, a dialog asks first. Incoming pairing requests are never accepted automatically.

- **Incoming Pairing Request**: *Reject*, *Accept*, or *Link to existing*. *Link to existing* accepts and links the new channel to one you already have, so a recovering owner inherits the shares you hold for them. It is offered when the authentication method is `user` and you have another paired channel.
- **Incoming replica pairing request**: a separate dialog that says which side you would be. See [Replicas](07-replicas.md).

## Unpairing

Only the **owner** side of a channel can unpair it. On a channel where this secret's owner is the helper, the row reads *Only the owner can unpair*.

- **Unpair** asks for confirmation. With the secret's unpair acknowledgement set to *Required* the channel is torn down after the peer acknowledges, and the dialog waits with *Unpairing…*; with *Not required*, the default, it is torn down at once.
- Unpairing a helper that holds a share publishes a new version to the remaining helpers (see [Unpairing a helper publishes a new version](04-protecting-secrets.md#unpairing-a-helper-publishes-a-new-version)), so **Unpair** waits, disabled, while a round is open.
- If the peer never answers, the dialog says *Unpair did not go through* and offers **Try again** or **Forget this channel…**, which drops the channel, its key and its shares from this device only, without telling the peer.
- An incoming unpair is accepted quietly, or shown as *Incoming Unpair Request*, depending on the secret's Settings tab → *Incoming unpair requests*.
