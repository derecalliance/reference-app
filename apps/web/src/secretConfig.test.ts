import { beforeEach, describe, expect, it } from 'vitest'

import { overridesFor, resolveSecretConfig, SECRET_CONFIG_DEFAULTS } from './protocolDefaults'

const BROWSER_OVERRIDE_KEY = 'derec.protocolDefaults'

describe('resolveSecretConfig', () => {
  beforeEach(() => localStorage.clear())

  it('is the app defaults when the secret overrides nothing', () => {
    expect(resolveSecretConfig({})).toEqual(SECRET_CONFIG_DEFAULTS)
  })

  it('uses the app defaults: 30 s, no unpair acknowledgement, every incoming request answered', () => {
    expect(resolveSecretConfig({})).toEqual({
      protocolTimeoutSecs: 30,
      authenticationMethod: 'user',
      unpairAck: 'not_required',
      autoAcceptUnpairRequests: true,
      autoAcceptStoreShareRequests: true,
      autoAcceptVerifyShareRequests: true,
    })
  })

  it('lets a secret override one setting without pinning the others', () => {
    const resolved = resolveSecretConfig({ protocolTimeoutSecs: 60 })

    expect(resolved.protocolTimeoutSecs).toBe(60)
    expect(resolved.unpairAck).toBe(SECRET_CONFIG_DEFAULTS.unpairAck)
  })

  it('ignores protocol settings an older build kept as browser-wide defaults', () => {
    localStorage.setItem(BROWSER_OVERRIDE_KEY, JSON.stringify({ protocolTimeoutSecs: 120, unpairAck: 'not_required' }))

    expect(resolveSecretConfig({})).toEqual(SECRET_CONFIG_DEFAULTS)
  })

  it('resolves every behavioural setting a secret overrides', () => {
    const overrides = {
      protocolTimeoutSecs: 45,
      authenticationMethod: 'application',
      unpairAck: 'not_required',
      autoAcceptUnpairRequests: false,
      autoAcceptStoreShareRequests: true,
      autoAcceptVerifyShareRequests: true,
    } as const

    expect(resolveSecretConfig(overrides)).toEqual(overrides)
  })

  it('honours an override that is falsy rather than treating it as absent', () => {
    expect(SECRET_CONFIG_DEFAULTS.autoAcceptUnpairRequests).toBe(true)

    expect(resolveSecretConfig({ autoAcceptUnpairRequests: false }).autoAcceptUnpairRequests).toBe(false)
  })
})

describe('overridesFor', () => {
  it('stores only what differs from the app defaults', () => {
    expect(overridesFor(SECRET_CONFIG_DEFAULTS)).toEqual({})
    expect(overridesFor({ ...SECRET_CONFIG_DEFAULTS, protocolTimeoutSecs: 60, autoAcceptUnpairRequests: false })).toEqual({
      protocolTimeoutSecs: 60,
      autoAcceptUnpairRequests: false,
    })
  })

  it('round-trips through resolveSecretConfig', () => {
    const config = { ...SECRET_CONFIG_DEFAULTS, unpairAck: 'required' as const }

    expect(resolveSecretConfig(overridesFor(config))).toEqual(config)
  })
})
