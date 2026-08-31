import { test, expect } from './fixtures'
import { setUpOwner } from './app'

/**
 * The LAN origin once Chrome is told to treat it as secure — the state a phone
 * reaches via `chrome://flags` → "Insecure origins treated as secure".
 *
 * Opt-in, like `lan.spec.ts`:
 *
 *   LAN_HOST=192.168.0.28 npm run test:e2e -- lan-secure
 *
 * `--unsafely-treat-insecure-origin-as-secure` is the desktop equivalent of
 * that flag, so this verifies the advice actually produces a working camera
 * rather than assuming it does. Launch options force a dedicated worker, which
 * is why this cannot live in `lan.spec.ts`.
 */

const LAN_HOST = process.env.LAN_HOST
const ORIGIN = `http://${LAN_HOST}:5173`

test.use({
  baseURL: `${ORIGIN}/reference-app/`,
  launchOptions: {
    args: [
      `--unsafely-treat-insecure-origin-as-secure=${ORIGIN}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  },
})

test.skip(!LAN_HOST, 'set LAN_HOST to this machine’s network address to run')

test('treating the origin as secure restores every gated API', async ({ page }) => {
  await page.goto('./')

  // All four are secure-context gated, and all four are needed: the two camera
  // APIs for scanning, and `crypto.randomUUID` for the app to get through its
  // own setup wizard at all.
  const env = await page.evaluate(() => ({
    secure: window.isSecureContext,
    mediaDevices: !!navigator.mediaDevices,
    barcodeDetector:
      typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector !== 'undefined',
    randomUUID: typeof crypto.randomUUID === 'function',
  }))

  expect(env).toEqual({
    secure: true,
    mediaDevices: true,
    barcodeDetector: true,
    randomUUID: true,
  })
})

test('the scan affordance is offered on a secure LAN origin', async ({ page }) => {
  await setUpOwner(page, { name: 'Phone', participants: 3, prePaired: 0, minParticipants: 2 })

  const row = page.locator('.side-participant-item').first()
  await row.locator('.side-participant-header').click()
  await row.getByRole('button', { name: 'Let them initiate' }).click()

  // The end state that matters: not merely that the APIs exist, but that this
  // app's capability check agrees and shows the button.
  const modal = page.locator('.modal-overlay').last()
  await expect(modal.getByRole('button', { name: 'Scan QR' })).toBeVisible({ timeout: 30_000 })
})
