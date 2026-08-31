import { test, expect } from './fixtures'
import {
  confirmFingerprint,
  expandParticipant,
  pairParticipant,
  setUpOwner,
  tabCount,
} from './app'

/**
 * The three contact modes, end to end against a provisioned participant.
 *
 * What separates them is what the out-of-band contact commits to, and that
 * decides whether the resulting channel is usable straight away:
 *
 * - `InlineKeys` carries the keys, `HashedKeys` carries a hash the fetched keys
 *   are checked against. Both commit, so both pair to `Paired` immediately.
 * - `NoKeys` commits to nothing, so the library holds the channel `Pending`
 *   until a fingerprint is confirmed on both sides.
 *
 * Each test sets up its own owner in its own browser context, so the pool is
 * shared but the owner is not.
 */

test.describe('contact modes', () => {
  test('inline keys pairs immediately', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })

    await pairParticipant(page, { mode: 'Inline keys' })

    expect(await tabCount(page, 'Channels')).toBe(1)
    expect(pageErrors).toEqual([])
  })

  test('hashed keys pairs immediately after the PrePair round-trip', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })

    // The contact carries only a SHA-384 commitment; the scanner fetches the
    // real keys over PrePair and verifies them against it before pairing.
    await pairParticipant(page, { mode: 'Hashed keys' })

    expect(await tabCount(page, 'Channels')).toBe(1)
    expect(pageErrors).toEqual([])
  })

  test('no keys stays pending until the fingerprint is confirmed', async ({ page }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })

    const row = await pairParticipant(page, { mode: 'No keys', expectPaired: false })

    // The gate is the point: nothing binds the keys to the contact, so the
    // channel must not be usable on the strength of the handshake alone.
    await confirmFingerprint(page)

    await expect(row.locator('.status-tag')).toHaveText('Paired', { timeout: 60_000 })
    expect(await tabCount(page, 'Channels')).toBe(1)
  })

  test('refusing a no-keys fingerprint leaves the channel unusable', async ({ page }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })

    const row = await pairParticipant(page, { mode: 'No keys', expectPaired: false })

    // Refusing is the man-in-the-middle outcome: two devices sharing a key
    // always derive the same code, so different codes mean something sat
    // between them. Nothing is written and the channel stays Pending.
    await confirmFingerprint(page, false)

    await expect(row.locator('.status-tag')).not.toHaveText('Paired')
    expect(await tabCount(page, 'Channels')).toBe(0)
  })

  test('one owner can mix modes across participants', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })

    // Mode is per-contact, not per-owner: pairing one participant with inline
    // keys must leave the next free to choose something else.
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Hashed keys' })

    expect(await tabCount(page, 'Channels')).toBe(2)
    expect(pageErrors).toEqual([])
  })

  test('the mode selector disappears once a channel is paired', async ({ page }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })

    const row = await pairParticipant(page, { mode: 'Inline keys' })
    await expandParticipant(page, 0)

    // The mode is fixed when the contact is created, so offering it afterwards
    // would imply it could still be changed.
    await expect(row.getByRole('radio', { name: 'Inline keys' })).toHaveCount(0)
  })
})
