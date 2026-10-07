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

test('Help opens from the phone drawer, searches, and fits the page', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 })
  await openApp(page)

  await page.getByRole('button', { name: 'Open sections' }).click()
  await page.getByRole('navigation', { name: 'App sections' }).getByRole('button', { name: 'Help' }).click()

  // The section bar names where the menu went, and the pane opens on its first topic.
  await expect(page.getByRole('heading', { name: 'Getting started', level: 1 })).toBeVisible()
  const search = page.getByRole('searchbox', { name: 'Search help' })
  await expect(search).toBeVisible()
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  // A search lists its results above the topic; Enter opens the best one.
  await search.fill('relay_allowed_hosts')
  await expect(page.getByRole('status').filter({ hasText: /^\d+ topics? match/ })).toBeVisible()
  await search.press('Enter')
  await expect(page.getByRole('article').getByRole('heading', { level: 1 })).not.toHaveText('Getting started')

  // A table-heavy topic scrolls its tables, not the page.
  await search.fill('every setting the node reads')
  await search.press('Enter')
  await expect(page.getByRole('heading', { name: 'Node configuration', level: 1 })).toBeVisible()
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)

  // Escape clears; a query that matches nothing says so.
  await search.fill('zzzz-no-such-thing')
  await expect(page.getByText('No topics match “zzzz-no-such-thing”')).toBeVisible()
  await search.press('Escape')
  await expect(search).toHaveValue('')
})

test('Help sits at the bottom of the rail on a wide screen', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await openApp(page)

  const nav = page.getByRole('navigation', { name: 'App sections' })
  const inspect = await nav.getByRole('button', { name: 'Inspect' }).boundingBox()
  const help = nav.getByRole('button', { name: 'Help' })
  const helpBox = await help.boundingBox()
  const navBox = await nav.boundingBox()
  if (!inspect || !helpBox || !navBox) throw new Error('navigation not laid out')
  // Pinned to the foot of the rail, well clear of the sections above it.
  expect(helpBox.y - (inspect.y + inspect.height)).toBeGreaterThan(100)
  expect(navBox.y + navBox.height - (helpBox.y + helpBox.height)).toBeLessThan(40)

  await help.click()
  await expect(help).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('navigation', { name: 'Help topics' })).toBeVisible()
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
