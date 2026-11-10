// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { Page } from '@playwright/test'

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
  setUpOwner,
  uniqueReplicaName,
} from './app'

/**
 * Recover, then restore or join (SDK 0.0.9): when the recovered secret still
 * lives on a replica, the library recommends joining its group over restoring
 * next to it. Here the replica is a provisioned helper on this node, so
 * "Join through" pairs with it directly — the node mints its contact — and the
 * new device ends adopted with the secret, through the ordinary replica
 * fingerprint and adoption steps.
 */

function fingerprintDialog(page: Page, peerName: string) {
  return page.locator('[role="dialog"]').filter({ hasText: `Confirm “${peerName}”` })
}

// Blocked by the SDK (docs/sdk-0.0.9-weighted-helpers-report.md, R4-2): on an
// admission the member drops the pairing channel as it sends the handover, and
// a joiner that has not confirmed the fingerprint yet ignores that handover —
// its catch-up then goes to a channel nobody owns. Every app step up to that
// point is exercised and passes; un-fixme once the SDK keeps the handover
// reachable.
test.fixme('a recovered secret with a live replica is joined rather than restored', async ({ page, browser, pageErrors }) => {
  test.setTimeout(480_000)

  const oldDevice = uniqueReplicaName('Alice')
  const replica = uniqueReplicaName('Replica')

  await setUpOwner(page, { name: oldDevice, participants: 3, prePaired: 0, minParticipants: 2 })
  const helpers: string[] = []
  for (let i = 0; i < 2; i++) helpers.push(await participantName(page, i))
  for (const helper of helpers) {
    await pairParticipant(page, { index: await participantIndex(page, helper), mode: 'Inline keys' })
  }
  await addAndPairReplica(page, replica)
  await protectSecret(page, 'Passphrase', 'hunter2')
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

    // The recovered secret names a live replica: Join is offered next to Restore.
    await newDevice.getByRole('button', { name: 'Join group…' }).click()
    const join = newDevice.locator('.modal-overlay[aria-label="Join the replica group"]')
    await expect(join).toContainText(replica)
    await expect(join).toContainText('do not restore')
    await join.getByRole('button', { name: `Join through ${replica}` }).click()
    await expect(join).toBeHidden({ timeout: 60_000 })

    // The ordinary destination steps: compare the code, then adopt.
    const dialog = fingerprintDialog(newDevice, replica)
    await dialog.getByRole('button', { name: 'Codes match' }).click({ timeout: 120_000 })
    await expect(dialog).toContainText('Confirming adopts')
    await dialog.getByRole('button', { name: 'Adopt and confirm' }).click()
    await expect(dialog).toContainText('Confirmed on this device', { timeout: 60_000 })
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })

    // Adopted: the secret is this device's now.
    await expect
      .poll(
        async () => {
          await openTab(newDevice, 'Items')
          return newDevice.locator('.tab-panel').innerText()
        },
        { timeout: 120_000 },
      )
      .toContain('Passphrase')
  } finally {
    await fresh.context.close()
  }
  expect(pageErrors).toEqual([])
})
