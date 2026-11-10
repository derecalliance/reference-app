// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { Locator, Page } from '@playwright/test'

import { test, expect } from './fixtures'
import { actorIdFor, openTab, protectSecret, setOffline, setUpOwner } from './app'

/**
 * The owner's standing controls (SDK 0.0.9 share retention): the Settings tab
 * chooses which version helpers keep and when this device deletes old
 * verification copies, and how often shares are verified on their own.
 */

/** Open the Settings tab, let `edit` change it, and save. */
async function editSecretSettings(page: Page, edit: (form: Locator) => Promise<void>): Promise<void> {
  await openTab(page, 'Settings')
  const form = page.locator('form[aria-label="Secret settings"]')
  await edit(form)
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(form.getByText('Saved.', { exact: true })).toBeVisible()
}

/** Pick a settings option: its label is the hit target, the radio itself is hidden. */
async function choose(form: Locator, id: string): Promise<void> {
  await form.locator(`label[for="${id}"]`).click()
  await expect(form.locator(`#${id}`)).toBeChecked()
}

/** The versions the Verification Copies tab lists, i.e. those this device still holds copies of. */
async function versionsWithCopies(page: Page): Promise<string[]> {
  await openTab(page, 'Verification Copies')
  return page.locator('.tab-panel tbody .version-tag').allTextContents()
}

test('"choose at each publish" asks which version to keep, and automatic cleanup keeps only the newest copies', async ({ page, pageErrors }) => {
  test.setTimeout(300_000)

  await setUpOwner(page, { name: 'Alice', participants: 2, prePaired: 2, minParticipants: 2 })
  await protectSecret(page, 'First', 'one')
  await protectSecret(page, 'Second', 'two')
  await expect.poll(() => versionsWithCopies(page), { timeout: 60_000 }).toHaveLength(2)

  await editSecretSettings(page, async form => {
    await choose(form, 'vs-retention-select')
    await choose(form, 'vs-cleanup-auto')
    await choose(form, 'vs-cleanup-lastN')
    await form.locator('#vs-cleanup-n').fill('1')
  })

  // The publish dialog now offers the committed versions, and none, instead of
  // a legend; keep none of them.
  await page.getByRole('button', { name: 'Add Item', exact: true }).click()
  const form = page.locator('.modal-overlay[aria-label="Add item"] .modal')
  await expect(form).toContainText('Helpers keep this new version and at most one earlier version')
  await expect(form.locator('input[name="po-keep"]')).toHaveCount(3)
  await expect(form.locator('#po-keep-2')).toBeChecked()
  await form.locator('#po-keep-none').check()
  await form.locator('#ps-name').fill('Third')
  await form.getByLabel('Item data').fill('three')
  await form.getByRole('button', { name: 'Add Item', exact: true }).click()
  const overlay = page.locator('.modal-overlay[aria-label="Add item"]')
  await expect(overlay.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 90_000 })
  await overlay.getByRole('button', { name: 'Done' }).click()

  // Once the new version commits, "keep the last 1" deletes every earlier
  // version's copies without the owner deleting anything.
  await expect.poll(() => versionsWithCopies(page), { timeout: 120_000 }).toHaveLength(1)

  expect(pageErrors).toEqual([])
})

test('removing an earlier version drops it from the history and deletes its copies', async ({ page, pageErrors }) => {
  test.setTimeout(300_000)

  await setUpOwner(page, { name: 'Carol', participants: 2, prePaired: 2, minParticipants: 2 })
  await protectSecret(page, 'First', 'one')
  await protectSecret(page, 'Second', 'two')
  await expect.poll(() => versionsWithCopies(page), { timeout: 60_000 }).toEqual(['v2', 'v1'])

  await openTab(page, 'Items')
  await page.getByRole('button', { name: /Show Previous Versions/ }).click()
  await page.getByRole('button', { name: 'Remove v1', exact: true }).click()
  const dialog = page.locator('.modal-overlay[aria-label="Remove v1"]')
  await expect(dialog).toContainText('can still be recovered')
  await dialog.getByRole('button', { name: 'Remove v1', exact: true }).click()
  await expect(dialog).toBeHidden()

  await expect(page.getByRole('button', { name: /Show Previous Versions/ })).toBeHidden()
  expect(await versionsWithCopies(page)).toEqual(['v2'])
  expect(pageErrors).toEqual([])
})

test('periodic verification checks the shares on its own schedule', async ({ page, pageErrors }) => {
  // The shortest schedule is one minute, and the first check is one interval
  // after it is set.
  test.setTimeout(300_000)

  await setUpOwner(page, { name: 'Bob', participants: 2, prePaired: 2, minParticipants: 2 })
  await protectSecret(page, 'Passphrase', 'hunter2')
  await openTab(page, 'Items')
  const summary = page.locator('.verified-summary').first()
  await expect(summary).toHaveText('0/2 verified')

  await editSecretSettings(page, async form => {
    await form.locator('#vs-verify-auto').check()
    await form.locator('#vs-verify-every').fill('1')
    await form.locator('#vs-verify-unit').selectOption('minutes')
  })
  await openTab(page, 'Items')

  // Nobody presses Verify Shares.
  await expect(summary).toHaveText('2/2 verified', { timeout: 180_000 })
  await expect(page.getByText(/recoverable — 2 of 2 subshares verified/)).toBeVisible()

  // The run is announced and recorded, and nothing calls for attention.
  await expect(page.locator('.auto-verification-line--passed')).toContainText('Last automatic check of v1: passed', {
    timeout: 60_000,
  })
  await openTab(page, 'Notifications')
  await expect(page.locator('.tab-panel')).toContainText('Automatic verification of v1 passed')
  await expect(page.locator('.tab-panel')).toContainText('Automatic verification of v1 started')
  await expect(page.getByRole('button', { name: /^Notifications — 2 unread$/ })).toBeVisible()

  expect(pageErrors).toEqual([])
})

test('a failed automatic verification rings the bell until it is read', async ({ page, pageErrors }) => {
  // One interval to the run, then one more for the silent helper's report window.
  test.setTimeout(360_000)

  await setUpOwner(page, { name: 'Dave', participants: 2, prePaired: 2, minParticipants: 2 })
  await protectSecret(page, 'Passphrase', 'hunter2')
  // One of this secret's own helpers: the pool is shared, so a row by position
  // can be a helper some earlier test left behind, paired with nobody here.
  const silent = (
    await page
      .locator('.side-participant-item', { hasText: 'Paired' })
      .nth(1)
      .locator('.side-participant-name')
      .innerText()
  ).trim()
  const silentId = await actorIdFor(page, silent)

  await editSecretSettings(page, async form => {
    await form.locator('#vs-verify-auto').check()
    await form.locator('#vs-verify-every').fill('1')
    await form.locator('#vs-verify-unit').selectOption('minutes')
  })
  await setOffline(page, silentId, true)
  try {
    const bell = page.getByRole('button', { name: /^Notifications — \d+ unread, 1 critical$/ })
    await expect(bell).toBeVisible({ timeout: 240_000 })
    await expect(page.locator('.toast--error', { hasText: 'Automatic verification of v1 failed' })).toBeVisible()

    await openTab(page, 'Items')
    // Undeliverable or unanswered, depending on where the node drops it.
    await expect(page.locator('.auto-verification-line--failed')).toContainText(
      new RegExp(`${silent} (did not answer|could not be reached)`),
    )

    // Read from the bell: the secret's tab opens and the alarm stops.
    await bell.click()
    await page.getByRole('menuitem', { name: /Automatic verification of v1 failed/ }).first().click()
    await expect(page.locator('.tab-panel')).toContainText('Critical')
    await expect(page.getByRole('button', { name: /^Notifications( — \d+ unread)?$/ })).toBeVisible()
  } finally {
    await setOffline(page, silentId, false)
  }

  expect(pageErrors).toEqual([])
})

test('a round that rolls back holds publishing until it closes, then offers a retry', async ({ page, pageErrors }) => {
  // The round waits out the library's sharing-round timeout for the silent helper.
  test.setTimeout(360_000)

  await setUpOwner(page, { name: 'Erin', participants: 2, prePaired: 2, minParticipants: 2 })
  await protectSecret(page, 'First', 'one')
  const silent = (
    await page
      .locator('.side-participant-item', { hasText: 'Paired' })
      .nth(1)
      .locator('.side-participant-name')
      .innerText()
  ).trim()
  const silentId = await actorIdFor(page, silent)

  await setOffline(page, silentId, true)
  try {
    await page.getByRole('button', { name: 'Add Item', exact: true }).click()
    const form = page.locator('.modal-overlay[aria-label="Add item"] .modal')
    await form.locator('#ps-name').fill('Second')
    await form.getByLabel('Item data').fill('two')
    await form.getByRole('button', { name: 'Add Item', exact: true }).click()

    // While v2 is open, nothing that publishes can start.
    const header = page.getByRole('button', { name: 'Pair', exact: true })
    await expect(header).toBeDisabled()
    await expect(header).toHaveAttribute('title', /v2 is still being published/)

    const overlay = page.locator('.modal-overlay[aria-label="Add item"]')
    await overlay.getByRole('button', { name: 'Done' }).click({ timeout: 180_000 })

    // One of two helpers stored it at threshold 2: rolled back, not recoverable.
    const banner = page.locator('.owner-banner--error', { hasText: 'v2 did not reach its threshold' })
    await expect(banner).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('button', { name: 'Add Item', exact: true })).toBeEnabled()
  } finally {
    await setOffline(page, silentId, false)
  }

  // Retry publishes the same secrets as v3; once every helper stores it, the
  // alert clears and the bag holds both secrets.
  await page.locator('.owner-banner').getByRole('button', { name: 'Retry' }).click()
  await expect(page.locator('.owner-banner--error')).toBeHidden({ timeout: 120_000 })
  await openTab(page, 'Items')
  await expect(page.locator('.tab-panel .version-tag').first()).toHaveText('v3', { timeout: 60_000 })
  await expect(page.locator('.tab-panel')).toContainText('Second')

  expect(pageErrors).toEqual([])
})


test('the threshold is set on the Channels tab, and one the helpers cannot reach blocks publishing', async ({ page, pageErrors }) => {
  await setUpOwner(page, { name: 'Frank', participants: 2, prePaired: 2, minParticipants: 2 })
  const addItem = page.getByRole('button', { name: 'Add Item', exact: true })
  await expect(addItem).toBeEnabled({ timeout: 60_000 })

  // A new secret starts at 50% of its helpers' subshares: 2 helpers, threshold 2.
  await openTab(page, 'Channels')
  const threshold = page.locator('#ch-threshold')
  await expect(page.locator('#ch-threshold-mode-percent')).toBeChecked()
  await expect(threshold).toHaveValue('50')
  await expect(page.locator('.tab-panel')).toContainText('50% → threshold 2.')

  await page.locator('#ch-threshold-mode-fixed').check()
  await threshold.fill('3')
  await expect(page.locator('.tab-panel [role="alert"]')).toContainText('below the threshold of 3')
  await expect(addItem).toBeDisabled()
  await expect(addItem).toHaveAttribute('title', /Channels tab/)

  await threshold.fill('2')
  await expect(addItem).toBeEnabled()

  // The publish dialog shows it, and no longer edits it.
  await addItem.click()
  const form = page.locator('.modal-overlay[aria-label="Add item"] .modal')
  await expect(form).toContainText('Threshold 2 of 2 subshares across 2 helpers')
  await expect(form.locator('input[type="number"]')).toHaveCount(0)

  expect(pageErrors).toEqual([])
})
