import { test, expect } from './fixtures'
import { setUpOwner } from './app'
import type { BrowserContext, Page } from '@playwright/test'

/**
 * Two browsers pairing each other — a laptop and a phone, in practice.
 *
 * This is the gap every other spec leaves: they pair a browser against backend
 * fixtures, where the peer is a provisioned actor on the roster. A second
 * browser registers as its own **owner**, so it never appears in the
 * participant list and the pairing goes through the pasted-payload path
 * instead. The row the app then mints for it has no actor id and no
 * `browserManaged` flag, which is a shape nothing else exercises — and which
 * hid two separate bugs in the fingerprint gate.
 *
 * Both are covered here:
 *
 * - the peer id being synthetic rather than a UUID, which sent
 *   `peer-<channelId>` to an endpoint expecting an actor and failed with a 400;
 * - the confirm button doing nothing at all, because unstable callback props
 *   re-ran the dialog's effect on every render and reset its state.
 *
 * The second is why the assertion here is on the *outcome* of pressing the
 * button rather than on its presence. The button was there and enabled the
 * whole time.
 */

/**
 * The fingerprint dialog on `page`, anchored on its title.
 *
 * Deliberately not located by its button text: confirming replaces "Codes
 * match" with "Done", so a locator filtered on the button stops matching at
 * exactly the moment the thing under test succeeds, and reports "element not
 * found" instead of the state it reached.
 */
function fingerprintDialog(page: Page, peerName: string) {
  return page.locator('[role="dialog"]').filter({ hasText: `Confirm “${peerName}”` })
}

/** A browser context with its own owner, isolated as a separate device. */
async function newDevice(
  browser: import('@playwright/test').Browser,
  name: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  const page = await context.newPage()
  await setUpOwner(page, { name, participants: 3, prePaired: 0, minParticipants: 2 })
  return { context, page }
}

/** Mint a contact in `mode` and return its payload, as the QR encodes it. */
async function contactPayload(page: Page, mode: string): Promise<string> {
  await page.getByRole('button', { name: 'Share Contact' }).first().click()

  const modal = page.locator('.modal-overlay .modal')
  await modal.locator('.qr-wrapper').waitFor({ timeout: 60_000 })
  await modal.locator('label.role-option').filter({ hasText: mode }).click()
  // The QR returns only once the new contact has been minted in the new mode.
  await modal.locator('.qr-wrapper svg').waitFor({ timeout: 60_000 })

  await modal.getByRole('button', { name: /Copy QR Payload/ }).click()
  const payload = await page.evaluate(() => navigator.clipboard.readText())
  await modal.getByRole('button', { name: 'Close' }).click()
  return payload
}

test('two browsers pair with NoKeys and confirm on both sides', async ({ browser }) => {
  const alice = await newDevice(browser, 'Alice')
  const bob = await newDevice(browser, 'Bob')

  try {
    const payload = await contactPayload(alice.page, 'No keys')
    expect(payload).toContain('channel_id')

    // Bob initiates against Alice's contact — the paste path, which is the only
    // way two browsers reach each other.
    await bob.page.getByRole('button', { name: 'Pair', exact: true }).first().click()
    const pairModal = bob.page.locator('.modal-overlay').last()
    await pairModal.locator('#qr-payload').fill(payload)
    await pairModal.getByRole('button', { name: /^Pair as/ }).click()

    // Alice is asked to accept; a browser peer has a human, so nothing is
    // auto-accepted the way a fixture would be.
    await alice.page.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 60_000 })

    // Both sides derive the same code from the shared key. Neither can read the
    // other's, so each shows only its own — the comparison is the human's.
    const codes: string[] = []
    for (const { device, peer } of [
      { device: alice, peer: 'Bob' },
      { device: bob, peer: 'Alice' },
    ]) {
      const dialog = fingerprintDialog(device.page, peer)
      await expect(dialog).toBeVisible({ timeout: 90_000 })

      const code = await dialog
        .getByText(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)
        .first()
        .innerText()
      codes.push(code.trim())
    }
    expect(codes[0]).toBe(codes[1])

    // The outcome, not the click. The regression this guards left the button
    // enabled and responsive-looking while achieving nothing.
    for (const { device, peer } of [
      { device: alice, peer: 'Bob' },
      { device: bob, peer: 'Alice' },
    ]) {
      const dialog = fingerprintDialog(device.page, peer)
      await dialog.getByRole('button', { name: 'Codes match' }).click()
      await expect(dialog).toContainText('Confirmed on this device', { timeout: 60_000 })
    }
  } finally {
    await alice.context.close()
    await bob.context.close()
  }
})
