// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { test, expect } from './fixtures'
import { expectOwnerDashboard, openApp, poolSize, uniqueReplicaName } from './app'

/**
 * The operator's Participants pane: provisioning and deleting the node's pool.
 *
 * Reachable with no owner set up at all, which is the point of the admin
 * sections being their own surface — so these tests deliberately do not run the
 * setup wizard first.
 *
 * Every case provisions its *own* participant under a unique name rather than
 * acting on a pool fixture. The pool is server-wide and the suite shares one
 * backend, so deleting a fixture another spec is paired with would make this
 * file's failures show up somewhere else entirely.
 */

/** Open the Participants section from the app shell's nav. */
async function openParticipants(page: import('@playwright/test').Page) {
  await openApp(page)
  await page.getByRole('button', { name: 'Participants' }).click()
  await expect(page.getByRole('heading', { name: 'Participants' })).toBeVisible()
}

/** Provision one participant and return its name. */
async function provision(page: import('@playwright/test').Page): Promise<string> {
  const name = uniqueReplicaName('Fixture')
  await page.getByLabel('Name').fill(name)
  // Exact: the pane also carries a "Provision up to N" pool action.
  await page.getByRole('button', { name: 'Provision', exact: true }).click()

  const table = page.getByRole('table', { name: 'Provisioned participants' })
  // Exact: the row's action buttons carry the participant's name in their
  // labels too, so a substring match would also find the actions cell.
  await expect(table.getByRole('cell', { name, exact: true })).toBeVisible({ timeout: 30_000 })
  return name
}

test('the pane is reachable without an owner and provisions a participant', async ({ page }) => {
  await openParticipants(page)

  const name = await provision(page)

  await expect(
    page.getByRole('table', { name: 'Provisioned participants' }).getByRole('cell', { name, exact: true }),
  ).toBeVisible()
})

test('deleting a participant removes it from the node', async ({ page, pageErrors }) => {
  await openParticipants(page)
  const name = await provision(page)

  const table = page.getByRole('table', { name: 'Provisioned participants' })
  await table.getByRole('row', { name: new RegExp(name) })
    .getByRole('button', { name: 'Delete' })
    .click()

  // Confirmed rather than done on the click: the pool is shared, so this
  // removes the participant for every owner on the node.
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(`Delete ${name}?`)
  await dialog.getByRole('button', { name: 'Delete' }).click()

  await expect(table.getByRole('cell', { name, exact: true })).toHaveCount(0, { timeout: 30_000 })

  // It must be gone from the node, not merely from this render — a reload
  // re-reads the roster from the backend.
  await page.reload()
  await page.getByRole('button', { name: 'Participants' }).click()
  await expect(
    page.getByRole('table', { name: 'Provisioned participants' }).getByRole('cell', { name, exact: true }),
  ).toHaveCount(0)

  expect(pageErrors).toEqual([])
})

test('cancelling the confirmation keeps the participant', async ({ page }) => {
  await openParticipants(page)
  const name = await provision(page)

  const table = page.getByRole('table', { name: 'Provisioned participants' })
  await table.getByRole('row', { name: new RegExp(name) })
    .getByRole('button', { name: 'Delete' })
    .click()

  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(table.getByRole('cell', { name, exact: true })).toBeVisible()
})

/**
 * Setting up an owner must never change the size of the pool.
 *
 * It used to: setup called `/helpers/ensure` with the configured total, so an
 * operator who deleted three participants from a pool of seven got them back
 * the moment anyone created an owner — silently undoing a deliberate decision.
 * The pool belongs to the node; growing it is an operator action.
 */
test('setting up an owner does not provision participants', async ({ page }) => {
  await openApp(page)
  const before = await poolSize(page)

  await page.getByRole('button', { name: 'Set up a new vault' }).click()
  await page.getByPlaceholder('e.g. Alice').fill('Alice')
  await page.getByRole('button', { name: /^Next/ }).click()
  await expect(page.getByRole('heading', { name: 'Your settings' })).toBeVisible()
  await page.getByRole('button', { name: 'Set up' }).click()
  await expectOwnerDashboard(page)

  expect(await poolSize(page)).toBe(before)
})

test('pre-pairing cannot exceed the participants that are online', async ({ page }) => {
  await openParticipants(page)
  const online = await poolSize(page)

  await page.getByRole('button', { name: 'Owner' }).click()
  await page.getByRole('button', { name: 'Set up a new vault' }).click()
  await page.getByPlaceholder('e.g. Alice').fill('Alice')
  await page.getByRole('button', { name: /^Next/ }).click()
  // Inert until the node has answered; the ceiling is unknown before then.
  await expect(page.getByRole('button', { name: 'Set up', exact: true })).toBeEnabled()

  // Raise it as far as the control allows; it must stop at what exists rather
  // than at whatever total the node is configured for.
  const increase = page.getByRole('button', { name: 'Increase pre-paired participants' })
  for (let i = 0; i < online + 3; i++) {
    if (await increase.isDisabled()) break
    await increase.click()
  }

  await expect(increase).toBeDisabled()
  const shown = Number(await page.locator('.participant-count-section').last().locator('.count').innerText())
  expect(shown).toBeLessThanOrEqual(online)
})
