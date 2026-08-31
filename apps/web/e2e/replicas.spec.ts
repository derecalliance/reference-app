import { test, expect } from './fixtures'
import {
  addAndPairReplica,
  addReplica,
  openTab,
  pairParticipant,
  protectSecret,
  replicaChannelCount,
  setUpOwner,
  uniqueReplicaName,
} from './app'

/**
 * Replica groups: this device as `Source` plus provisioned `Destination`
 * fixtures.
 *
 * Using fixtures rather than extra browser contexts is what makes a group of
 * three tractable — the protocol path is identical, and the fixture has no
 * screen so this device drives both ends of the fingerprint comparison.
 *
 * Names come from `uniqueReplicaName` because the replica pool is server-wide
 * and the dev backend is reused between runs: a fixed name would match rows an
 * earlier run left behind.
 *
 * Source succession is deliberately not covered. The library's promotion is not
 * yet implemented end to end, so a group whose source leaves is left without
 * one — a known gap, not something these tests assert around.
 */

test.describe('replica groups', () => {
  test('a replica is not paired until the fingerprint is confirmed', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })

    const name = uniqueReplicaName()
    await addReplica(page, name)

    // Provisioned, but no handshake has run yet. Every replica pairing is gated
    // regardless of contact mode, so nothing moves until both sides confirm.
    const row = page.locator('.side-participant-item')
      .filter({ has: page.locator('.side-participant-name', { hasText: new RegExp(`^${name}$`) }) })
    await expect(row.locator('.status-tag')).toHaveText('Not paired')

    expect(pageErrors).toEqual([])
  })

  test('a three-member group forms', async ({ page }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })

    // This device is the source; the two fixtures are destinations.
    await addAndPairReplica(page, uniqueReplicaName('Laptop'))
    await addAndPairReplica(page, uniqueReplicaName('Phone'))

    await openTab(page, 'Replicas')
    expect(await replicaChannelCount(page)).toBe(2)
  })

  test('the group mirrors a protected secret to every member', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })

    // Admit both replicas *before* the first protect. This ordering used to
    // hang: each replica's fingerprint confirmation publishes a round of its
    // own, so by the time the user protects, the library is several versions
    // ahead of anything the app could infer — and the progress dialog was
    // deriving the round version from its own bag history. It is the ordering
    // most likely to regress, so it is the one covered.
    await addAndPairReplica(page, uniqueReplicaName())
    await addAndPairReplica(page, uniqueReplicaName())
    await protectSecret(page, 'Passphrase', 'hunter2')

    await openTab(page, 'Replicas')
    // Every member acknowledges the version the round published. A member that
    // is behind does not fail the round — replicas are best-effort — so this
    // asserts the acknowledgement, not merely that a round ran.
    const mirrored = page.getByText(/Mirrored v\d+, acknowledged/)
    await expect(mirrored).toHaveCount(2, { timeout: 90_000 })

    expect(pageErrors).toEqual([])
  })

  test('a paired group offers a sync check', async ({ page }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await addAndPairReplica(page, uniqueReplicaName())

    await openTab(page, 'Replicas')
    // SyncCheck takes no parameters — it asks the whole group at once, so it
    // belongs on the section header rather than on a channel row.
    const check = page.getByRole('button', { name: 'Check sync' })
    await expect(check).toBeVisible()
    await check.click()

    await expect(check).toBeEnabled({ timeout: 60_000 })
  })

  test('evicting a member removes it from the group and the roster', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })
    await addAndPairReplica(page, uniqueReplicaName())

    // Eviction only completes once a roster that omits the member is
    // published, so the vault has to hold something to publish.
    await protectSecret(page, 'Passphrase', 'hunter2')

    await openTab(page, 'Replicas')
    const remove = page.getByRole('button', { name: 'Remove from group' })
    await expect(remove).toBeVisible({ timeout: 60_000 })
    await remove.click()

    await expect(remove).toBeHidden({ timeout: 90_000 })
    // Polled: the button goes as soon as the row re-renders, while the roster
    // it was rendered from settles a beat later.
    await expect.poll(() => replicaChannelCount(page), { timeout: 60_000 }).toBe(0)

    // The member is gone from the library's own roster, not just from the UI.
    // Polled: the roster row drops when the roster that omits the member has
    // been published and round-tripped, which lands after the UI has already
    // stopped showing it.
    const memberRoles = () =>
      page.evaluate(() => {
        const roles: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)!
          if (!key.includes(':channel:replica:')) continue
          const text = atob(localStorage.getItem(key)!.replace(/-/g, '+').replace(/_/g, '/'))
          roles.push(/"role":"(\w+)"/.exec(text)?.[1] ?? '?')
        }
        return roles.sort()
      })
    await expect.poll(memberRoles, { timeout: 90_000 }).toEqual(['Source'])

    expect(pageErrors).toEqual([])
  })
})
