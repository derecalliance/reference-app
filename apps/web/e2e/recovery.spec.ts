import { test, expect } from './fixtures'
import {
  discoverAll,
  openTab,
  pairParticipant,
  protectSecret,
  recoverOfferedSecret,
  setUpOwner,
  tabCount,
  unpairParticipant,
} from './app'

/**
 * The flows that make protecting a secret worth doing: getting it back, and
 * taking a helper out of the set that holds it.
 *
 * These are the point of the protocol, and until now the only coverage they had
 * was unit-level. Recovery in particular exercises the longest path in the
 * library — discovery, share retrieval, reconstruction, and the `restore` that
 * rebuilds the `secret_id` namespace from the recovered roster.
 */

test.describe('recovery', () => {
  test('a protected secret can be discovered and reconstructed', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })
    await protectSecret(page, 'Passphrase', 'hunter2')

    // Discovery is a real round trip, not a local read: each helper answers
    // with the versions it is actually holding for this secret.
    await discoverAll(page)
    await expect(page.locator('.tab-panel')).toContainText('v1')

    await recoverOfferedSecret(page)

    // Reconstructed from the helpers' shares, and it is the secret that was
    // protected — not merely "a recovery completed".
    await expect(page.locator('.tab-panel')).toContainText('Passphrase')
    expect(await tabCount(page, 'Recovery')).toBeGreaterThan(0)
    expect(pageErrors).toEqual([])
  })

  test('recovery finds every version the helpers hold', async ({ page }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })

    await protectSecret(page, 'Passphrase', 'hunter2')
    await protectSecret(page, 'Recovery code', '123456')

    await discoverAll(page)
    await recoverOfferedSecret(page)

    // The bag is recovered whole, so both secrets come back together — a
    // recovery that returned only the newest entry would still pass a
    // "something was recovered" assertion.
    await expect(page.locator('.tab-panel')).toContainText('Passphrase')
    await expect(page.locator('.tab-panel')).toContainText('Recovery code')
  })

  test('restoring from a recovered bag rebuilds this device from it', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })
    await protectSecret(page, 'Passphrase', 'hunter2')

    await discoverAll(page)
    await recoverOfferedSecret(page)

    // Recovering reconstructs the bag; *restoring* is the separate, explicit
    // step that commits it into this device's canonical state via
    // `protocol.restore`, and announces the new endpoint to the helpers with
    // `UpdateChannelInfo`. It is the most destructive action in the app, so it
    // sits behind a confirmation whose default is Cancel.
    const restore = page.getByRole('button', { name: 'Recover', exact: true }).last()
    await restore.click()

    const dialog = page.locator('.modal-overlay').filter({ hasText: 'Recover from this bag?' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Recover from bag' }).click()

    // Back on a working vault: the restored bag is this device's own.
    //
    // The tab is re-opened on every poll rather than once up front. `restore`
    // rebuilds this device's state and lands it on a tab of its own choosing,
    // so a single click placed before that completes gets overridden — the
    // assertion then reads whichever panel restore settled on. Re-clicking
    // converges whatever the ordering.
    await expect
      .poll(
        async () => {
          await openTab(page, 'Secret Bag')
          return page.locator('.tab-panel').innerText()
        },
        { timeout: 120_000 },
      )
      .toContain('Passphrase')
    expect(pageErrors).toEqual([])
  })

  test('cancelling the restore confirmation changes nothing', async ({ page }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })
    await protectSecret(page, 'Passphrase', 'hunter2')

    await discoverAll(page)
    await recoverOfferedSecret(page)

    const before = await tabCount(page, 'Channels')
    await page.getByRole('button', { name: 'Recover', exact: true }).last().click()

    const dialog = page.locator('.modal-overlay').filter({ hasText: 'Recover from this bag?' })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()

    // Nothing was replaced, unlinked, or left mid-restore.
    expect(await tabCount(page, 'Channels')).toBe(before)
  })
})

test.describe('unpairing', () => {
  test('unpairing a helper tears the channel down on this side', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })
    await protectSecret(page, 'Passphrase', 'hunter2')

    expect(await tabCount(page, 'Channels')).toBe(2)

    const name = await unpairParticipant(page, 0)

    // The channel goes, and the participant returns to the pool as pairable —
    // it is the *channel* that was torn down, not the actor.
    await expect.poll(() => tabCount(page, 'Channels'), { timeout: 90_000 }).toBe(1)
    const row = page.locator('.side-participant-item')
      .filter({ has: page.locator('.side-participant-name', { hasText: new RegExp(`^${name}$`) }) })
    await expect(row.locator('.status-tag')).toHaveText('Available', { timeout: 60_000 })

    expect(pageErrors).toEqual([])
  })

  test('the secret survives losing one helper of two', async ({ page }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })
    await protectSecret(page, 'Passphrase', 'hunter2')

    await unpairParticipant(page, 0)
    await expect.poll(() => tabCount(page, 'Channels'), { timeout: 90_000 }).toBe(1)

    // Unpairing drops the shares held under that channel, but the owner's own
    // bag is not one of them.
    await openTab(page, 'Secret Bag')
    await expect(page.locator('.tab-panel')).toContainText('Passphrase')
  })
})
