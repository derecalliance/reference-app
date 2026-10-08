// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { test, expect } from './fixtures'
import { openApp } from './app'

/**
 * Coming back to the app through the back/forward cache.
 *
 * A page frozen in the cache comes back with every vault released — runtimes
 * stopped and locks given up on `pagehide` — so the app reloads on a
 * `pageshow` whose `persisted` is set, and boot takes everything up again.
 *
 * Playwright launches Chrome with `--disable-back-forward-cache`, which would
 * make this a test of an ordinary history navigation. Dropping that one
 * default is what lets a real cache restore happen here.
 *
 * Driven on the setup screen, with no vault running, because that is the page
 * Chrome actually caches. With a vault running it refuses (the navigation
 * entry's `notRestoredReasons` reads only `masked`; the vault holds a Web Lock
 * and polls its mailbox when the page is hidden), so a back navigation there
 * is an ordinary fresh load, which boot already handles. The listener is the
 * provider's, mounted on every screen, so this is the same code either way.
 */
test.use({ launchOptions: { ignoreDefaultArgs: ['--disable-back-forward-cache'] } })

/** Counted in `sessionStorage`, which survives the reload the restore triggers. */
const RESTORED_KEY = 'e2e:bfcache-restores'

test('a page restored from the back/forward cache reloads itself', async ({ page, pageErrors }) => {
  await page.addInitScript(key => {
    window.addEventListener('pageshow', event => {
      if (!event.persisted) return
      sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? '0') + 1))
    })
  }, RESTORED_KEY)

  await openApp(page)

  // Away and back: the history navigation the cache serves. A page of its own,
  // with an icon of its own, so the detour adds nothing to the console.
  await page.goto('data:text/html,<link rel="icon" href="data:,"><title>Away</title>')
  await page.goBack()

  // Restored from the cache, not re-fetched — otherwise this proves nothing.
  await expect
    .poll(() => page.evaluate(key => sessionStorage.getItem(key), RESTORED_KEY), {
      message: 'the page was not served from the back/forward cache',
    })
    .toBe('1')

  // And then reloaded by the app rather than left running on released state.
  await expect
    .poll(() =>
      page.evaluate(
        () => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type,
      ),
    )
    .toBe('reload')
  await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible()
  // Chrome closes the dev server's hot-reload socket on the way into the cache
  // and says so on the console. That socket exists only under `vite dev`.
  expect(pageErrors.filter(e => !/WebSocket connection .* Page entered Back-Forward Cache/.test(e))).toEqual([])
})
