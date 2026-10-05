// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { test, expect } from './fixtures'
import { expectOwnerDashboard, openApp } from './app'

/**
 * The operator's Settings pane: node-level protocol defaults.
 *
 * These moved out of the owner wizard, which is what makes this file necessary.
 * While the wizard owned the pool size it also rebalanced the transport
 * breakdown as the count changed, and the suite drove both together. With the
 * count configured here instead, nothing exercised the pair — and they must
 * agree: the backend rejects a breakdown that does not sum to the count with
 * "transports must sum to total", so a mismatch fails provisioning outright
 * rather than degrading.
 */

/** Open Settings from the app shell's nav, with no owner set up. */
async function openSettings(page: import('@playwright/test').Page) {
  await openApp(page)
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
}

/** The editable pool-size field. */
function participantsField(page: import('@playwright/test').Page) {
  return page.getByLabel('Participants', { exact: true })
}

/**
 * Shrink the pool to `size`, bringing the recommendation down with it — the
 * pane refuses a recommendation larger than the pool, and the node's default
 * of five would be.
 */
async function shrinkPoolTo(page: import('@playwright/test').Page, size: number) {
  await participantsField(page).fill(String(size))
  await page.getByLabel('Recommended', { exact: true }).fill(String(size))
}

test('the transport breakdown follows the participant count', async ({ page }) => {
  await openSettings(page)
  // The form renders only once the node's values have loaded; counting the
  // field before that read "no gRPC listener" and skipped the test silently.
  await expect(participantsField(page)).toBeVisible()

  const http = page.getByLabel('HTTP only')
  // Only meaningful when the node runs the gRPC listener; otherwise the pane
  // shows an explanatory notice and there is nothing to keep in step.
  test.skip(!(await http.count()), 'node runs no gRPC listener')

  await participantsField(page).fill('4')

  // Refitted as the count changes, so what is on screen is what would be
  // provisioned — not a breakdown the backend would refuse.
  await expect(http).toHaveValue('4')

  await participantsField(page).fill('2')
  await expect(http).toHaveValue('2')
})

test('an owner sets up against a pool size overridden here', async ({ page, pageErrors }) => {
  await openSettings(page)

  // Deliberately not the node's own default: the regression this covers is a
  // count that no longer matches the node's transport breakdown.
  await shrinkPoolTo(page, 4)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()

  await page.getByRole('button', { name: 'Owner' }).click()
  await page.getByRole('button', { name: 'Set up a new vault' }).click()
  await page.getByPlaceholder('e.g. Alice').fill('Alice')
  await page.getByRole('button', { name: /^Next/ }).click()
  await expect(page.getByRole('button', { name: 'Set up', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Set up' }).click()

  // Before the counts were reconciled, this failed on the provisioning call
  // with "transports must sum to total" and never reached the dashboard.
  await expectOwnerDashboard(page)

  expect(pageErrors).toEqual([])
})

test('resetting returns the defaults to the node', async ({ page }) => {
  await openSettings(page)

  await shrinkPoolTo(page, 4)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Overridden in this browser', { exact: false })).toBeVisible()

  await page.getByRole('button', { name: 'Reset to node' }).click()

  await expect(page.getByText('Following the node', { exact: false })).toBeVisible()
  // The override is gone from storage, not merely from the screen.
  await page.reload()
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByText('Following the node', { exact: false })).toBeVisible()
})

test('values the protocol cannot run with are refused, field by field', async ({ page }) => {
  await openSettings(page)

  await participantsField(page).fill('3')
  await page.getByLabel('Minimum', { exact: true }).fill('9')
  await page.getByLabel('Protocol timeout (s)', { exact: true }).fill('0')

  await expect(page.getByText('Cannot exceed the pool of 3').first()).toBeVisible()
  await expect(page.getByText('Must be at least 10')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()

  // Nothing reached storage: the pane still follows the node after a reload.
  await page.reload()
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByText('Following the node', { exact: false })).toBeVisible()
})
