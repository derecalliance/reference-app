// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { Page } from '@playwright/test'

import { test, expect } from './fixtures'
import {
  actorIdFor,
  discoverAll,
  linkToPreviousOwner,
  newOwnerContext,
  openTab,
  pairParticipant,
  participantIndex,
  participantName,
  protectAndReadConfirmations,
  protectSecret,
  recoverOfferedSecret,
  restoreRecoveredBag,
  setFixedThreshold,
  setOffline,
  setUpOwner,
  tabCount,
  uniqueReplicaName,
} from './app'

/**
 * Weighted helpers (SDK 0.0.9): the threshold counts subshares, and a helper
 * can hold more than one.
 *
 * The visible consequence is the one asserted: with a threshold of 3 and one
 * helper weighted 2, two helpers are enough to publish — so a version still
 * commits with the third helper offline, where unweighted it would need all
 * three. And the weight sticks: the library stores it, and every later
 * publish has to carry it, or it resets to 1.
 */

/**
 * Give `helper` weight `weight` on the Channels tab, then apply it with
 * Republish — which publishes with the Channels tab's threshold and weights —
 * and wait for the publish that carries it to settle.
 */
async function setWeight(page: Page, helper: string, weight: number, expectedTotal: string): Promise<void> {
  await openTab(page, 'Channels')
  await page.getByLabel(`Weight for ${helper}`).fill(String(weight))

  await openTab(page, 'Items')
  await page.getByRole('button', { name: 'Republish…' }).click()
  const dialog = page.locator('.modal-overlay[aria-label="Republish"]')
  await expect(dialog).toContainText(`${helper} ×${weight}`)
  await expect(dialog).toContainText(expectedTotal)
  await dialog.getByRole('button', { name: 'Republish', exact: true }).click()
  const done = dialog.getByRole('button', { name: 'Done' })
  await expect(done).toBeVisible({ timeout: 90_000 })
  await expect(dialog).toContainText(`${helper} ×${weight}`)
  await done.click()
}

test('a heavier helper lets fewer helpers meet the threshold, and keeps its weight', async ({ page, pageErrors }) => {
  test.setTimeout(300_000)

  await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 3 })
  await setFixedThreshold(page, 3)
  await pairParticipant(page, { index: 0, mode: 'Inline keys' })
  await pairParticipant(page, { index: 1, mode: 'Inline keys' })
  await pairParticipant(page, { index: 2, mode: 'Inline keys' })
  await protectSecret(page, 'Passphrase', 'hunter2')

  const heavy = await participantName(page, 0)
  const offline = await participantName(page, 2)

  // Weight the first helper 2 — a publish of the current bag.
  await setWeight(page, heavy, 2, 'Threshold 3 of 4 subshares across 3 helpers')

  const offlineId = await actorIdFor(page, offline)
  await setOffline(page, offlineId, true)
  try {
    // 2 + 1 subshares from the two helpers still answering meet the threshold
    // of 3, so the version commits; the weight is the one set on the
    // Channels tab.
    const before = await tabCount(page, 'Items')
    const summary = await protectAndReadConfirmations(page, 'Recovery code', '123456')
    expect(summary).toContain('2 of 3 confirmed')
    expect(summary).toContain(`${heavy} ×2`)
    expect(summary).not.toContain('rolled back')
    await expect.poll(() => tabCount(page, 'Items'), { timeout: 120_000 }).toBeGreaterThan(before)
  } finally {
    await setOffline(page, offlineId, false)
  }

  expect(pageErrors).toEqual([])
})

/**
 * The weight travels in the recovered roster: `restore` writes it into the
 * new device's channel records, and the new device's next publish keeps it —
 * without anyone setting it again. A device that lost it would publish every
 * helper at 1, silently undoing the owner's choice.
 */
test('a restored secret keeps the weights it was protected with', async ({ page, browser, pageErrors }) => {
  test.setTimeout(480_000)

  // Unique: helpers are shared across specs, and the link picker tells this
  // owner's old channel from others' by its peer name.
  const oldDevice = uniqueReplicaName('Alice')
  await setUpOwner(page, { name: oldDevice, participants: 3, prePaired: 0, minParticipants: 3 })
  await setFixedThreshold(page, 3)
  const helpers: string[] = []
  for (let i = 0; i < 3; i++) helpers.push(await participantName(page, i))
  for (const helper of helpers) {
    await pairParticipant(page, { index: await participantIndex(page, helper), mode: 'Inline keys' })
  }
  await protectSecret(page, 'Passphrase', 'hunter2')
  const heavy = helpers[0]
  await setWeight(page, heavy, 2, 'Threshold 3 of 4 subshares across 3 helpers')

  // The old device is lost.
  await page.close()

  const fresh = await newOwnerContext(browser, {
    name: uniqueReplicaName('Alice-new'),
    participants: 3,
    prePaired: 0,
    minParticipants: 3,
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

    // A publish that names no weights: what it sends is what `restore` stored.
    const summary = await protectAndReadConfirmations(newDevice, 'After restore', 'still-weighted')
    expect(summary).toContain('3 of 3 confirmed')
    expect(summary).toContain(`${heavy} ×2`)
  } finally {
    await fresh.context.close()
  }
  expect(pageErrors).toEqual([])
})

