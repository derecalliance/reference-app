import { test, expect } from './fixtures'
import { newOwnerContext, openApp, openTab, setUpOwner } from './app'

/**
 * Proves the end-to-end harness itself: the backend is up, Vite serves under
 * its `/reference-app/` base, the WASM protocol library loads in a headless
 * browser, and a browser context can be taken from a cold start to a working
 * owner. Everything else builds on these.
 */

test('the app loads and reaches the backend', async ({ page, pageErrors }) => {
  await openApp(page)

  await expect(page).toHaveTitle('DeRec Reference App')
  // Rendered only when the config probe fails, so its absence is the assertion.
  await expect(page.getByText('Is the backend running?')).toHaveCount(0)
  expect(pageErrors).toEqual([])
})

test('the setup wizard produces a working owner', async ({ page }) => {
  await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })

  await expect(page).toHaveTitle('Alice · DeRec')
  await expect(page.getByRole('button', { name: 'Leave' })).toBeVisible()

  await openTab(page, 'Secret Bag')
  await expect(page.getByRole('tab', { name: /Secret Bag/, selected: true })).toBeVisible()
})

test('pre-pairing pairs the requested participants', async ({ page }) => {
  await setUpOwner(page, { name: 'Bob', participants: 3, prePaired: 2, minParticipants: 2 })

  // The tab's count badge is what the app itself reports as paired channels.
  await expect(page.getByRole('tab', { name: /^Channels/ })).toContainText('2')
})

test('two browser contexts are two independent owners', async ({ browser }) => {
  const first = await newOwnerContext(browser, { name: 'Alice', participants: 3, prePaired: 0 })
  const second = await newOwnerContext(browser, { name: 'Bob', participants: 3, prePaired: 0 })

  try {
    await expect(first.page).toHaveTitle('Alice · DeRec')
    await expect(second.page).toHaveTitle('Bob · DeRec')
  } finally {
    await first.context.close()
    await second.context.close()
  }
})
