// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { test, expect } from './fixtures'
import { openTab, protectSecret, replicaChannelRow, setUpOwner } from './app'
import type { Browser, BrowserContext, Page } from '@playwright/test'

/**
 * Two browsers pairing as a **replica** pair — one device mirroring its whole
 * vault onto another.
 *
 * `replicas.spec.ts` covers replica mode against a provisioned helper, and
 * `browser-pairing.spec.ts` covers browser-to-browser pairing in the ordinary
 * participant role. Their intersection was untested, and it is the one shape
 * where *both* ends are human-driven: a helper derives and confirms its code
 * server-side with no screen, so the two-sided comparison never actually ran
 * end to end anywhere.
 *
 * Both directions are covered because they are different code paths, not a
 * relabelling of one. The role is chosen by whichever device pastes the
 * contact, so the side that raises the destination's erase consent, and the
 * side that answers the inbound `ReplicaPairingRequestDialog`, swap over.
 */

/**
 * The fingerprint dialog on `page`, anchored on its title.
 *
 * Not located by its button text: confirming replaces "Codes match" with
 * "Done", so a locator filtered on the button stops matching at exactly the
 * moment the thing under test succeeds.
 */
function fingerprintDialog(page: Page, peerName: string) {
  return page.locator('[role="dialog"]').filter({ hasText: `Confirm “${peerName}”` })
}

/** A browser context with its own owner, isolated as a separate device. */
async function newDevice(
  browser: Browser,
  name: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await context.newPage()
  await setUpOwner(page, { name, participants: 2, prePaired: 0, minParticipants: 2 })
  return { context, page }
}

/** Publish a contact and return its payload, as the QR encodes it. */
async function contactPayload(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Share Contact' }).first().click()

  const modal = page.locator('.modal-overlay .modal')
  await modal.locator('.qr-wrapper svg').waitFor({ timeout: 60_000 })
  await modal.getByRole('button', { name: /Copy QR Payload/ }).click()
  const payload = await page.evaluate(() => navigator.clipboard.readText())
  await modal.getByRole('button', { name: 'Close' }).click()
  return payload
}

/**
 * `role` is the side the *pasting* device takes; the peer becomes its
 * counterpart. Only the destination is consent-gated, and the responder's
 * accept control is worded differently on each side, so both are matched
 * loosely enough to serve either direction.
 */
async function pairAsReplica(page: Page, payload: string, role: string): Promise<void> {
  await page.getByRole('button', { name: 'Pair', exact: true }).first().click()

  const pairModal = page.locator('.modal-overlay').last()
  await pairModal.locator('#qr-payload').fill(payload)
  await pairModal.locator('label.role-option').filter({ hasText: role }).click()
  await pairModal.getByRole('button', { name: /^Pair as/ }).click()

  // Taking the destination side means agreeing to have this vault replaced,
  // which is gated behind its own warning.
  const consent = page.getByRole('button', { name: /Continue as destination/i })
  if (await consent.count()) await consent.first().click()
}

const CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/

/**
 * Say the codes match on `page`, for its pairing with `peerName`.
 *
 * On the destination that is not the whole answer: confirming there is the
 * decision to adopt the source's vault (SDK 0.0.7 installs the source's
 * publishes as soon as the channel is confirmed), so the dialog asks that
 * first — and nothing is confirmed until it is answered.
 */
async function confirmCodes(page: Page, peerName: string, adopts: boolean): Promise<void> {
  const dialog = fingerprintDialog(page, peerName)
  await dialog.getByRole('button', { name: 'Codes match' }).click({ timeout: 90_000 })
  if (adopts) {
    await expect(dialog).toContainText('Confirming adopts')
    await expect(dialog).not.toContainText('Confirmed on this device')
    await dialog.getByRole('button', { name: 'Adopt and confirm' }).click()
  }
  await expect(dialog).toContainText('Confirmed on this device', { timeout: 60_000 })
}

/**
 * Open the console panel. The handler is fired directly: with a modal open the
 * console is aria-hidden and under the backdrop, and a click through the
 * backdrop would dismiss the modal instead.
 */
async function openConsole(page: Page): Promise<void> {
  await page.locator('.console-toggle').dispatchEvent('click')
}

/** The console line the destination writes when it has adopted the source's vault. */
const ADOPTED = /Adopted mirrored vault v\d+/

for (const initiatorRole of ['Replica source', 'Replica destination'] as const) {
  test(`two browsers pair as replicas — initiator is the ${initiatorRole.toLowerCase()}`, async ({
    browser,
  }) => {
    const initiator = await newDevice(browser, 'ReplicaInitiator')
    const responder = await newDevice(browser, 'ReplicaResponder')

    try {
      const payload = await contactPayload(responder.page)
      expect(payload).toContain('channel_id')

      await pairAsReplica(initiator.page, payload, initiatorRole)

      // A browser peer has a human, so nothing is auto-accepted. The
      // destination's accept is worded to name what it gives up.
      await responder.page
        .getByRole('button', { name: /^Accept( and become the replica)?$/ })
        .click({ timeout: 60_000 })

      // Both ends derive the same code from the shared key. Neither can read
      // the other's — the comparison is the human's, and this is the only
      // configuration where both ends really make it.
      const codes: string[] = []
      for (const { device, peer } of [
        { device: initiator, peer: 'ReplicaResponder' },
        { device: responder, peer: 'ReplicaInitiator' },
      ]) {
        const dialog = fingerprintDialog(device.page, peer)
        await expect(dialog).toBeVisible({ timeout: 90_000 })
        // The code has to be on screen before anyone can claim to have
        // compared it — a dialog that failed to derive one shows an error and
        // an inert Confirm instead.
        const code = await dialog.getByText(CODE).first().innerText()
        codes.push(code.trim())
      }
      expect(codes[0]).toBe(codes[1])

      // The outcome, not the click: each side records only its own decision,
      // and neither can observe the other's.
      const initiatorAdopts = initiatorRole === 'Replica destination'
      for (const { device, peer, adopts } of [
        { device: initiator, peer: 'ReplicaResponder', adopts: initiatorAdopts },
        { device: responder, peer: 'ReplicaInitiator', adopts: !initiatorAdopts },
      ]) {
        await expect(fingerprintDialog(device.page, peer).getByRole('button', { name: 'Codes match' }))
          .toBeEnabled()
        await confirmCodes(device.page, peer, adopts)
      }
    } finally {
      await initiator.context.close()
      await responder.context.close()
    }
  })
}

/**
 * The source mirrors as soon as *it* confirms, which can be before the
 * destination has. The destination drops that copy (`MessageIgnored`) and,
 * once the person confirms — which is also agreeing to adopt — pulls the copy
 * itself with a replica discovery and adopts it without asking again.
 *
 * Forced here rather than left to timing: the destination waits until the push
 * has demonstrably arrived and been ignored before it confirms.
 */
test('a mirrored copy pushed before the destination confirms is ignored, then pulled once it does', async ({
  browser,
}) => {
  const source = await newDevice(browser, 'HeldSource')
  const destination = await newDevice(browser, 'HeldDestination')

  try {
    await pairAsReplica(source.page, await contactPayload(destination.page), 'Replica source')
    await destination.page
      .getByRole('button', { name: /^Accept( and become the replica)?$/ })
      .click({ timeout: 60_000 })

    // The source confirms first, which promotes its channel and mirrors.
    const sourceDialog = fingerprintDialog(source.page, 'HeldDestination')
    await sourceDialog.getByRole('button', { name: 'Codes match' }).click({ timeout: 90_000 })
    await expect(sourceDialog).toContainText('Confirmed on this device', { timeout: 60_000 })

    // Wait for the push to reach the destination and be dropped, as its own
    // console reports.
    await openConsole(destination.page)
    await expect(destination.page.getByText(/has not confirmed the channel's fingerprint yet/).first()).toBeVisible({
      timeout: 60_000,
    })
    await expect(destination.page.getByText(ADOPTED)).toHaveCount(0)

    // Agreeing to adopt and confirming pulls the copy, which is then adopted
    // with no second question.
    const destinationDialog = fingerprintDialog(destination.page, 'HeldSource')
    await confirmCodes(destination.page, 'HeldSource', true)
    await destinationDialog.getByRole('button', { name: 'Done' }).click()

    await expect(destination.page.getByText(ADOPTED).first()).toBeVisible({ timeout: 60_000 })
    await expect(destination.page.getByRole('dialog', { name: 'Replace this vault?' })).toHaveCount(0)
  } finally {
    await source.context.close()
    await destination.context.close()
  }
})

/**
 * The other order: the destination confirms first. Its request for the copy
 * reaches a source that has not confirmed yet, which ignores it — and the
 * library never times out a request nobody answers. The destination keeps
 * asking and says so ("Syncing…") until the source confirms, at which point the
 * copy lands and is adopted, as agreed when confirming.
 */
test('a destination that confirms first shows it is syncing until the copy lands', async ({
  browser,
}) => {
  const source = await newDevice(browser, 'SyncSource')
  const destination = await newDevice(browser, 'SyncDestination')

  try {
    await pairAsReplica(source.page, await contactPayload(destination.page), 'Replica source')
    await destination.page
      .getByRole('button', { name: /^Accept( and become the replica)?$/ })
      .click({ timeout: 60_000 })

    // The destination agrees to adopt, confirms first and closes the comparison.
    const destinationDialog = fingerprintDialog(destination.page, 'SyncSource')
    await confirmCodes(destination.page, 'SyncSource', true)
    await destinationDialog.getByRole('button', { name: 'Done' }).click()

    // Nothing can arrive yet — the source has not confirmed — so it says so.
    await openTab(destination.page, 'Replicas')
    const row = replicaChannelRow(destination.page, 'SyncSource')
    await expect(row).toContainText('Syncing…', { timeout: 30_000 })
    await openConsole(destination.page)
    await expect(destination.page.getByText(ADOPTED)).toHaveCount(0)

    // The source confirms; the copy lands, syncing ends and it is adopted.
    await confirmCodes(source.page, 'SyncDestination', false)

    await expect(destination.page.getByText(ADOPTED).first()).toBeVisible({ timeout: 60_000 })
    await expect(destination.page.getByRole('dialog', { name: 'Replace this vault?' })).toHaveCount(0)
    await expect(row).not.toContainText('Syncing…')
  } finally {
    await source.context.close()
    await destination.context.close()
  }
})

/**
 * Declining to adopt is declining to confirm. The destination is asked before
 * anything is confirmed, and a "no" leaves its channel `Pending`: the source's
 * mirror keeps being dropped and nothing on this device changes.
 */
test('a destination that declines to adopt never confirms the channel', async ({ browser }) => {
  const source = await newDevice(browser, 'DeclinedSource')
  const destination = await newDevice(browser, 'DeclinedDestination')

  try {
    await pairAsReplica(source.page, await contactPayload(destination.page), 'Replica source')
    await destination.page
      .getByRole('button', { name: /^Accept( and become the replica)?$/ })
      .click({ timeout: 60_000 })

    const destinationDialog = fingerprintDialog(destination.page, 'DeclinedSource')
    await destinationDialog.getByRole('button', { name: 'Codes match' }).click({ timeout: 90_000 })
    await expect(destinationDialog).toContainText('Confirming adopts')
    await destinationDialog.getByRole('button', { name: 'Don’t adopt' }).click()
    await expect(destinationDialog).toBeHidden()

    await openTab(destination.page, 'Replicas')
    const row = replicaChannelRow(destination.page, 'DeclinedSource')
    await expect(row.locator('.status-tag')).toHaveText('Adoption declined')

    // The source confirms and mirrors; the destination, never having confirmed,
    // drops the copy rather than installing it.
    await confirmCodes(source.page, 'DeclinedDestination', false)
    await openConsole(destination.page)
    await expect(
      destination.page.getByText(/has not confirmed the channel's fingerprint yet/).first(),
    ).toBeVisible({ timeout: 60_000 })
    await expect(destination.page.getByText(ADOPTED)).toHaveCount(0)
    await expect(row.locator('.status-tag')).toHaveText('Adoption declined')
  } finally {
    await source.context.close()
    await destination.context.close()
  }
})

/**
 * A bag version carries the replica group, and "View Payload" shows it. The
 * library puts the roster — every member, the source included — in the secret
 * it distributes; a payload view that left it out misdescribed what helpers
 * and replicas actually hold.
 */
test('a protected version shows the replica group in its payload', async ({ browser }) => {
  // The source needs paired helpers to protect anything at all.
  const sourceContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const source = { context: sourceContext, page: await sourceContext.newPage() }
  await setUpOwner(source.page, { name: 'PayloadSource', participants: 2, prePaired: 2, minParticipants: 2 })
  const destination = await newDevice(browser, 'PayloadDestination')

  try {
    await pairAsReplica(source.page, await contactPayload(destination.page), 'Replica source')
    await destination.page
      .getByRole('button', { name: /^Accept( and become the replica)?$/ })
      .click({ timeout: 60_000 })
    for (const { device, peer, adopts } of [
      { device: source, peer: 'PayloadDestination', adopts: false },
      { device: destination, peer: 'PayloadSource', adopts: true },
    ]) {
      await confirmCodes(device.page, peer, adopts)
      await fingerprintDialog(device.page, peer).getByRole('button', { name: 'Done' }).click()
    }
    // The source's own pair dialog stays up on "Pairing Complete" until dismissed.
    await source.page
      .locator('[aria-labelledby="pair-modal-title"]')
      .getByRole('button', { name: 'Done' })
      .click()

    await protectSecret(source.page, 'Passphrase', 'hunter2')

    await openTab(source.page, 'Secrets')
    await source.page.getByRole('button', { name: 'View Payload' }).first().click()
    const payload = source.page.locator('.payload-pre')
    await expect(payload).toContainText('"replicas": {')
    await expect(payload).toContainText('"role": "Source"')
    await expect(payload).toContainText('"role": "Destination"')
    await expect(payload).toContainText('"name": "PayloadDestination"')
    // The publishing device names itself too — before SDK 0.0.6 its own row
    // was stored without `communication_info`, so the source read as null.
    await expect(payload).toContainText('"name": "PayloadSource"')
  } finally {
    await source.context.close()
    await destination.context.close()
  }
})
