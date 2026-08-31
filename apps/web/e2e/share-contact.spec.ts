import { test, expect } from './fixtures'
import { expandParticipant, setUpOwner } from './app'

/**
 * The Share Contact modal is the tallest surface in the app — a QR code, a
 * three-option selector, copy actions and the transport block — so it is where
 * a modal first outgrows the screen.
 *
 * It did: `.modal` had `overflow: hidden` and no height cap, so anything taller
 * than the viewport was simply clipped, buttons included. These tests pin the
 * fit at laptop heights rather than the one generous size a dev machine
 * happens to have.
 */

const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 1280, height: 720 },
  { width: 1024, height: 640 },
]

async function openShareContact(page: import('@playwright/test').Page) {
  const row = await expandParticipant(page, 0)
  await row.getByRole('button', { name: 'Share Contact' }).click()

  const modal = page.locator('.modal-overlay .modal')
  // The QR is the last thing to lay out, so its arrival is when the modal has
  // reached full height.
  await modal.locator('.qr-wrapper').waitFor({ timeout: 60_000 })
  return modal
}

for (const viewport of VIEWPORTS) {
  test(`the share contact modal fits at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })

    const modal = await openShareContact(page)
    const box = (await modal.boundingBox())!

    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)

    // Clipping took the controls first, so their reachability is the assertion
    // that actually matters — a modal can "fit" and still have lost its header.
    await expect(modal.getByRole('button', { name: 'Close' })).toBeVisible()
  })
}

test('contact mode hints are available on hover, not as layout', async ({ page }) => {
  await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
  const modal = await openShareContact(page)

  const inlineOption = modal.locator('label.role-option').filter({ hasText: 'Inline keys' })
  await expect(inlineOption).toHaveAttribute('title', /Keys travel in the contact/)

  // Present for assistive tech and wired to the radio, but costing no height.
  const hint = inlineOption.locator('.visually-hidden')
  await expect(hint).toHaveText(/Keys travel in the contact/)
  expect((await hint.boundingBox())!.height).toBeLessThanOrEqual(2)

  const radio = inlineOption.getByRole('radio')
  const describedBy = await radio.getAttribute('aria-describedby')
  expect(describedBy).toBe(await hint.getAttribute('id'))
})

test('switching to No keys does not resize the modal', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
  const modal = await openShareContact(page)

  const before = (await modal.boundingBox())!.height

  await modal.locator('label.role-option').filter({ hasText: 'No keys' }).click()
  // Changing mode re-mints the contact, so wait for the new QR before measuring.
  await modal.locator('.qr-wrapper').waitFor({ timeout: 60_000 })

  // `No keys` used to add a paragraph explaining the fingerprint gate, which
  // made the modal grow on selection — the one mode most likely to be picked on
  // a small screen, since it exists to be read aloud. The consequence now lives
  // in that option's own hover hint.
  expect((await modal.boundingBox())!.height).toBe(before)
  await expect(modal).not.toContainText('Nothing in this contact binds the keys')
})

test('the modal does not collapse while a new contact is minted', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
  const modal = await openShareContact(page)
  const settled = (await modal.boundingBox())!.height

  // Sampled continuously, because the regression was transient: dropping back
  // to the loading step unmounted the QR, the copy row and the transport block,
  // so the modal shrank to its header and sprang back a moment later. A
  // before/after comparison sees nothing — only the frames in between do.
  const heights: number[] = []
  const sampler = setInterval(() => {
    void modal.boundingBox().then(b => { if (b) heights.push(Math.round(b.height)) }).catch(() => {})
  }, 25)

  await modal.locator('label.role-option').filter({ hasText: 'No keys' }).click()
  await page.waitForTimeout(3_000)
  clearInterval(sampler)

  expect(heights.length).toBeGreaterThan(20)
  expect(Math.min(...heights)).toBe(settled)
  expect(Math.max(...heights)).toBe(settled)
})

test('a superseded contact is neither scannable nor copyable', async ({ page }) => {
  await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
  const modal = await openShareContact(page)

  // Hold the *re-mint* open. Minting is fast enough locally that the refresh
  // window would otherwise be a few frames wide — long enough to see by eye,
  // too short to assert on without racing it. The route is added after the
  // modal has loaded, so only the second contact is delayed.
  await page.route('**/actors/*/contact*', async route => {
    await new Promise(resolve => setTimeout(resolve, 2_000))
    await route.continue()
  })

  // The previous QR encodes a real, still-pending channel in the *previous*
  // mode. Leaving it on screen while the new one is minted would let someone
  // scan their way into a mode the user just moved away from, so it is replaced
  // rather than dimmed, and copying is disabled with it.
  await modal.locator('label.role-option').filter({ hasText: 'No keys' }).click()

  await expect(modal.locator('.qr-placeholder')).toBeVisible()
  await expect(modal.locator('.qr-wrapper svg')).toHaveCount(0)
  await expect(modal.getByRole('button', { name: /Copy QR Payload/ })).toBeDisabled()

  // And it all comes back once the new contact lands.
  await page.unroute('**/actors/*/contact*')
  await expect(modal.locator('.qr-wrapper svg')).toHaveCount(1, { timeout: 60_000 })
  await expect(modal.getByRole('button', { name: /Copy QR Payload/ })).toBeEnabled()
})

test('the modal does not carry the old role notice', async ({ page }) => {
  await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
  const modal = await openShareContact(page)

  // Removed as both wrong and expensive: it claimed a contact carries no role,
  // and cost three lines at the top of the tallest modal in the app.
  await expect(modal).not.toContainText('A contact carries no role')
})
