// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { test, expect } from './fixtures'
import {
  addAndPairReplica,
  discoverAll,
  linkToPreviousOwner,
  newOwnerContext,
  openTab,
  pairParticipant,
  participantIndex,
  participantName,
  protectSecret,
  recoverOfferedSecret,
  replicaChannelCount,
  replicaChannelRow,
  restoreRecoveredBag,
  setUpOwner,
  tabCount,
  uniqueReplicaName,
  unpairParticipant,
} from './app'

/**
 * The flows that make protecting a secret worth doing: getting it back, and
 * taking a helper out of the set that holds it.
 *
 * These are the point of the protocol, and until now the only coverage they had
 * was unit-level. Recovery in particular exercises the longest path in the
 * library — discovery, share retrieval, reconstruction, and the `restore` that
 * rebuilds the `secret_id` namespace from the recovered roster.
 */

test.describe('recovery', () => {
  test('a protected secret can be discovered and reconstructed', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })
    await protectSecret(page, 'Passphrase', 'hunter2')

    // Discovery is a real round trip, not a local read: each helper answers
    // with the versions it is actually holding for this secret.
    await discoverAll(page)
    await expect(page.locator('.tab-panel')).toContainText('v1')

    await recoverOfferedSecret(page)

    // Reconstructed from the helpers' shares, and it is the secret that was
    // protected — not merely "a recovery completed".
    await expect(page.locator('.tab-panel')).toContainText('Passphrase')
    expect(await tabCount(page, 'Recovery')).toBeGreaterThan(0)
    expect(pageErrors).toEqual([])
  })

  test('recovery finds every version the helpers hold', async ({ page }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })

    await protectSecret(page, 'Passphrase', 'hunter2')
    await protectSecret(page, 'Recovery code', '123456')

    await discoverAll(page)
    await recoverOfferedSecret(page)

    // The bag is recovered whole, so both secrets come back together — a
    // recovery that returned only the newest entry would still pass a
    // "something was recovered" assertion.
    await expect(page.locator('.tab-panel')).toContainText('Passphrase')
    await expect(page.locator('.tab-panel')).toContainText('Recovery code')
  })

  test('restoring from a recovered bag rebuilds this device from it', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })
    await protectSecret(page, 'Passphrase', 'hunter2')

    await discoverAll(page)
    await recoverOfferedSecret(page)

    // Recovering reconstructs the bag; *restoring* is the separate, explicit
    // step that commits it into this device's canonical state via
    // `protocol.restore`, and announces the new endpoint to the helpers with
    // `UpdateChannelInfo`. It is the most destructive action in the app, so it
    // sits behind a confirmation whose default is Cancel.
    const restore = page.getByRole('button', { name: 'Recover', exact: true }).last()
    await restore.click()

    const dialog = page.locator('.modal-overlay').filter({ hasText: 'Recover from this bag?' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Recover from bag' }).click()

    // Back on a working vault: the restored bag is this device's own.
    //
    // The tab is re-opened on every poll rather than once up front. `restore`
    // rebuilds this device's state and lands it on a tab of its own choosing,
    // so a single click placed before that completes gets overridden — the
    // assertion then reads whichever panel restore settled on. Re-clicking
    // converges whatever the ordering.
    await expect
      .poll(
        async () => {
          await openTab(page, 'Secrets')
          return page.locator('.tab-panel').innerText()
        },
        { timeout: 120_000 },
      )
      .toContain('Passphrase')

    // Restoring on the device that protected the bag keeps its helpers: the
    // channels the snapshot names are the very ones this device held, so
    // retiring them as "recovery channels" told the helpers to drop their
    // channels and shares, and the next protect reached nobody (0 of 2,
    // rolled back). A new version must reach them and commit.
    await openTab(page, 'Channels')
    expect(await tabCount(page, 'Channels')).toBe(2)
    await protectSecret(page, 'After restore', 'still-reachable')
    await openTab(page, 'Secrets')
    await expect(page.locator('.tab-panel')).toContainText('After restore')
    await expect(page.locator('.tab-panel')).toContainText('Passphrase')
    expect(pageErrors).toEqual([])
  })

  test('cancelling the restore confirmation changes nothing', async ({ page }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })
    await protectSecret(page, 'Passphrase', 'hunter2')

    await discoverAll(page)
    await recoverOfferedSecret(page)

    const before = await tabCount(page, 'Channels')
    await page.getByRole('button', { name: 'Recover', exact: true }).last().click()

    const dialog = page.locator('.modal-overlay').filter({ hasText: 'Recover from this bag?' })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()

    // Nothing was replaced, unlinked, or left mid-restore.
    expect(await tabCount(page, 'Channels')).toBe(before)
  })
})

test.describe('restoring a vault that has a replica', () => {
  /**
   * On a new device: the device-loss path the replica exists for. The old device protected a
   * bag mirrored to a hosted replica; a new one pairs the same helpers, has
   * each link the new channel to the old owner, recovers, and restores.
   *
   * Restoring used to keep the new device's own replica id, which the
   * recovered group does not name, so every publish after it failed with
   * "replica group has members but this device holds no row of its own" —
   * and the Replicas tab read "No replicas yet" while the replica was still a
   * member.
   */
  test('restoring on the same device keeps its replica listed, and mirroring', async ({ page, pageErrors }) => {
    test.setTimeout(360_000)
    const replica = uniqueReplicaName('Replica')

    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })
    await addAndPairReplica(page, replica)
    await protectSecret(page, 'Passphrase', 'hunter2')
    await openTab(page, 'Replicas')
    await expect(page.getByText(/Mirrored v\d+, acknowledged/)).toHaveCount(1, { timeout: 90_000 })
    expect(await tabCount(page, 'Replicas')).toBe(1)

    await discoverAll(page)
    await recoverOfferedSecret(page)
    await restoreRecoveredBag(page, 'Passphrase')

    // It used to drop to "No replicas yet" here, while the replica stayed a
    // member and kept acknowledging every round.
    await openTab(page, 'Replicas')
    await expect(replicaChannelRow(page, replica)).toBeVisible({ timeout: 30_000 })
    expect(await tabCount(page, 'Replicas')).toBe(1)

    await protectSecret(page, 'After restore', 'still-mirrored')
    await openTab(page, 'Replicas')
    expect(await tabCount(page, 'Replicas')).toBe(1)
    await expect(page.getByText(/Mirrored v\d+, acknowledged/)).toHaveCount(1, { timeout: 90_000 })
    expect(pageErrors).toEqual([])
  })

  test('the restored vault publishes, and still lists its replica', async ({ page, browser, pageErrors }) => {
    test.setTimeout(480_000)

    // Unique names: helpers are shared by every spec in the run, and the link
    // picker tells this owner's old channel from others' by its peer name.
    const oldDevice = uniqueReplicaName('Alice')
    const replica = uniqueReplicaName('Replica')

    await setUpOwner(page, { name: oldDevice, participants: 3, prePaired: 0, minParticipants: 2 })
    const helpers: string[] = []
    for (let i = 0; i < 3; i++) helpers.push(await participantName(page, i))
    for (const helper of helpers) {
      await pairParticipant(page, { index: await participantIndex(page, helper), mode: 'Inline keys' })
    }
    await addAndPairReplica(page, replica)
    await protectSecret(page, 'Passphrase', 'hunter2')
    // The replica holds the version, so the recovered roster carries the group.
    await openTab(page, 'Replicas')
    await expect(page.getByText(/Mirrored v\d+, acknowledged/)).toHaveCount(1, { timeout: 90_000 })

    // The old device is lost.
    await page.close()

    const fresh = await newOwnerContext(browser, {
      name: uniqueReplicaName('Alice-new'),
      participants: 3,
      prePaired: 0,
      minParticipants: 2,
    })
    const newDevice = fresh.page
    try {
      for (const helper of helpers) {
        await pairParticipant(newDevice, { index: await participantIndex(newDevice, helper), mode: 'Inline keys' })
        await linkToPreviousOwner(newDevice, helper, oldDevice)
      }
      await discoverAll(newDevice)
      await recoverOfferedSecret(newDevice)
      await restoreRecoveredBag(newDevice, 'Passphrase')

      // Listed as this device's own replica channel — not merely as a member
      // of a group this device is outside of, which is all it used to be.
      await openTab(newDevice, 'Replicas')
      await expect(replicaChannelRow(newDevice, replica)).toBeVisible({ timeout: 30_000 })
      expect(await replicaChannelCount(newDevice)).toBe(1)

      // The publish that used to fail on the invariant.
      await protectSecret(newDevice, 'After restore', 'still-mirrored')
      await openTab(newDevice, 'Secrets')
      await expect(newDevice.locator('.tab-panel')).toContainText('After restore')

      await openTab(newDevice, 'Replicas')
      expect(await tabCount(newDevice, 'Replicas')).toBe(1)
      await expect(replicaChannelRow(newDevice, replica)).toBeVisible()
      await expect(newDevice.getByText(/Mirrored v\d+, acknowledged/)).toHaveCount(1, { timeout: 90_000 })
    } finally {
      await fresh.context.close()
    }
    expect(pageErrors).toEqual([])
  })
})

test.describe('unpairing', () => {
  test('unpairing a helper tears the channel down on this side', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })
    await protectSecret(page, 'Passphrase', 'hunter2')

    expect(await tabCount(page, 'Channels')).toBe(2)

    const name = await unpairParticipant(page, 0)

    // The channel goes, and the participant returns to the pool as pairable —
    // it is the *channel* that was torn down, not the actor.
    await expect.poll(() => tabCount(page, 'Channels'), { timeout: 90_000 }).toBe(1)
    const row = page.locator('.side-participant-item')
      .filter({ has: page.locator('.side-participant-name', { hasText: new RegExp(`^${name}$`) }) })
    await expect(row.locator('.status-tag')).toHaveText('Available', { timeout: 60_000 })

    expect(pageErrors).toEqual([])
  })

  test('the secret survives losing one helper of two', async ({ page }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })
    await protectSecret(page, 'Passphrase', 'hunter2')

    await unpairParticipant(page, 0)
    await expect.poll(() => tabCount(page, 'Channels'), { timeout: 90_000 }).toBe(1)

    // Unpairing drops the shares held under that channel, but the owner's own
    // bag is not one of them.
    await openTab(page, 'Secrets')
    await expect(page.locator('.tab-panel')).toContainText('Passphrase')
  })
})
