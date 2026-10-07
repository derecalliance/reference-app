# Setting up a vault

Every step and field of the setup wizard, what setup actually does on the node, and the "Claim an existing actor" shortcut.

## Where it starts

The **Owner** section opens on the vault list (`#/`). With no vault saved it reads *Get started*. Two buttons start the wizard:

| Button | Route | What it does |
| --- | --- | --- |
| **Set up a new vault** | `#/new` | Registers a new owner actor. |
| **Claim an existing actor** | `#/new/claim` | Takes over an existing owner actor's mailbox instead. A testing shortcut, described below. |

When the wizard opens it asks the node for its defaults (`GET /api/v1/config`) and counts the participants online. If the node does not answer, a notice reads *Can't reach the DeRec server* with a **Retry** button. Nothing is blocked, but setup cannot finish until the node answers.

## Step 1: Your name

The name this owner uses on this device and shows to peers.

- 1 to 64 characters, counted after trimming and Unicode normalisation (NFC). Control characters are refused.
- Enter advances to the next step.
- A name another vault in this browser already uses is allowed, with a warning: the vault list then tells them apart only by the start of their ids.

The name can be changed later with **Edit Identity**. See [Identity and addresses](09-identity-and-addresses.md).

## Step 2: Your settings

Only the settings that belong to this owner. Pool size, transport mix, threshold and protocol policy belong to the node and are set under [Settings](11-settings.md).

| Field | Default | Range | Effect |
| --- | --- | --- | --- |
| **Protocol timeout (seconds)** | The node's `protocol_timeout_secs` (300), or your Settings override | 10 or more, in steps of 30 | The single timeout this vault uses. The protocol drops expired messages and stale rounds with it, and the app uses it as its deadline for pairing waits, verification and unconfirmed replica channels. Stored on the vault only if you change it. |
| **Pre-pair locally** | The node's `pre_paired_count` (3), or your Settings override | 0 to the number of participants online | Pairs this many pool helpers automatically after setup, skipping the QR exchange. A testing shortcut. Offline participants are skipped. |

Both values show `…` and cannot be changed until the node has answered. The hint under *Pre-pair locally* says why it may be capped:

- *No participants are online on this node — provision some under Participants.*
- *Could not read the participant pool, so pre-pairing is off. Pair from the owner page instead.*

The vault's **threshold** is not asked for here. It is the *Minimum* from Settings at the moment of setup, and it is frozen into the vault. If that value cannot protect a secret (below 2), the step shows *The minimum in Settings (…) cannot protect a secret: … Fix it under Settings first.* and **Set up** stays disabled.

## What "Set up" does

1. Registers an owner actor on the node (`POST /api/v1/owners`) under the name you typed.
2. Reads the participant pool. **It provisions nothing.** Growing the pool is an operator action under [Participants](10-participants.md).
3. Clamps *Pre-pair locally* to the participants still online, in case one was deleted or taken offline while the wizard was open.
4. Opens the vault. While pre-pairing runs, a **Setting up** screen shows *Pairing N participants…* and a row per helper.

If another tab of this browser took the new vault first, the wizard says *"…" could not be opened — it is already open in another tab.*

## On the vault page

Two banners tell you whether the vault can protect a secret yet:

- *Secret protection is disabled — X of N required participants paired.* Fewer helper channels than the threshold. **Add Secret** is disabled.
- *Only X of R recommended participants paired. Consider pairing more before protecting secrets.* Advisory only.

## Claim an existing actor

A testing shortcut that adopts an existing owner actor's mailbox instead of registering a new one. **Recovery does not need it**: a recovering owner sets up a new vault and re-pairs (see [Recovery and restore](06-recovery-and-restore.md)).

| Field | What to enter |
| --- | --- |
| **Recover as which owner?** | Pick one of the owner actors listed on the node, or paste its actor id (a UUID; Inspect lists them). |
| **Shares needed to recover (threshold)** | The threshold the original vault used. The node does not record it, so it is prefilled with the node's default; change it if the vault used another. At least 2. |

- If the node saw that actor's mailbox drained in the last 30 seconds, a warning says *This owner looks active in another browser*. Claiming anyway means two devices drain one mailbox and each misses messages the other takes; tick *Claim it anyway* to proceed.
- The claimed actor's existing name is kept.
- There is no settings step. The vault starts with every helper on the node listed as available, and you pair with them manually.
