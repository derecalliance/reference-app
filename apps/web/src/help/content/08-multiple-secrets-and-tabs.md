# Multiple secrets and tabs

Running several secrets in one browser: the secret list, the switcher, one tab per secret, Leave, Reset browser data, and the claim warnings.

## The secret list

The Owner section opens on `#/`, the list of every secret saved in this browser.

| Column | Shows |
| --- | --- |
| **Secret** | Its name, suffixed with the start of its id when two share a name, and a chip such as *1 needs your decision*. |
| **Status** | *Starting…*, *Running*, *Stopped*, *Failed to start* (with the reason), *Open in another tab*, or *Blocked*. |
| **Paired**, **Bag**, **Replicas** | Paired channels, current bag version, replica count. Hidden on narrow screens. |

Row actions: **Open**, **Claim** (open in another tab), **Retry** (failed), **Remove** (failed or stopped; confirmed first).

**One tab runs every secret it holds at once.** A secret that is not on screen keeps polling and answering its peers. When one needs a decision (an incoming request, an adoption), the list marks it and the header shows *N other secrets need your decision*.

## Header controls

| Control | Effect |
| --- | --- |
| **Secret switcher** | Jump to another secret. |
| **All secrets** | Back to the list. The secret keeps running. |
| **Leave** | Choose **Stop running here** (the secret stays saved and another tab can open it) or **Remove from browser** (erases its keys, channels and shares from this browser). |
| **Reset browser data** | Erases every secret, pairing, protocol key and saved Settings override in this browser, in every tab of the app, then reloads. |
| **Theme** (sun / moon) | Switches between the dark and light themes. Until you pick one the app follows your system's setting; a pick is remembered in this browser, applies to every tab, and is cleared by Reset browser data. |

On narrow screens all but the theme toggle, the bell and the switcher fold into the ⋮ menu. None of them touches the actors on the node: a removed secret's owner actor stays registered.

## One tab per secret

Two tabs driving one secret would split its mailbox: each would drain messages the other never sees. So each secret is held with an exclusive **Web Lock**, released when its tab closes or crashes.

- A secret running in another tab is listed as *Open in another tab*. Opening it shows *"…" is open in another tab… Close it there, then claim it here.* **Claim** works once the other tab has let it go.
- On a page that is not a secure context (plain `http://` on a LAN address), Web Locks are unavailable. The list then warns that one tab per secret is only best-effort. Serve the app over https or open it at `localhost` for full protection.

## Separate devices

Secrets in one browser share its storage, so a second secret in the same browser is not a second device. To model another device (a replica, a browser-to-browser peer, a recovering owner), use a separate browser context: another profile, an incognito window, another browser or another machine.

## Claim warnings

**Claim an existing actor** (see [Setting up a secret](02-setting-up-a-secret.md)) takes over an owner actor's mailbox on the node. If the node saw that mailbox drained in the last 30 seconds, it warns *This owner looks active in another browser* and requires *Claim it anyway*: two devices on one mailbox both miss messages.

## Console filter

With several secrets, the Console's filter shows *All secrets*, one secret, or *Node only*. See [Inspect and Console](12-inspect-and-console.md).
