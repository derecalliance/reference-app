# Getting started

A first walk through the app, from an empty browser to a recovered secret. It takes about fifteen minutes and assumes the node is already running.

If it is not, run `./start.sh` from the repository root and open the address it prints, usually `http://localhost:5000`. See [Running the app](14-running-the-app.md) for the other ways to start it.

## 1. Fill the participant pool

Setting up a vault never creates helpers. They belong to the node, so create them first.

- Open **Participants** in the left navigation and click **Provision up to 7**.
- You should see seven rows, each with Transport `http` and Status `online`.

Seven is the node's default `participant_count`. More in [Participants](10-participants.md).

## 2. Set up a vault

- Open **Owner** and click **Set up a new vault**.
- **Your name**: type a name, for example `Alice`, then **Next →**.
- **Your settings**: keep the defaults. *Protocol timeout* is 300 seconds and *Pre-pair locally* is 3, which pairs three helpers for you without exchanging QR codes.
- Click **Set up**. A *Setting up* screen pairs the three helpers, then the vault page opens.

A yellow banner, *Only 3 of 5 recommended participants paired*, is expected. Every field is described in [Setting up a vault](02-setting-up-a-vault.md).

## 3. Look at the Channels tab

- **Channels** lists the three pre-paired helpers. Each row has a *Helper* role tag, an `HTTPS` transport badge and *Shares 0*.
- The side panel, **Pair with a participant**, lists the whole pool. Expand a row that reads *Available*, keep *Inline keys* and click **Pair**. It turns *Paired* and appears under Channels.
- Pair one more so the banner goes away.

Contact modes, QR codes and pairing between two browsers are covered in [Pairing](03-pairing.md).

## 4. Add a first secret

- Click **Add Secret** in the vault header, enter a name and some data, then click **Add Secret**.
- The progress dialog lists every helper. Each goes from *Waiting…* to *Confirmed*. When all have answered, the button reads **Done**.
- The **Secrets** tab now shows the bag with a version tag such as `v1` and the threshold.

What a round is, and what happens when helpers do not answer: [Protecting secrets](04-protecting-secrets.md).

## 5. Verify the shares

- In **Secrets**, click **Verify Shares**.
- Each row should turn *Verified*, and the card should read *5/5 verified*.

See [Verification](05-verification.md).

## 6. Recover on a "new device"

Use an incognito window or a second browser profile at the same address. It has its own storage, so it behaves like another device.

- Set up a vault there, with **Pre-pair locally** set to `0`.
- In the side panel, **Pair** with three or more of the helpers that hold Alice's shares (the names on Alice's Channels tab).
- For each one, expand its row, click **Link** and pick the channel whose peer is Alice. This tells the helper the new channel belongs to an owner it already helps.
- Open **Recovery**, click **Discover All**, then **Recover** on the newest version under *Available Secrets*.
- Under *Recovered Secrets*, reveal the value to check it, click **Recover** and confirm with **Recover from bag**.

The new vault now holds the secret and the helper channels. Details in [Recovery and restore](06-recovery-and-restore.md).

## 7. Where to go next

- Mirror the vault to a second device: [Replicas](07-replicas.md).
- Run several vaults in one browser: [Multiple vaults and tabs](08-multiple-vaults-and-tabs.md).
- Use a phone on your network: [Running the app](14-running-the-app.md).
- Change a node setting: [Node configuration](15-node-configuration.md) and [Settings](11-settings.md).
- Watch the protocol traffic: [Inspect and Console](12-inspect-and-console.md).

## When something looks wrong

- Read [Troubleshooting](16-troubleshooting.md). It lists the messages the app shows and what to do about each.
- Expand the **Console** at the bottom of the page. It shows every step this page took and every message the node delivered.
- Open `/api/v1/debug/state` on the node, for example `http://localhost:5000/api/v1/debug/state`, to see every actor and route the server knows.
