// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { test, expect } from './fixtures'
import { openApp, setUpOwner } from './app'
import type { Page } from '@playwright/test'

/**
 * Defects from the pre-release QA pass that only a real browser shows: focus
 * and Escape in the app's own dialogs, layout at phone width, and what one tab
 * does to another that shares its storage.
 */

/** A row of the vault list, found by the vault's name. */
function vaultRow(page: Page, name: string) {
  return page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) })
}

/** How far the page itself scrolls sideways — 0 when nothing overflows. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

test('the app’s dialogs keep focus inside and close on Escape', async ({ page }) => {
  await openApp(page)

  await page.getByRole('button', { name: 'Reset browser data' }).click()
  const dialog = page.getByRole('dialog', { name: 'Reset browser data?' })
  await expect(dialog).toBeVisible()

  // Tabbing past the last button wraps back into the dialog rather than
  // reaching the page behind it.
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab')
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('nothing runs off the side of the page at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 })
  await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })

  // The vault page: header, tab bar and console header all at once.
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  // The header's actions are still reachable, from its menu.
  await page.getByRole('button', { name: /^More actions/ }).click()
  await expect(page.getByRole('menuitem', { name: 'Reset browser data' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'All vaults' }).click()

  await expect(page.getByRole('heading', { name: 'Your vaults' })).toBeVisible()
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
})

test('a vault claimed in another tab is shown as open there', async ({ page }) => {
  await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
  await page.getByRole('button', { name: 'Leave' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Stop running here' }).click()
  await expect(vaultRow(page, 'Alice')).toContainText('Stopped')

  const other = await page.context().newPage()
  await other.goto('./')
  await other.getByRole('button', { name: 'Open Alice', exact: true }).click()
  await expect(other.getByRole('tab', { name: /^Secrets/ })).toBeVisible({ timeout: 60_000 })

  // No reload here: the first tab follows on its own.
  await expect(vaultRow(page, 'Alice')).toContainText('Open in another tab', { timeout: 10_000 })
  await other.close()
})

test('resetting browser data stops and reloads every tab', async ({ page }) => {
  await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })

  const other = await page.context().newPage()
  await other.goto('./')
  await expect(vaultRow(other, 'Alice')).toBeVisible()

  await other.getByRole('button', { name: 'Reset browser data' }).click()
  await other.getByRole('button', { name: 'Erase and reload' }).click()

  // Both tabs come back empty — the one that was running Alice did not write
  // her back into the wiped storage.
  await expect(other.getByRole('heading', { name: 'Get started' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible({ timeout: 30_000 })
  const leftovers = await page.evaluate(() =>
    Object.keys(localStorage).filter(
      key =>
        (key.startsWith('derec:') || key.startsWith('derec.')) &&
        // Seeded by `setUpOwner` before every navigation (an `addInitScript`),
        // so the reset's own reload puts it straight back. Not the app's.
        key !== 'derec.protocolDefaults',
    ),
  )
  expect(leftovers).toEqual([])
  await other.close()
})
