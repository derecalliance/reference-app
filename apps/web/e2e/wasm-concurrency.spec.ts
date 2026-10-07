// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { expect, test } from '@playwright/test'

import { openApp } from './app'

/**
 * Two `DeRecProtocol` instances in one page, driven with overlapping calls.
 *
 * `VaultRuntime` serialises calls with a lock *per runtime*, on the reasoning
 * that wasm-bindgen's "recursive use of an object" guard is a per-object borrow
 * and two instances are two objects. They do share one WASM linear memory, and
 * the library is not otherwise verified free of module-level state — so this is
 * the check that running several vaults at once needs no global lock.
 *
 * An e2e test because it needs real WASM: a stubbed instance would prove
 * nothing. Built through the app's own `buildProtocolInstance`, over the app's
 * own stores, so it exercises exactly what a runtime builds.
 */
test('two protocol instances run overlapping calls without borrow errors', async ({ page }) => {
  // Boots the app, which initialises the SDK once for the page.
  await openApp(page)

  const result = await page.evaluate(async () => {
    // The slice of the app's modules this probe drives. Loaded by path at run
    // time — these are Vite dev-server URLs, which the e2e type-check cannot
    // resolve — so the shape is declared here instead.
    interface Probe {
      createContact(nonce: null, mode: unknown): Promise<{ channel_id: bigint }>
      tick(): Promise<unknown>
    }
    interface ProtocolModule {
      buildProtocolInstance(opts: Record<string, unknown>): { protocol: Probe }
    }
    interface ContactModesModule {
      DEFAULT_CONTACT_MODE: string
      toContactMode(mode: string): unknown
    }
    // Relative to the page, because the app is served under a base path.
    const load = <T,>(path: string): Promise<T> =>
      import(/* @vite-ignore */ new URL(path, document.baseURI).href)
    const { buildProtocolInstance } = await load<ProtocolModule>('src/owner/protocol.ts')
    const { DEFAULT_CONTACT_MODE, toContactMode } = await load<ContactModesModule>('src/contactModes.ts')

    const build = (name: string, secretId: string, replicaId: bigint) =>
      buildProtocolInstance({
        namespace: `wasm-concurrency:${name}`,
        secretId,
        ownTransportUri: `http://localhost:5100/derec/${name}`,
        communicationInfo: { name },
        threshold: 2,
        keepList: () => null,
        timeoutSecs: 300,
        unpairAck: 'not_required',
        replicaId,
      }).protocol

    const a = build('probe-a', '1001', 11n)
    const b = build('probe-b', '1002', 22n)
    const mode = toContactMode(DEFAULT_CONTACT_MODE)

    const channelsA: string[] = []
    const channelsB: string[] = []
    try {
      // Overlap deliberately, and only *across* instances: each round starts a
      // call on `a` and one on `b` before awaiting either, alternating which
      // side mints a contact and which ticks. Never two calls on one instance —
      // that is what `VaultRuntime`'s own lock prevents, and it hangs rather than
      // throws (observed 2026-09-30), so it would only time this test out.
      // Several rounds, because one overlap can pass by luck.
      for (let round = 0; round < 20; round++) {
        const [ca, cb] = await Promise.all([a.createContact(null, mode), b.createContact(null, mode)])
        channelsA.push(String(ca.channel_id))
        channelsB.push(String(cb.channel_id))
        await Promise.all([a.createContact(null, mode), b.tick()])
        await Promise.all([a.tick(), b.createContact(null, mode)])
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), channelsA, channelsB }
    }
    return { error: null, channelsA, channelsB }
  })

  expect(result.error).toBeNull()
  expect(result.channelsA).toHaveLength(20)
  expect(result.channelsB).toHaveLength(20)
  // Distinct instances must mint distinct channels — an id minted by both would
  // mean shared state, which is the failure this test exists to catch.
  const shared = result.channelsA.filter(id => result.channelsB.includes(id))
  expect(shared).toEqual([])
})

/**
 * Two overlapping calls on the *same* instance.
 *
 * Up to SDK 0.0.5 the second call's `&mut self` borrow failed on a microtask
 * and its promise never settled; the app's borrow guard reported it. From 0.0.6
 * every method runs under one lock per instance, so overlapping calls queue.
 * This pins the new behaviour: if it regresses, both the per-vault lock's notes
 * and the guard become load-bearing again.
 */
test('overlapping calls on one instance queue rather than hang', async ({ page }) => {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await openApp(page)

  const outcome = await page.evaluate(async () => {
    interface Probe {
      createContact(nonce: null, mode: unknown): Promise<unknown>
      tick(): Promise<unknown>
    }
    const load = <T,>(path: string): Promise<T> =>
      import(/* @vite-ignore */ new URL(path, document.baseURI).href)
    const { buildProtocolInstance } = await load<{
      buildProtocolInstance(opts: Record<string, unknown>): { protocol: Probe }
    }>('src/owner/protocol.ts')
    const { DEFAULT_CONTACT_MODE, toContactMode } = await load<{
      DEFAULT_CONTACT_MODE: string
      toContactMode(mode: string): unknown
    }>('src/contactModes.ts')

    const a = buildProtocolInstance({
      namespace: 'wasm-concurrency:same-instance',
      secretId: '1003',
      ownTransportUri: 'http://localhost:5100/derec/same-instance',
      communicationInfo: { name: 'same-instance' },
      threshold: 2,
      keepList: () => null,
      timeoutSecs: 300,
      unpairAck: 'not_required',
      replicaId: 33n,
    }).protocol

    const settled = (p: Promise<unknown>) => {
      const state = { status: 'pending' }
      p.then(
        () => { state.status = 'resolved' },
        () => { state.status = 'rejected' },
      )
      return state
    }
    const first = settled(a.createContact(null, toContactMode(DEFAULT_CONTACT_MODE)))
    const second = settled(a.tick())
    await new Promise(resolve => setTimeout(resolve, 3000))
    return { first: first.status, second: second.status }
  })

  expect(outcome).toEqual({ first: 'resolved', second: 'resolved' })
  expect(errors.some(text => text.includes('Two protocol calls overlapped'))).toBe(false)
})
