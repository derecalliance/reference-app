import { test, expect } from './fixtures'
import { expandParticipant, setUpOwner } from './app'

/**
 * Scanning a peer's QR with the webcam, as an alternative to pasting its
 * payload.
 *
 * Chrome runs with `--use-fake-device-for-media-stream`, so a real camera is
 * opened and released — but it emits a rolling pattern, not a QR. Tests that
 * need a *decode* stub `BarcodeDetector` to return a known payload. That is the
 * right split: the decode itself is Chromium's, while the scan loop, the
 * plumbing into the payload field and the camera teardown are this app's.
 */

/** Replace `BarcodeDetector` so the next frame decodes to `value`. */
async function stubDetector(page: import('@playwright/test').Page, value: string) {
  await page.addInitScript(payload => {
    class FakeBarcodeDetector {
      static getSupportedFormats() {
        return Promise.resolve(['qr_code'])
      }
      detect() {
        return Promise.resolve([{ rawValue: payload }])
      }
    }
    Object.defineProperty(window, 'BarcodeDetector', {
      value: FakeBarcodeDetector,
      configurable: true,
      writable: true,
    })
  }, value)
}

/** Open the "let them initiate" modal, which is the paste/scan surface. */
async function openPairInitiator(page: import('@playwright/test').Page) {
  const row = await expandParticipant(page, 0)
  await row.getByRole('button', { name: 'Let them initiate' }).click()
  return page.locator('.modal-overlay').filter({ hasText: 'Pair' }).last()
}

test('a decoded QR fills the payload field the paste path uses', async ({ page }) => {
  await stubDetector(page, '{"channel_id":"12345","nonce":"1"}')
  await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })

  const modal = await openPairInitiator(page)
  await modal.getByRole('button', { name: 'Scan QR' }).click()

  // The decoded value lands in the same textarea a paste would fill, so
  // validation, role selection and submission stay one code path.
  await expect(modal.locator('#qr-payload')).toHaveValue(
    '{"channel_id":"12345","nonce":"1"}',
    { timeout: 30_000 },
  )
})

test('the camera is released once a code is decoded', async ({ page }) => {
  await stubDetector(page, '{"channel_id":"777"}')
  await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })

  // Count every track the page ever opens, and how many it stopped. A page that
  // holds the camera open leaves the recording indicator lit — for an app about
  // protecting secrets that reads as something worse than a leak.
  await page.evaluate(() => {
    const w = window as unknown as { __tracks: MediaStreamTrack[] }
    w.__tracks = []
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await real(constraints)
      w.__tracks.push(...stream.getTracks())
      return stream
    }
  })

  const modal = await openPairInitiator(page)
  await modal.getByRole('button', { name: 'Scan QR' }).click()
  await expect(modal.locator('#qr-payload')).toHaveValue('{"channel_id":"777"}', {
    timeout: 30_000,
  })

  // Asserts that nothing is left running, not how many were opened: React's
  // `StrictMode` runs the starting effect twice in development, so two sessions
  // legitimately acquire a camera. The requirement is that every one of them is
  // released.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as { __tracks: MediaStreamTrack[] }
          return w.__tracks.filter(t => t.readyState === 'live').length
        }),
      { timeout: 15_000 },
    )
    .toBe(0)

  const opened = await page.evaluate(
    () => (window as unknown as { __tracks: MediaStreamTrack[] }).__tracks.length,
  )
  expect(opened).toBeGreaterThan(0)
})

test('cancelling the scan returns to paste and releases the camera', async ({ page }) => {
  // No decode: the fake camera's rolling pattern is not a QR, so the loop runs
  // until the user gives up — which is the path this covers.
  await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })

  await page.evaluate(() => {
    const w = window as unknown as { __tracks: MediaStreamTrack[] }
    w.__tracks = []
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await real(constraints)
      w.__tracks.push(...stream.getTracks())
      return stream
    }
  })

  const modal = await openPairInitiator(page)
  await modal.getByRole('button', { name: 'Scan QR' }).click()
  await expect(modal.locator('.qr-scanner__video')).toBeVisible({ timeout: 30_000 })

  await modal.getByRole('button', { name: 'Cancel scan' }).click()

  await expect(modal.locator('#qr-payload')).toBeVisible()
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as { __tracks: MediaStreamTrack[] }
          return w.__tracks.filter(t => t.readyState === 'live').length
        }),
      { timeout: 15_000 },
    )
    .toBe(0)
})

test('closing the modal mid-scan releases the camera', async ({ page }) => {
  await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })

  await page.evaluate(() => {
    const w = window as unknown as { __tracks: MediaStreamTrack[] }
    w.__tracks = []
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await real(constraints)
      w.__tracks.push(...stream.getTracks())
      return stream
    }
  })

  const modal = await openPairInitiator(page)
  await modal.getByRole('button', { name: 'Scan QR' }).click()
  await expect(modal.locator('.qr-scanner__video')).toBeVisible({ timeout: 30_000 })

  // Unmounting is the path most likely to leak, because nothing in the
  // component runs afterwards except its cleanup.
  await modal.getByRole('button', { name: 'Close' }).click()

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as { __tracks: MediaStreamTrack[] }
          return w.__tracks.filter(t => t.readyState === 'live').length
        }),
      { timeout: 15_000 },
    )
    .toBe(0)
})
