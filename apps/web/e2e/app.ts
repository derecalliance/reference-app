import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'

/**
 * Helpers for driving the app from an end-to-end test.
 *
 * The unit of isolation here is the **browser context**, not the page: the app
 * puts one owner in one browser context (localStorage + a Web Lock per owner),
 * so a second owner — a replica device, a second party in a pairing — needs its
 * own context. `newOwnerContext` is the entry point for that; `openApp` and
 * `setUpOwner` work on whatever page they are handed.
 */

/** Counter sections on the participant-count step, keyed by their visible label. */
type CounterLabel =
  | 'Total participants'
  | 'Minimum paired to protect'
  | 'Recommended paired'
  | 'Pre-pair locally'

export interface OwnerSetupOptions {
  /** Owner name, e.g. `Alice`. Also becomes the tab title. */
  name: string
  /**
   * Target size of the server-wide participant pool. Participants are shared
   * across owners, so this provisions only the shortfall — asking for fewer
   * than already exist removes nothing.
   */
  participants?: number
  /** How many of those to auto-pair, skipping the QR exchange. */
  prePaired?: number
  /** Paired participants below which secret protection is disabled. */
  minParticipants?: number
  /** Paired participants below which the app shows a warning. */
  recommendedParticipants?: number
}

/**
 * Load the app and wait for the setup wizard's first step.
 *
 * Reloads once if the wizard does not appear. The dev server is reused between
 * runs, and a cold or just-invalidated module graph can serve a shell whose
 * scripts never finish evaluating — a blank page that looks exactly like a
 * product bug from the assertion's point of view. One reload separates the two:
 * a genuinely broken app fails the second time too.
 */
export async function openApp(page: Page): Promise<void> {
  const wizard = page.getByRole('heading', { name: 'Get started' })

  await page.goto('./')
  try {
    await expect(wizard).toBeVisible({ timeout: 15_000 })
    return
  } catch {
    await page.reload()
  }
  await expect(wizard).toBeVisible({ timeout: 30_000 })
}

/**
 * Run the setup wizard end to end, leaving `page` on the owner dashboard.
 *
 * Provisioning talks to the backend and pre-pairing runs a full protocol
 * handshake per participant, so this is deliberately generous about waiting for
 * the dashboard to appear.
 */
export async function setUpOwner(page: Page, options: OwnerSetupOptions): Promise<void> {
  await openApp(page)

  await page.getByRole('button', { name: 'Set up a new owner' }).click()

  await expect(page.getByRole('heading', { name: 'Your name' })).toBeVisible()
  await page.getByPlaceholder('e.g. Alice').fill(options.name)
  await page.getByRole('button', { name: /^Next/ }).click()

  await expect(page.getByRole('heading', { name: 'How many participants?' })).toBeVisible()
  // Total first: lowering it clamps the three counters below it.
  await setCounter(page, 'Total participants', options.participants)
  await setCounter(page, 'Minimum paired to protect', options.minParticipants)
  await setCounter(page, 'Recommended paired', options.recommendedParticipants)
  await setCounter(page, 'Pre-pair locally', options.prePaired)
  await page.getByRole('button', { name: /^Next/ }).click()

  await expect(page.getByRole('heading', { name: 'Protocol settings' })).toBeVisible()
  await page.getByRole('button', { name: 'Set up' }).click()

  await expectOwnerDashboard(page)
}

/** Assert that `page` is on the owner dashboard rather than the wizard. */
export async function expectOwnerDashboard(page: Page): Promise<void> {
  await expect(page.getByRole('tab', { name: /Secret Bag/ })).toBeVisible({ timeout: 90_000 })
}

/**
 * Open a second, fully isolated browser context and set an owner up in it.
 *
 * Callers own the returned context and must close it — closing the page is not
 * enough, and a leaked context keeps its owner's Web Lock held.
 */
export async function newOwnerContext(
  browser: Browser,
  options: OwnerSetupOptions,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  const page = await context.newPage()

  try {
    await setUpOwner(page, options)
  } catch (error) {
    await context.close()
    throw error
  }

  return { context, page }
}

/** Contact modes, by the label their radio carries. */
export type ContactMode = 'Inline keys' | 'Hashed keys' | 'No keys'

/** Expand a participant row in the side panel and return it. */
export async function expandParticipant(page: Page, index = 0): Promise<Locator> {
  const row = page.locator('.side-participant-item').nth(index)
  // Idempotent: a row already open must not be collapsed by asking for it.
  if ((await row.locator('.side-participant-header').getAttribute('aria-expanded')) !== 'true') {
    await row.locator('.side-participant-header').click()
  }
  await expect(row.locator('.side-participant-details')).toBeVisible()
  return row
}

/** The name shown on a participant row. */
export async function participantName(page: Page, index = 0): Promise<string> {
  return (await page.locator('.side-participant-item').nth(index)
    .locator('.side-participant-name').innerText()).trim()
}

/**
 * Pair with a provisioned participant, this device initiating.
 *
 * The participant mints the contact, so the mode chosen here is the one that
 * reaches the wire. Resolves once the row reports `Paired` — which for `No
 * keys` only happens after {@link confirmFingerprint}, so that mode should be
 * paired with `expectPaired: false`.
 */
export async function pairParticipant(
  page: Page,
  options: { index?: number; mode: ContactMode; expectPaired?: boolean },
): Promise<Locator> {
  const row = await expandParticipant(page, options.index ?? 0)

  // The radio itself is visually hidden — the styled label is the hit target,
  // so `check()` on the input fails its actionability wait.
  await row.locator('label.role-option').filter({ hasText: options.mode }).click()
  await expect(row.getByRole('radio', { name: options.mode })).toBeChecked()

  await row.getByRole('button', { name: 'Pair', exact: true }).click()

  if (options.expectPaired !== false) {
    await expect(row.locator('.status-tag')).toHaveText('Paired', { timeout: 60_000 })
  } else {
    // A gated pairing must never read as Paired on the strength of the
    // handshake alone — that is the failure this mode exists to prevent.
    await expect(row.locator('.status-tag')).toHaveText('Unconfirmed', { timeout: 60_000 })
  }
  return row
}

/**
 * Resolve the out-of-band fingerprint dialog a `NoKeys` pairing raises.
 *
 * Both codes come from the same shared key, so a fixture peer always matches;
 * `accept: false` exercises the refusal path instead, which is the
 * man-in-the-middle outcome and leaves the channel `Pending`.
 */
export async function confirmFingerprint(page: Page, accept = true): Promise<void> {
  const dialog = page.getByRole('dialog').filter({ hasText: 'Confirm' })
  await expect(dialog).toBeVisible({ timeout: 60_000 })
  // Both codes must be on screen before anyone can claim to have compared them.
  await expect(dialog.getByText(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/).first())
    .toBeVisible()

  await dialog.getByRole('button', { name: accept ? 'Codes match' : 'Doesn’t match' }).click()

  if (accept) {
    await expect(dialog).toBeHidden({ timeout: 30_000 })
  } else {
    await expect(dialog.getByText(/something sat between them/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Done' }).click()
  }
}

/**
 * Protect a secret across every paired participant.
 *
 * Resolves once the Secret Bag tab reports the entry, which only happens when
 * the round reaches its threshold — so this waits on the protocol completing,
 * not merely on the request being dispatched.
 */
export async function protectSecret(
  page: Page,
  name: string,
  data: string,
): Promise<void> {
  // No wait for other rounds to finish: they are keyed by version and run
  // independently, so one already in flight — from a pairing auto-publish, say
  // — neither blocks this one nor is disturbed by it. The button is disabled
  // only for too few paired helpers, which is a standing condition.
  const before = await tabCount(page, 'Secret Bag')
  const start = page.getByRole('button', { name: /^(Protect Secret|Add Secret)$/ })
  await expect(start).toBeEnabled({ timeout: 120_000 })
  await start.click()

  const form = page.locator('.modal-overlay[aria-label="Add secret"] .modal')
  await form.locator('#ps-name').fill(name)
  await form.getByLabel('Secret data').fill(data)
  await form.getByRole('button', { name: /^(Protect|Add Secret)$/ }).click()

  // The form is replaced in place by a per-participant progress view, which
  // stays up (and keeps intercepting clicks) until dismissed.
  const overlay = page.locator('.modal-overlay[aria-label="Add secret"]')
  const done = overlay.getByRole('button', { name: 'Done' })
  await expect(done).toBeVisible({ timeout: 90_000 })
  await done.click()
  await expect(overlay).toBeHidden({ timeout: 30_000 })

  // Asserts the bag grew rather than a fixed count: the same helper is used for
  // the second and later secrets, which land in the same bag.
  //
  // Generous, because the bag is committed on `SharingComplete` and that event
  // is withheld until the *replica* leg settles as well as the helper leg. One
  // slow member therefore delays it by up to the sharing-round timeout, even
  // though every helper answered in milliseconds.
  await expect
    .poll(() => tabCount(page, 'Secret Bag'), { timeout: 120_000 })
    .toBeGreaterThan(before)
}

/** How many participants confirmed the last protect round, as the modal reports it. */
export async function protectAndReadConfirmations(
  page: Page,
  name: string,
  data: string,
): Promise<string> {
  // Rounds start on their own — pairing a helper auto-publishes, and
  // confirming a gated channel publishes from `verifyFingerprint` — and the
  // library keeps one round per secret. The button stays disabled until the
  // one in flight resolves, so waiting on it is waiting for quiescence.
  const start = page.getByRole('button', { name: /^(Protect Secret|Add Secret)$/ })
  await expect(start).toBeEnabled({ timeout: 120_000 })
  await start.click()

  const form = page.locator('.modal-overlay[aria-label="Add secret"] .modal')
  await form.locator('#ps-name').fill(name)
  await form.getByLabel('Secret data').fill(data)
  await form.getByRole('button', { name: /^(Protect|Add Secret)$/ }).click()

  const overlay = page.locator('.modal-overlay[aria-label="Add secret"]')
  await expect(overlay.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 90_000 })
  const summary = await overlay.innerText()

  await overlay.getByRole('button', { name: 'Done' }).click()
  await expect(overlay).toBeHidden({ timeout: 30_000 })
  return summary
}

/**
 * Ask every recovery-paired helper what it holds for this secret.
 *
 * Resolves once each helper has answered — the row moves from `Pending` to
 * `Discovered`, which is the only thing that says the helper replied rather
 * than the request merely having been dispatched.
 */
export async function discoverAll(page: Page): Promise<void> {
  await openTab(page, 'Recovery')
  await page.getByRole('button', { name: 'Discover All' }).click()

  await expect(page.locator('.tab-panel')).not.toContainText(/pending/i, { timeout: 90_000 })
  await expect(page.locator('.tab-panel')).toContainText(/discovered/i)
}

/**
 * Reconstruct the offered secret version from the helpers' shares.
 *
 * Requires {@link discoverAll} first: a version can only be recovered once
 * enough helpers have said they hold it.
 */
export async function recoverOfferedSecret(page: Page): Promise<void> {
  // One button per offered version, so a secret protected twice offers two.
  // Versions are listed newest-first, and the newest is what we want: the bag
  // is cumulative, so recovering an older version returns a subset and would
  // still satisfy a "something came back" assertion.
  const recover = page.getByRole('button', { name: 'Recover', exact: true }).first()
  await expect(recover).toBeVisible({ timeout: 60_000 })
  await recover.click()

  await expect(page.locator('.tab-panel')).toContainText(/recovered/i, { timeout: 120_000 })
}

/**
 * Tear down a helper channel from this side.
 *
 * Destructive on both sides — it drops the shared key, the channel record and
 * every share stored under it — so the app puts it behind a confirmation, and
 * the peer must acknowledge before local state goes.
 */
export async function unpairParticipant(page: Page, index = 0): Promise<string> {
  const row = await expandParticipant(page, index)
  const name = (await row.locator('.side-participant-name').innerText()).trim()

  await row.getByRole('button', { name: 'Unpair', exact: true }).click()

  const dialog = page.locator('.modal-overlay').filter({ hasText: 'Unpair channel?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Unpair', exact: true }).click()

  return name
}

// ── Replicas ────────────────────────────────────────────────────────────────
//
// A replica is another device holding a mirror of the whole vault, not a share
// of it. Provisioned replicas are backend fixtures, which is what makes a group
// of three testable from one browser context: this device is the `Source` and
// each fixture is a `Destination`.

/** The "Provisioned replicas" side-panel section. */
function replicaSection(page: Page): Locator {
  return page.locator('.side-panel-section').filter({ hasText: 'Provisioned replicas' })
}

/**
 * A replica's row in the side panel, by the name it was added under.
 *
 * Matched on the whole name, not a substring: provisioned replicas belong to
 * the *server*, so every replica any test has added is listed for every owner,
 * and a loose match would resolve to several rows.
 */
function replicaRow(page: Page, name: string): Locator {
  return replicaSection(page)
    .locator('.side-participant-item')
    .filter({ has: page.locator('.side-participant-name', { hasText: new RegExp(`^${name}$`) }) })
}

/**
 * A replica name nothing else on the server will collide with.
 *
 * Uniqueness has to survive more than the current test. The replica pool is
 * server-wide, and the dev backend is *reused between runs* — so a counter
 * would hand out `Device-1` again on the next `playwright test` and match the
 * row a previous run left behind. The random suffix is what makes the name
 * unique per run rather than per process.
 */
export function uniqueReplicaName(prefix = 'Device'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

/** Provision a backend-hosted replica of this vault. */
export async function addReplica(page: Page, name: string): Promise<void> {
  await replicaSection(page).getByRole('button', { name: '+ Add' }).click()

  const modal = page.locator('.modal').filter({ hasText: 'Add Replica' })
  await modal.locator('input[type="text"]').fill(name)
  await modal.getByRole('button', { name: 'Add Replica' }).click()

  await expect(replicaRow(page, name)).toBeVisible({ timeout: 30_000 })
}

/**
 * Pair a provisioned replica and confirm the fingerprint on both sides.
 *
 * Every replica pairing is gated regardless of contact mode, so the channel
 * sits `Pending` until the comparison is resolved — this device confirms its
 * own side and stands in for the fixture, which has no screen.
 */
export async function pairReplica(page: Page, name: string): Promise<void> {
  const row = replicaRow(page, name)
  await row.locator('.side-participant-header').click()
  await row.getByRole('button', { name: 'Pair', exact: true }).click()

  await confirmFingerprint(page)
  await expect(row.locator('.status-tag')).toHaveText('Paired', { timeout: 60_000 })
}

/**
 * Add and fully pair a replica.
 *
 * No wait for the publish its confirmation kicks off: rounds are keyed by
 * version, so a second replica joining while the first's round is still open
 * is safe.
 */
export async function addAndPairReplica(page: Page, name: string): Promise<void> {
  await addReplica(page, name)
  await pairReplica(page, name)
}

/**
 * How many replica channel rows this owner has.
 *
 * Not the Replicas tab badge: that also counts provisioned replicas awaiting
 * pairing, and provisioned replicas are server-wide, so every fixture any other
 * owner ever created is in that number.
 */
export async function replicaChannelCount(page: Page): Promise<number> {
  return page
    .locator('.replicas-tab-section')
    .filter({ hasText: 'Replica channels' })
    .locator('.channel-block')
    .count()
}

/** The count badge on a dashboard tab. */
export async function tabCount(
  page: Page,
  name: 'Channels' | 'Replicas' | 'Secret Bag' | 'Shares' | 'Recovery',
): Promise<number> {
  const text = await page.getByRole('tab', { name: new RegExp(`^${name}`) }).innerText()
  return Number(text.replace(/\D+/g, '') || '0')
}

/** Switch the owner dashboard to one of its tabs. */
export async function openTab(
  page: Page,
  name: 'Channels' | 'Replicas' | 'Secret Bag' | 'Shares' | 'Recovery',
): Promise<void> {
  await page.getByRole('tab', { name: new RegExp(`^${name}`) }).click()
}

/**
 * Drive one of the wizard's +/− counters to `target`.
 *
 * The counters are steppers with no text input, so the only way to a value is
 * to click towards it. Clamping is enforced by the component (a stepper
 * disables at its bound), so this asserts the value it landed on rather than
 * assuming the clicks all took effect.
 */
async function setCounter(page: Page, label: CounterLabel, target?: number): Promise<void> {
  if (target === undefined) return

  const section = page.locator('.participant-count-section', { hasText: label })
  const value = section.locator('.count')
  // Each section holds exactly one of each, distinguished only by aria-label —
  // the visible text is a bare +/− glyph.
  const increase = section.getByRole('button', { name: /^Increase/ })
  const decrease = section.getByRole('button', { name: /^Decrease/ })

  const read = async (): Promise<number> => Number(await value.innerText())

  // Bounded so a counter that refuses to move fails here instead of hanging.
  for (let step = 0; step < 100; step += 1) {
    const current = await read()
    if (current === target) break
    await (current < target ? increase : decrease).click()
  }

  await expect(value).toHaveText(String(target))
}
