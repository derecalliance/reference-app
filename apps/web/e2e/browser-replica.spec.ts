import { test, expect } from './fixtures'
import { setUpOwner } from './app'
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
      for (const { device, peer } of [
        { device: initiator, peer: 'ReplicaResponder' },
        { device: responder, peer: 'ReplicaInitiator' },
      ]) {
        const dialog = fingerprintDialog(device.page, peer)
        const confirm = dialog.getByRole('button', { name: 'Codes match' })
        await expect(confirm).toBeEnabled()
        await confirm.click()
        await expect(dialog).toContainText('Confirmed on this device', { timeout: 60_000 })
      }
    } finally {
      await initiator.context.close()
      await responder.context.close()
    }
  })
}
