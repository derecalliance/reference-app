import { test, expect } from './fixtures'
import { setUpOwner } from './app'

/**
 * The app served from a LAN address rather than `localhost`, which is how a
 * phone reaches it.
 *
 * Opt-in: set `LAN_HOST` to this machine's address on the network, e.g.
 *
 *   LAN_HOST=192.168.0.28 npm run test:e2e -- lan
 *
 * Skipped otherwise, because the address is specific to whoever is running it —
 * a hardcoded one would fail for everybody else and teach them to ignore it.
 * The dev servers must already be bound to the network (`npm run dev:lan`, and
 * a backend started with a matching `BASE_URL`).
 */

const LAN_HOST = process.env.LAN_HOST

test.describe('LAN access', () => {
  test.skip(!LAN_HOST, 'set LAN_HOST to this machine’s network address to run')
  test.use({ baseURL: `http://${LAN_HOST}:5173/reference-app/` })

  test('every backend request goes to the LAN host, not localhost', async ({ page }) => {
    // The assertion that matters, and the one an earlier version of this test
    // missed by checking `location.origin` instead: the page can be served from
    // the LAN address while its API calls still go to `localhost`. On the
    // machine running the tests both work, so the bug is invisible — right up
    // until a phone loads it, where `localhost` is the phone.
    const apiHosts = new Set<string>()
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.port === '5000') apiHosts.add(url.hostname)
    })

    await setUpOwner(page, { name: 'Phone', participants: 3, prePaired: 0, minParticipants: 2 })

    expect(apiHosts.size).toBeGreaterThan(0)
    expect([...apiHosts]).toEqual([LAN_HOST])
  })

  test('camera scanning is withheld, and blamed on the origin', async ({ page }) => {
    await page.goto('./')

    // Plain http is not a secure context, and a browser then withholds
    // `mediaDevices` *and* `BarcodeDetector` entirely — so scanning cannot work
    // over LAN http no matter which browser or device is used.
    const env = await page.evaluate(() => ({
      secure: window.isSecureContext,
      mediaDevices: !!navigator.mediaDevices,
      barcodeDetector:
        typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector !==
        'undefined',
    }))

    expect(env).toEqual({ secure: false, mediaDevices: false, barcodeDetector: false })
  })
})
