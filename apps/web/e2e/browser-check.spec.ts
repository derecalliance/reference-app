import { test, expect } from './fixtures'

/**
 * Guards which browser the suite actually runs in.
 *
 * `channel: 'chrome'` in the config is the instruction; this is the check that
 * it took effect. Without it Playwright launches its own bundled Chromium,
 * which reports itself as Chromium and is a different binary from the one this
 * app is meant to be exercised against — and on a machine with several
 * Chromium-derived browsers installed, "it opened a browser" is not evidence it
 * opened the right one.
 */
test('the suite runs in Google Chrome', async ({ page, browser }) => {
  await page.goto('./')

  const brands = await page.evaluate(
    () =>
      (
        navigator as unknown as { userAgentData?: { brands: Array<{ brand: string }> } }
      ).userAgentData?.brands.map(b => b.brand) ?? [],
  )
  const userAgent = await page.evaluate(() => navigator.userAgent)

  // Brave identifies itself in the UA; bundled Chromium omits the Google
  // Chrome brand that only a real Chrome build carries.
  expect(userAgent).not.toMatch(/Brave/i)
  expect(brands).toContain('Google Chrome')
  expect(browser.version()).toMatch(/^\d+\./)
})
