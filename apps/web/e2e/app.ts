// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { expect, type APIResponse, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'

/**
 * Helpers for driving the app from an end-to-end test.
 *
 * The unit of isolation here is the **browser context**, not the page: the app
 * puts one owner in one browser context (localStorage + a Web Lock per owner),
 * so a second owner — a replica device, a second party in a pairing — needs its
 * own context. `newOwnerContext` is the entry point for that; `openApp` and
 * `setUpOwner` work on whatever page they are handed.
 */

/**
 * Where this run's backend listens; the app is served separately by Vite.
 *
 * The suite's own port, not the app's default 5000 — a developer's node on the
 * default would otherwise be the one these specs provision against. Kept in
 * step with `playwright.config.ts`, which starts it.
 */
export const BACKEND_PORT = 5100
export const BACKEND_URL = `http://localhost:${BACKEND_PORT}`

/** The node's versioned API, where everything but the DeRec transport lives. */
export const BACKEND_API_URL = `${BACKEND_URL}/api/v1`

/** The `result` of an API answer, which travels in the node's envelope. */
export async function resultOf<T>(response: APIResponse): Promise<T> {
  const body = (await response.json()) as { result: T }
  return body.result
}

/** Pool size for a spec that does not name one — enough for a threshold of 2. */
const DEFAULT_POOL_SIZE = 3

/**
 * Counter sections in the wizard, keyed by their visible label.
 *
 * Only the owner's own settings are still driven through the UI; the node-level
 * counters moved to the Settings pane and are seeded through its stored
 * override instead — see `seedNodeDefaults`.
 */
type CounterLabel = 'Pre-pair locally'

/**
 * Target composition of the shared helper pool by transport mode. Mirrors
 * `TransportMix` in `src/transportMix.ts` — kept local rather than imported so
 * the e2e project stays self-contained (its `tsconfig.e2e.json` only includes
 * `e2e`, not `src`).
 */
export interface TransportMix {
  http: number
  grpc: number
  both: number
}

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
  /**
   * Target composition of the helper pool by transport. The three counters
   * rebalance each other, so only `grpc` and `both` are driven explicitly —
   * `http` is left to absorb whatever they do not take.
   */
  transports?: TransportMix
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
  await ensurePool(page, options)
  await seedNodeDefaults(page, options)
  await openApp(page)
  await runSetupWizard(page, options)
}

/**
 * Set up one more vault in a browser that already holds some, from the list.
 *
 * The node's pool and defaults were seeded by the first `setUpOwner`, and the
 * list — not the empty-state greeting — is the home screen now.
 */
export async function setUpAnotherVault(page: Page, options: OwnerSetupOptions): Promise<void> {
  await backToVaults(page)
  await runSetupWizard(page, options)
}

/** Leave the vault on screen for the list. Nothing stops: it keeps running. */
export async function backToVaults(page: Page): Promise<void> {
  if (!(await page.getByRole('heading', { name: 'Your vaults' }).isVisible())) {
    await page.getByRole('button', { name: 'All vaults' }).click()
  }
  await expect(page.getByRole('heading', { name: 'Your vaults' })).toBeVisible()
}

/** Open a vault from the list by name, leaving `page` on its dashboard. */
export async function openVault(page: Page, name: string): Promise<void> {
  await backToVaults(page)
  await page.getByRole('button', { name: `Open ${name}`, exact: true }).click()
  await expectOwnerDashboard(page)
}

/** The wizard, from its first click to the new vault's dashboard. */
async function runSetupWizard(page: Page, options: OwnerSetupOptions): Promise<void> {
  await page.getByRole('button', { name: 'Set up a new vault' }).click()

  await expect(page.getByRole('heading', { name: 'Your name' })).toBeVisible()
  await page.getByPlaceholder('e.g. Alice').fill(options.name)
  await page.getByRole('button', { name: /^Next/ }).click()

  // What is left in the wizard is what belongs to the owner rather than the
  // node: the timeout, and how many participants to pre-pair.
  await expect(page.getByRole('heading', { name: 'Your settings' })).toBeVisible()
  // The step is inert until the node has answered — its defaults and the
  // pre-pair ceiling are unknown before then. Waiting here is what keeps a
  // counter from being read as "…" or set against a ceiling not yet known.
  await expect(page.getByRole('button', { name: 'Set up', exact: true })).toBeEnabled()
  await setCounter(page, 'Pre-pair locally', options.prePaired)
  await page.getByRole('button', { name: 'Set up' }).click()

  await expectOwnerDashboard(page)
}

/** How many participants this node runs right now. */
export async function poolSize(page: Page): Promise<number> {
  const response = await page.request.get(`${BACKEND_API_URL}/actors`)
  const body = await resultOf<{
    actors: { role: string; browser_managed?: boolean }[]
  }>(response)
  return body.actors.filter(a => a.role === 'helper' && !a.browser_managed).length
}

/**
 * Make sure the node runs the participants this test needs.
 *
 * Setting up an owner deliberately provisions nothing: the pool belongs to the
 * node, and an owner that grew it would undo an operator's decision to remove
 * one. Growing the pool is an operator action, so the harness performs it the
 * way an operator would — against the same endpoint the Participants pane
 * calls — rather than the wizard doing it as a side effect.
 *
 * Only the shortfall is created, so this is safe to call from every spec even
 * though they share one backend.
 */
async function ensurePool(page: Page, options: OwnerSetupOptions): Promise<void> {
  const total = options.participants ?? DEFAULT_POOL_SIZE
  if (total <= 0) return

  const transports = options.transports ?? { http: total, grpc: 0, both: 0 }
  const response = await page.request.post(`${BACKEND_API_URL}/helpers/ensure`, {
    data: {
      total,
      // Unique per call: the pool is shared and only the shortfall is
      // created, so a fixed name would collide with one an earlier spec left
      // behind — and the helpers that reach participants by name would then
      // match two rows.
      names: Array.from({ length: total }, () => uniqueReplicaName('Fixture')),
      transports,
    },
  })
  if (!response.ok()) {
    throw new Error(
      `could not provision the pool (${response.status()}): ${await response.text()}`,
    )
  }
}

/**
 * Put the node-level options in place before the app loads.
 *
 * Pool size, thresholds and transport mix are no longer asked for during setup
 * — they belong to the node and are configured under Settings. Rather than
 * reach past the app to the backend, this writes the same browser-local
 * override the Settings pane writes, so the tests exercise the real mechanism
 * and a change to it fails here rather than silently diverging.
 *
 * Stored as a *partial*: anything a test does not name keeps following the
 * node's own defaults, exactly as the pane behaves.
 */
async function seedNodeDefaults(page: Page, options: OwnerSetupOptions): Promise<void> {
  const overrides: Record<string, unknown> = {}
  if (options.participants !== undefined) overrides.participantCount = options.participants
  if (options.minParticipants !== undefined) overrides.minParticipants = options.minParticipants
  if (options.recommendedParticipants !== undefined) {
    overrides.recommendedParticipants = options.recommendedParticipants
  }
  if (options.transports !== undefined) overrides.helperTransports = options.transports
  if (Object.keys(overrides).length === 0) return

  // `addInitScript` runs before any of the app's own code on every navigation,
  // which matters because the wizard reads these on its first render — setting
  // them afterwards would be a render too late.
  await page.addInitScript(value => {
    window.localStorage.setItem('derec.protocolDefaults', JSON.stringify(value))
  }, overrides)
}

/** Assert that `page` is on the owner dashboard rather than the wizard. */
export async function expectOwnerDashboard(page: Page): Promise<void> {
  await expect(page.getByRole('tab', { name: /^Secrets/ })).toBeVisible({ timeout: 90_000 })
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
 * The side-panel index of the participant called `name`.
 *
 * For a test that has to reach the *same* helpers from two browser contexts:
 * the pool is server-wide and lists differently once other specs have grown
 * it, so an index taken in one context means nothing in another.
 */
export async function participantIndex(page: Page, name: string): Promise<number> {
  const names = (await page.locator('.side-participant-item .side-participant-name').allInnerTexts())
    .map(text => text.trim())
  const index = names.indexOf(name)
  if (index < 0) throw new Error(`no participant named ${name} (have: ${names.join(', ')})`)
  return index
}

/**
 * Link this device's channel with the provisioned helper `name` to the channel
 * that helper already holds for `previousOwner`, as its operator would after
 * authenticating a returning owner — the step that lets it answer Discovery.
 */
export async function linkToPreviousOwner(
  page: Page,
  name: string,
  previousOwner: string,
): Promise<void> {
  const row = await expandParticipant(page, await participantIndex(page, name))
  await row.getByRole('button', { name: 'Link', exact: true }).click()

  const modal = page.locator('.modal').filter({ hasText: `Link on ${name}` })
  await modal.getByRole('option').filter({ hasText: previousOwner }).click()
  await modal.getByRole('button', { name: 'Link', exact: true }).click()
  await expect(modal).toBeHidden({ timeout: 30_000 })
}

/**
 * Commit the recovered bag into this device with "Recover from bag", and wait
 * until the Secrets tab shows `expectedSecret` from it.
 */
export async function restoreRecoveredBag(page: Page, expectedSecret: string): Promise<void> {
  await page.getByRole('button', { name: 'Recover', exact: true }).last().click()
  const dialog = page.locator('.modal-overlay').filter({ hasText: 'Recover from this bag?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Recover from bag' }).click()

  // Re-opened on every poll: restore lands on a tab of its own choosing, which
  // would override a single click placed before it completes.
  await expect
    .poll(
      async () => {
        await openTab(page, 'Secrets')
        return page.locator('.tab-panel').innerText()
      },
      { timeout: 120_000 },
    )
    .toContain(expectedSecret)
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
 * Resolves once the Secrets tab reports the entry, which only happens when
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
  const before = await tabCount(page, 'Secrets')
  const start = page.getByRole('button', { name: 'Add Secret', exact: true })
  await expect(start).toBeEnabled({ timeout: 120_000 })
  await start.click()

  const form = page.locator('.modal-overlay[aria-label="Add secret"] .modal')
  await form.locator('#ps-name').fill(name)
  await form.getByLabel('Secret data').fill(data)
  await form.getByRole('button', { name: 'Add Secret', exact: true }).click()

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
    .poll(() => tabCount(page, 'Secrets'), { timeout: 120_000 })
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
  const start = page.getByRole('button', { name: 'Add Secret', exact: true })
  await expect(start).toBeEnabled({ timeout: 120_000 })
  await start.click()

  const form = page.locator('.modal-overlay[aria-label="Add secret"] .modal')
  await form.locator('#ps-name').fill(name)
  await form.getByLabel('Secret data').fill(data)
  await form.getByRole('button', { name: 'Add Secret', exact: true }).click()

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
// of it — and it is a pairing *mode*, not a kind of actor: the counterparty is
// an ordinary provisioned helper that gains a protocol instance bound to this
// owner's secret when its contact is minted.
//
// Those helpers are backend fixtures, which is what makes a group of three
// testable from one browser context: this device is the `Source` and each
// fixture is a `Destination`. Being unattended, they auto-confirm their own
// fingerprint, so only this device compares.

/**
 * The replicas side-panel section, which is where "+ Add" lives.
 *
 * Matched on its heading rather than on loose text: the section names the
 * Replicas tab in its own body, and so may its sibling one day.
 */
function replicaSection(page: Page): Locator {
  return page
    .locator('.side-panel-section')
    .filter({ has: page.getByRole('heading', { name: 'Replicas', exact: true }) })
}

/**
 * A replica's channel row on the Replicas tab, by the name it was added under.
 *
 * The Replicas tab, not the side panel: a replica is a pairing mode rather than
 * a kind of actor, so what it produces is a channel. The side panel holds the
 * "+ Add" action and no list at all.
 *
 * Matched on the whole name because the backend is reused between runs and a
 * loose match would resolve to rows an earlier run left behind.
 */
export function replicaChannelRow(page: Page, name: string): Locator {
  return page
    .locator('.replicas-tab-section')
    .filter({ hasText: 'Replica channels' })
    .locator('.channel-block')
    .filter({ has: page.locator('.channel-row-name', { hasText: new RegExp(`^${name}$`) }) })
}

/**
 * The fingerprint comparison this device raised for `name`.
 *
 * Distinct from {@link confirmFingerprint}'s dialog, which is the helper-pairing
 * one: this is scoped by name because a replica group raises one of these per
 * member.
 */
function replicaFingerprintDialog(page: Page, name: string): Locator {
  return page.getByRole('dialog').filter({ hasText: name })
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

/**
 * Pair a helper as a replica of this vault, stopping short of confirming.
 *
 * Adding and pairing are one action: there is no replica actor to provision
 * first, so "+ Add" mints a replica-mode contact from a helper and runs the
 * handshake. This returns once that handshake has completed and the comparison
 * dialog it raises is on screen — still unconfirmed, which is the state
 * {@link pairReplica} resolves.
 *
 * Waiting on the dialog rather than on a row is deliberate: the dialog is
 * raised by `PairingCompleted`, so it is a signal that the protocol finished
 * rather than that the request was accepted.
 */
export async function addReplica(page: Page, name: string): Promise<void> {
  await replicaSection(page).getByRole('button', { name: '+ Add' }).click()

  const modal = page.locator('.modal').filter({ hasText: 'Add Replica' })
  await modal.locator('input[type="text"]').fill(name)
  await modal.getByRole('button', { name: 'Add Replica' }).click()

  await expect(replicaFingerprintDialog(page, name)).toBeVisible({ timeout: 60_000 })
}

/**
 * Dismiss the comparison without answering it.
 *
 * Escape, not "Doesn’t match": that button is an answer now, recorded on the
 * row as a refusal. Dismissing writes nothing — the channel stays `Pending`
 * and its deadline keeps running, which is exactly what makes the row's own
 * confirm prompt a safe way back in.
 *
 * Required before touching anything outside the dialog: MUI's modal manager
 * marks the rest of the app `aria-hidden` while it is open, so the tab strip is
 * invisible to the role engine and the backdrop would swallow the click anyway.
 */
export async function dismissReplicaFingerprint(page: Page, name: string): Promise<void> {
  const dialog = replicaFingerprintDialog(page, name)
  await expect(dialog).toBeVisible({ timeout: 60_000 })

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden({ timeout: 30_000 })
}

/**
 * Answer the Remove-from-group confirmation every eviction now goes through.
 * Eviction erases the evicted device's copy, so it is never one click.
 */
export async function confirmReplicaRemoval(page: Page): Promise<void> {
  const dialog = page.locator('.modal-overlay').filter({ hasText: /Remove .* from the group\?|Remove the source/ })
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await dialog.getByRole('button', { name: /^Remove (from group|the source)$/ }).click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })
}

/**
 * Confirm the comparison {@link addReplica} raised.
 *
 * Only this device compares. The helper on the other end auto-confirms — it is
 * an unattended fixture with no screen to read a code off — so the dialog
 * settles into a "confirmed here" state with a Done button instead of closing
 * itself, and dismissing it is part of confirming.
 */
export async function pairReplica(page: Page, name: string): Promise<void> {
  const dialog = replicaFingerprintDialog(page, name)
  await expect(dialog).toBeVisible({ timeout: 60_000 })
  // The code must be on screen before anyone can claim to have compared it.
  await expect(dialog.getByText(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/).first())
    .toBeVisible()

  await dialog.getByRole('button', { name: 'Codes match' }).click()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
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
 * How many replica *channel* rows this owner has.
 *
 * Group members this device has no channel with are listed in the same section
 * — they are replicas too — so the row count alone no longer answers this.
 * "Offers Forget" is what separates them: Forget drops a local record, and a
 * member row has none to drop.
 */
export async function replicaChannelCount(page: Page): Promise<number> {
  return replicaRows(page).filter({ has: page.getByRole('button', { name: 'Forget' }) }).count()
}

/** Every row on the Replicas tab: channels this device holds, and group members. */
export function replicaRows(page: Page) {
  return page
    .locator('.replicas-tab-section')
    .filter({ hasText: 'Replica channels' })
    .locator('.channel-block')
}

/** Rows for peers known only through the group — no channel of this device's own. */
export function replicaMemberRows(page: Page) {
  return replicaRows(page).filter({ hasText: 'This device has no channel of its own' })
}

/** The count badge on a dashboard tab. */
export async function tabCount(
  page: Page,
  name: 'Channels' | 'Replicas' | 'Secrets' | 'Shares' | 'Recovery',
): Promise<number> {
  const text = await page.getByRole('tab', { name: new RegExp(`^${name}`) }).innerText()
  return Number(text.replace(/\D+/g, '') || '0')
}

/** Switch the owner dashboard to one of its tabs. */
export async function openTab(
  page: Page,
  name: 'Channels' | 'Replicas' | 'Secrets' | 'Shares' | 'Recovery',
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
