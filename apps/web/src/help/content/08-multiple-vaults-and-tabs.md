# Multiple vaults and tabs

Running several vaults in one browser: the vault list, the switcher, one tab per vault, Leave, Reset browser data, and the claim warnings.

## The vault list

The Owner section opens on `#/`, the list of every vault saved in this browser.

| Column | Shows |
| --- | --- |
| **Vault** | Its name, suffixed with the start of its id when two share a name, and a chip such as *1 needs your decision*. |
| **Status** | *Starting…*, *Running*, *Stopped*, *Failed to start* (with the reason), *Open in another tab*, or *Blocked*. |
| **Paired**, **Bag**, **Replicas** | Paired channels, current bag version, replica count. Hidden on narrow screens. |

Row actions: **Open**, **Claim** (open in another tab), **Retry** (failed), **Remove** (failed or stopped; confirmed first).

**One tab runs every vault it holds at once.** A vault that is not on screen keeps polling and answering its peers. When one needs a decision (an incoming request, an adoption), the list marks it and the header shows *N other vaults need your decision*.

## Header controls

| Control | Effect |
| --- | --- |
| **Vault switcher** | Jump to another vault. |
| **All vaults** | Back to the list. The vault keeps running. |
| **Leave** | Choose **Stop running here** (the vault stays saved and another tab can open it) or **Remove from browser** (erases its keys, channels and shares from this browser). |
| **Reset browser data** | Erases every vault, pairing, protocol key and saved Settings override in this browser, in every tab of the app, then reloads. |

On narrow screens these fold into the ⋮ menu. None of them touches the actors on the node: a removed vault's owner actor stays registered.

## One tab per vault

Two tabs driving one vault would split its mailbox: each would drain messages the other never sees. So each vault is held with an exclusive **Web Lock**, released when its tab closes or crashes.

- A vault running in another tab is listed as *Open in another tab*. Opening it shows *"…" is open in another tab… Close it there, then claim it here.* **Claim** works once the other tab has let it go.
- On a page that is not a secure context (plain `http://` on a LAN address), Web Locks are unavailable. The list then warns that one-tab-per-vault is only best-effort. Serve the app over https or open it at `localhost` for full protection.

## Separate devices

Vaults in one browser share its storage, so a second vault in the same browser is not a second device. To model another device (a replica, a browser-to-browser peer, a recovering owner), use a separate browser context: another profile, an incognito window, another browser or another machine.

## Claim warnings

**Claim an existing actor** (see [Setting up a vault](02-setting-up-a-vault.md)) takes over an owner actor's mailbox on the node. If the node saw that mailbox drained in the last 30 seconds, it warns *This owner looks active in another browser* and requires *Claim it anyway*: two devices on one mailbox both miss messages.

## Console filter

With several vaults, the Console's filter shows *All vaults*, one vault, or *Node only*. See [Inspect and Console](12-inspect-and-console.md).
