// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { test, expect } from './fixtures'
import { openTab, pairParticipant, protectSecret, setUpOwner, tabCount } from './app'

/**
 * The owner-side secret lifecycle: protect, verify, discover.
 *
 * These are the flows that make a helper channel worth having, and each has a
 * distinct failure mode — a share can be stored but not retrievable, or
 * retrievable but not the one that was stored — so they are asserted
 * separately rather than inferred from the round completing.
 */

test.describe('secret lifecycle', () => {
  test('protecting a secret distributes it to every paired helper', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })

    await protectSecret(page, 'Passphrase', 'hunter2')

    await openTab(page, 'Secrets')
    await expect(page.locator('.tab-panel')).toContainText('Passphrase')
    await expect(page.locator('.tab-panel')).toContainText('v1')
    expect(await tabCount(page, 'Secrets')).toBe(1)
    expect(pageErrors).toEqual([])
  })

  test('verifying shares confirms every helper still holds one', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })
    await protectSecret(page, 'Passphrase', 'hunter2')

    await openTab(page, 'Secrets')
    // Storing a share and being able to prove it is still there are different
    // claims: verification challenges each helper to answer from the bytes it
    // holds, which is the only thing that distinguishes them.
    await expect(page.locator('.tab-panel')).toContainText('0/2 verified')
    await page.getByRole('button', { name: 'Verify Shares' }).click()

    await expect(page.locator('.tab-panel')).toContainText('2/2 verified', { timeout: 90_000 })
    expect(pageErrors).toEqual([])
  })

  /**
   * The vault decides which versions helpers keep (SDK 0.0.7 `keepList`): the
   * latest three committed ones, plus the one being sent. So the fifth round
   * tells every helper to drop the first — and a helper asked to prove a
   * share it no longer holds refuses, which the verification view shows as a
   * rejection rather than waiting on an answer that is not coming.
   */
  test('helpers drop versions the vault no longer keeps, and refuse to verify them', async ({
    page,
    pageErrors,
  }) => {
    // Five publishing rounds, each waited out to its commit.
    test.setTimeout(300_000)
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })
    for (let i = 1; i <= 5; i++) await protectSecret(page, `Secret ${i}`, `value-${i}`)

    await openTab(page, 'Secrets')
    await page.getByRole('button', { name: /Show Previous Versions/ }).click()
    // Previous versions are listed newest first, so the last Verify is the
    // oldest version — the one no helper keeps any more.
    await page.getByRole('button', { name: 'Verify Shares' }).last().click()

    const modal = page.locator('.verify-modal--progress')
    await expect(modal).toContainText('0 of 2 verified · 2 rejected', { timeout: 90_000 })
    await expect(modal.locator('.share-progress-item-status', { hasText: 'Rejected' })).toHaveCount(2)
    await expect(modal.getByRole('button', { name: 'Done' })).toBeVisible()
    expect(pageErrors).toEqual([])
  })

  test('discovery finds the secret versions helpers are holding', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })
    await protectSecret(page, 'Passphrase', 'hunter2')

    await openTab(page, 'Recovery')
    // Each helper starts `PENDING` — it has answered nothing yet. Discovery is
    // what a recovering owner runs to learn which versions are recoverable.
    await expect(page.locator('.tab-panel')).toContainText(/pending/i)
    await page.getByRole('button', { name: 'Discover All' }).click()

    // Every helper answers with what it holds for this secret.
    await expect(page.locator('.tab-panel')).not.toContainText(/pending/i, { timeout: 90_000 })
    expect(pageErrors).toEqual([])
  })

  test('a second secret lands in a new bag version', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })

    await protectSecret(page, 'Passphrase', 'hunter2')
    // Version progression is anchored to the library's own snapshot, which also
    // bumps on pair-completion auto-publish — so this asserts the bag grew, not
    // a particular number.
    await protectSecret(page, 'Recovery code', '123456')

    await openTab(page, 'Secrets')
    await expect(page.locator('.tab-panel')).toContainText('Passphrase')
    await expect(page.locator('.tab-panel')).toContainText('Recovery code')
    expect(await tabCount(page, 'Secrets')).toBe(2)
    expect(pageErrors).toEqual([])
  })

  test('removing a secret distributes a new bag version without it', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })
    await protectSecret(page, 'Passphrase', 'hunter2')
    await protectSecret(page, 'Recovery code', '123456')

    await openTab(page, 'Secrets')
    const currentVersion = page.locator('.card-header .version-tag')
    const before = Number((await currentVersion.innerText()).replace(/\D+/g, ''))

    await page.getByRole('button', { name: 'Remove Recovery code' }).click()
    const dialog = page.locator('.modal-overlay[aria-label="Remove secret"] .modal')
    await dialog.getByRole('button', { name: 'Remove Secret' }).click()

    // Removal is a full sharing round, exactly as adding is: every paired
    // helper has to confirm the new version before it becomes current.
    await expect(dialog).toContainText('2 of 2 confirmed', { timeout: 120_000 })
    await dialog.getByRole('button', { name: 'Done' }).click()

    const panel = page.locator('.tab-panel')
    await expect(panel).not.toContainText('Recovery code')
    await expect(panel).toContainText('Passphrase')
    expect(await tabCount(page, 'Secrets')).toBe(1)
    expect(Number((await currentVersion.innerText()).replace(/\D+/g, ''))).toBeGreaterThan(before)
    // The new version's shares are held, not merely sent.
    await expect(panel).toContainText('0/2 verified')
    expect(pageErrors).toEqual([])
  })
})
