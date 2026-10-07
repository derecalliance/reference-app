// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { beforeEach, describe, expect, it } from 'vitest'

import { FALLBACK_SERVER_DEFAULTS } from './config'
import { resolveVaultConfig } from './protocolDefaults'

const BROWSER_OVERRIDE_KEY = 'derec.protocolDefaults'

describe('resolveVaultConfig', () => {
  beforeEach(() => localStorage.clear())

  it('falls through to the server tier when nothing overrides', () => {
    const resolved = resolveVaultConfig({}, FALLBACK_SERVER_DEFAULTS)

    expect(resolved.protocolTimeoutSecs).toBe(FALLBACK_SERVER_DEFAULTS.protocolTimeoutSecs)
    expect(resolved.unpairAck).toBe(FALLBACK_SERVER_DEFAULTS.unpairAck)
    expect(resolved.authenticationMethod).toBe(FALLBACK_SERVER_DEFAULTS.authenticationMethod)
    expect(resolved.autoAcceptUnpairRequests).toBe(
      FALLBACK_SERVER_DEFAULTS.autoAcceptUnpairRequests,
    )
  })

  it('asks before storing or verifying a share unless configured otherwise', () => {
    const resolved = resolveVaultConfig({}, FALLBACK_SERVER_DEFAULTS)

    expect(resolved.autoAcceptStoreShareRequests).toBe(false)
    expect(resolved.autoAcceptVerifyShareRequests).toBe(false)
  })

  it('lets a vault override one setting without pinning the others', () => {
    const resolved = resolveVaultConfig({ protocolTimeoutSecs: 60 }, FALLBACK_SERVER_DEFAULTS)

    expect(resolved.protocolTimeoutSecs).toBe(60)
    // The control: an override names one value, it does not freeze a snapshot.
    expect(resolved.unpairAck).toBe(FALLBACK_SERVER_DEFAULTS.unpairAck)
  })

  it('puts the vault tier above the browser tier', () => {
    localStorage.setItem(
      BROWSER_OVERRIDE_KEY,
      JSON.stringify({ protocolTimeoutSecs: 120 }),
    )

    expect(resolveVaultConfig({}, FALLBACK_SERVER_DEFAULTS).protocolTimeoutSecs).toBe(120)
    expect(
      resolveVaultConfig({ protocolTimeoutSecs: 30 }, FALLBACK_SERVER_DEFAULTS)
        .protocolTimeoutSecs,
    ).toBe(30)
  })

  it('reflects a later browser-default change on a vault that did not override', () => {
    // Why overrides are partials rather than resolved snapshots: a node
    // reconfigured after a vault was created must still reach that vault.
    // Storing a snapshot would strand it on the values it happened to see once,
    // with nothing on screen explaining why.
    const overrides = {}
    expect(resolveVaultConfig(overrides, FALLBACK_SERVER_DEFAULTS).protocolTimeoutSecs).toBe(
      FALLBACK_SERVER_DEFAULTS.protocolTimeoutSecs,
    )

    localStorage.setItem(BROWSER_OVERRIDE_KEY, JSON.stringify({ protocolTimeoutSecs: 900 }))

    expect(resolveVaultConfig(overrides, FALLBACK_SERVER_DEFAULTS).protocolTimeoutSecs).toBe(900)
  })

  it('resolves every behavioural setting a vault overrides', () => {
    const resolved = resolveVaultConfig(
      {
        protocolTimeoutSecs: 45,
        authenticationMethod: 'application',
        unpairAck: 'not_required',
        autoAcceptUnpairRequests: false,
        autoAcceptStoreShareRequests: true,
        autoAcceptVerifyShareRequests: true,
      },
      FALLBACK_SERVER_DEFAULTS,
    )

    expect(resolved).toEqual({
      protocolTimeoutSecs: 45,
      authenticationMethod: 'application',
      unpairAck: 'not_required',
      autoAcceptUnpairRequests: false,
      autoAcceptStoreShareRequests: true,
      autoAcceptVerifyShareRequests: true,
    })
  })

  it('honours an override that is falsy rather than treating it as absent', () => {
    // `autoAcceptUnpairRequests: false` is a real choice. Resolving it with `||`
    // would silently restore the server default of `true`, so the vault would
    // auto-accept unpair requests the user explicitly asked to be prompted for.
    localStorage.clear()

    const resolved = resolveVaultConfig(
      { autoAcceptUnpairRequests: false },
      { ...FALLBACK_SERVER_DEFAULTS, autoAcceptUnpairRequests: true },
    )

    expect(resolved.autoAcceptUnpairRequests).toBe(false)
  })
})
