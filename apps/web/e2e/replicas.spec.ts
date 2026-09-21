import { test, expect } from './fixtures'
import {
  addAndPairReplica,
  addReplica,
  dismissReplicaFingerprint,
  openTab,
  pairParticipant,
  pairReplica,
  protectSecret,
  replicaChannelCount,
  replicaChannelRow,
  setUpOwner,
  uniqueReplicaName,
} from './app'

/**
 * Replica groups: this device as `Source` plus provisioned `Destination`
 * fixtures.
 *
 * The `Destination`s are ordinary provisioned helpers paired in replica mode —
 * a replica is a pairing mode, not a kind of actor. Using them rather than
 * extra browser contexts is what makes a group of three tractable: the protocol
 * path is identical, and an unattended fixture auto-confirms its own
 * fingerprint, so this device only ever compares its own.
 *
 * Names come from `uniqueReplicaName` because actors are server-wide and the
 * dev backend is reused between runs: a fixed name would match rows an earlier
 * run left behind.
 *
 * Source succession is deliberately not covered. The library's promotion is not
 * yet implemented end to end, so a group whose source leaves is left without
 * one — a known gap, not something these tests assert around.
 */

test.describe('replica groups', () => {
  test('a replica is not paired until the fingerprint is confirmed', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })

    const name = uniqueReplicaName()
    // Returns with the handshake complete and the comparison raised, but not
    // answered.
    await addReplica(page, name)

    // Put the comparison away unanswered. Dismissing writes nothing, so this
    // leaves precisely the state under test — and it is what makes the tab
    // reachable at all, since the open modal hides the rest of the app from
    // the accessibility tree.
    await dismissReplicaFingerprint(page, name)

    // The handshake alone must never be enough. Every replica pairing is gated
    // regardless of contact mode, so a channel whose codes nobody has compared
    // stays `Pending` and carries no secret — asserted on the owner's own row,
    // which is the side the gate is for. The helper's side is not observable
    // from here and is not what this test is about.
    await openTab(page, 'Replicas')
    const row = replicaChannelRow(page, name)
    await expect(row.locator('.status-tag')).toHaveText('Pending confirmation')

    // And confirming is what lifts it — otherwise the assertion above would
    // pass just as well against a replica flow that had stopped working
    // entirely. The row's own prompt is the standing way back into a dismissed
    // comparison, so this covers that route too.
    await row.getByRole('button', { name: 'Confirm fingerprint' }).click()
    await pairReplica(page, name)
    await expect(row.locator('.status-tag')).toHaveText('Verified', { timeout: 60_000 })

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

  /**
   * A replica row must always have a way off the screen.
   *
   * The row used to carry an "Unpair" that dispatched `Unpair { channel_id }`,
   * the *helper* teardown. The library stores group members by replica id and
   * never by channel id, so it rejected that on every replica channel — a
   * healthy, verified, actively-mirroring one included — with "channel id not
   * present in channel store". Nothing else could clear the row, so a pairing
   * that went wrong was permanent.
   */
  test('a replica row offers no helper-style Unpair', async ({ page, pageErrors }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    const name = uniqueReplicaName()
    await addAndPairReplica(page, name)

    await openTab(page, 'Replicas')
    const row = replicaChannelRow(page, name)
    await expect(row.locator('.status-tag')).toHaveText('Verified', { timeout: 60_000 })

    // The action that never worked is gone, and the one that always works is
    // there in its place.
    await expect(row.getByRole('button', { name: 'Unpair' })).toHaveCount(0)
    await expect(row.getByRole('button', { name: 'Forget' })).toBeVisible()

    expect(pageErrors).toEqual([])
  })

  test('Forget clears a replica row without any protocol call failing', async ({
    page,
    pageErrors,
  }) => {
    const failures: string[] = []
    page.on('console', message => {
      if (message.type() === 'error') failures.push(message.text())
    })

    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    const name = uniqueReplicaName()
    await addAndPairReplica(page, name)

    await openTab(page, 'Replicas')
    const row = replicaChannelRow(page, name)
    await row.getByRole('button', { name: 'Forget' }).click()

    // Confirmed rather than immediate: nothing goes out on the wire, and the
    // modal is the only place the user can learn that.
    const confirm = page.locator('.modal-overlay').filter({ hasText: 'Forget this replica?' })
    await expect(confirm).toContainText('is not told')
    await confirm.getByRole('button', { name: 'Forget' }).click()

    await expect.poll(() => replicaChannelCount(page), { timeout: 30_000 }).toBe(0)

    // The point of the escape hatch: it cannot fail. A dispatched flow that the
    // library refuses would land here, which is exactly how the old Unpair
    // behaved.
    expect(failures.filter(text => /unpair|channel store/i.test(text))).toEqual([])
    expect(pageErrors).toEqual([])
  })

  /**
   * Forget is app-side only, and that is a real cost: the library goes on
   * counting the member, so its replica id stays taken and the device behind it
   * is refused on every attempt to pair again — with nothing on screen to
   * explain why. The orphan list is what makes that state visible and clearable.
   */
  test('a member the app has forgotten is still listed, and can be evicted', async ({
    page,
    pageErrors,
  }) => {
    await setUpOwner(page, { name: 'Alice', participants: 3, prePaired: 0, minParticipants: 2 })
    // Eviction completes by publishing a roster, so the vault needs a secret to
    // publish — and protecting one needs the configured minimum of helpers.
    await pairParticipant(page, { index: 0, mode: 'Inline keys' })
    await pairParticipant(page, { index: 1, mode: 'Inline keys' })

    const name = uniqueReplicaName()
    await addAndPairReplica(page, name)
    await protectSecret(page, 'Passphrase', 'hunter2')

    await openTab(page, 'Replicas')
    await replicaChannelRow(page, name).getByRole('button', { name: 'Forget' }).click()
    await page
      .locator('.modal-overlay')
      .filter({ hasText: 'Forget this replica?' })
      .getByRole('button', { name: 'Forget' })
      .click()
    await expect.poll(() => replicaChannelCount(page), { timeout: 30_000 }).toBe(0)

    // The row is gone, but the member is not — and the tab says so rather than
    // claiming there are no replicas.
    const orphans = page
      .locator('.replicas-tab-section')
      .filter({ hasText: 'Group members with no channel' })
    await expect(orphans).toBeVisible({ timeout: 30_000 })
    await expect(orphans).toContainText('Destination')

    // This device's own Source entry is the group, not a peer in it, so exactly
    // one member is listed.
    await expect(orphans.locator('.channel-block')).toHaveCount(1)

    await orphans.getByRole('button', { name: 'Remove from group' }).click()
    await expect(orphans).toBeHidden({ timeout: 90_000 })

    // Gone from the library's own store, not just from the page — only this
    // device's `Source` entry is left.
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
