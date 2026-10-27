// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { Page } from '@playwright/test'

import { test, expect } from './fixtures'
import {
  BACKEND_API_URL,
  actorIdFor,
  discoverAll,
  openTab,
  protectAndReadConfirmations,
  protectSecret,
  recoverOfferedSecret,
  setUpOwner,
} from './app'

/**
 * Provisioned helpers that misbehave without going offline
 * (`PUT /api/v1/helpers/{id}/fault`): they lose or corrupt what they hold, or
 * refuse to store or to verify. Each failure goes through the SDK's own
 * answers, so what the owner sees here is what a real helper in that state
 * would cause.
 *
 * The helper pool is shared by the whole suite, so every test puts its helper
 * back to healthy whatever happens.
 */

type Fault = 'none' | 'lost_shares' | 'corrupted_shares' | 'refuses_new_shares' | 'refuses_verification'

async function setFault(page: Page, actorId: string, fault: Fault): Promise<void> {
  const res = await page.request.put(`${BACKEND_API_URL}/helpers/${actorId}/fault`, { data: { fault } })
  expect(res.ok(), `set fault ${fault}`).toBe(true)
}

/**
 * The name of this owner's `index`-th *paired* participant. The side panel
 * lists the whole shared pool, so a plain row index can land on a helper this
 * owner never paired with.
 */
async function pairedParticipantName(page: Page, index: number): Promise<string> {
  const paired = page.locator('.side-participant-item').filter({ has: page.locator('.status-tag.paired') })
  await expect(paired.nth(index)).toBeVisible()
  return (await paired.nth(index).locator('.side-participant-name').innerText()).trim()
}

/** Run `body` with this owner's `index`-th paired participant simulating `fault`, then restore it. */
async function withFault(page: Page, index: number, fault: Fault, body: (name: string) => Promise<void>): Promise<void> {
  const name = await pairedParticipantName(page, index)
  const id = await actorIdFor(page, name)
  await setFault(page, id, fault)
  try {
    await body(name)
  } finally {
    await setFault(page, id, 'none')
  }
}

/** Challenge the current version and wait until every helper has answered. */
async function verifyCurrentVersion(page: Page, summary: string | RegExp) {
  await openTab(page, 'Secrets')
  await page.getByRole('button', { name: 'Verify Shares', exact: true }).first().click()
  const modal = page.locator('.verify-modal--progress')
  await expect(modal.locator('.share-progress-summary')).toHaveText(summary, { timeout: 90_000 })
  return modal
}

test.describe('simulated helper failures', () => {
  test('a helper that lost its shares rejects verification, and its row says why', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 2, prePaired: 2, minParticipants: 2 })
    await protectSecret(page, 'Passphrase', 'hunter2')

    await withFault(page, 0, 'lost_shares', async name => {
      await openTab(page, 'Channels')
      await expect(page.locator('.tab-panel')).toContainText('Simulated: Lost shares', { timeout: 30_000 })

      const modal = await verifyCurrentVersion(page, '1 of 2 verified · 1 rejected')
      await expect(modal.locator('.share-progress-item', { hasText: name })).toContainText('Rejected')
    })
    expect(pageErrors).toEqual([])
  })

  test('a corrupted helper fails verification, and recovery sets its share aside', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Bob', participants: 3, prePaired: 3, minParticipants: 2 })
    await protectSecret(page, 'Passphrase', 'hunter2')

    await withFault(page, 0, 'corrupted_shares', async name => {
      const modal = await verifyCurrentVersion(page, '2 of 3 verified · 1 invalid proof')
      await expect(modal.locator('.share-progress-item', { hasText: name })).toContainText('Proof invalid')
      await modal.getByRole('button', { name: 'Done' }).click()

      // The two honest shares still rebuild the secret; the corrupted one is
      // reported, not used.
      await discoverAll(page)
      await recoverOfferedSecret(page)
      await expect(page.locator('.tab-panel')).toContainText('Passphrase')
      await expect(page.getByText(`${name} sent a corrupted recovery share`)).toBeVisible({ timeout: 60_000 })
    })
    // The app reports both on the console, as it does for a real one.
    expect(pageErrors).toHaveLength(2)
    expect(pageErrors[0]).toContain('failed verification')
    expect(pageErrors[1]).toContain('fails its own proof')
  })

  test('a helper that refuses new shares is counted as refused, and the rest still commit', async ({
    page,
    pageErrors,
  }) => {
    await setUpOwner(page, { name: 'Carol', participants: 3, prePaired: 3, minParticipants: 2 })

    await withFault(page, 0, 'refuses_new_shares', async name => {
      const summary = await protectAndReadConfirmations(page, 'Passphrase', 'hunter2')
      expect(summary).toContain('2 of 3 confirmed')
      expect(summary).toMatch(new RegExp(`${name}[\\s\\S]*Rejected`))
    })
    expect(pageErrors).toEqual([])
  })

  test('a helper that refuses verification is rejected while it still holds its share', async ({
    page,
    pageErrors,
  }) => {
    await setUpOwner(page, { name: 'Dave', participants: 2, prePaired: 2, minParticipants: 2 })
    await protectSecret(page, 'Passphrase', 'hunter2')

    await withFault(page, 1, 'refuses_verification', async name => {
      const modal = await verifyCurrentVersion(page, '1 of 2 verified · 1 rejected')
      await expect(modal.locator('.share-progress-item', { hasText: name })).toContainText('Rejected')
      await modal.getByRole('button', { name: 'Done' }).click()

      // Still holding it: recovery works from both.
      await discoverAll(page)
      await recoverOfferedSecret(page)
      await expect(page.locator('.tab-panel')).toContainText('Passphrase')
    })
    expect(pageErrors).toEqual([])
  })
})
