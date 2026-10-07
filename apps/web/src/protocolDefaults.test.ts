// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { afterEach, describe, expect, it } from 'vitest'

import { FALLBACK_SERVER_DEFAULTS } from './config'
import {
  clearDefaultOverrides,
  effectiveDefaults,
  loadDefaultOverrides,
  persistDefaultOverrides,
} from './protocolDefaults'

/**
 * Protocol defaults are the node's until someone overrides them here.
 *
 * The backend resolves its own set at boot and serves them from `GET /config`;
 * these overrides are a browser-local layer on top, which is what makes them
 * editable at all — the backend holds no policy about them and has no endpoint
 * to change them.
 *
 * The merge is the whole point: an override must not freeze the values it does
 * *not* name, or a node reconfigured and restarted would keep serving a
 * developer the values it had months ago.
 */
describe('protocolDefaults', () => {
  afterEach(() => localStorage.clear())

  it('is the server\'s values when nothing is overridden', () => {
    const server = {
      ...FALLBACK_SERVER_DEFAULTS,
      participantCount: 9,
      // Consistent with the count, as a node's own configuration must be — it
      // refuses to boot on a breakdown that does not sum.
      helperTransports: { http: 9, grpc: 0, both: 0 },
    }

    expect(effectiveDefaults(server)).toEqual(server)
  })

  it('applies only the keys that were overridden', () => {
    // The server later changes its timeout; the override named only the count,
    // so the new timeout must come through.
    persistDefaultOverrides({ participantCount: 2 })

    const server = { ...FALLBACK_SERVER_DEFAULTS, protocolTimeoutSecs: 42 }
    const effective = effectiveDefaults(server)

    expect(effective.participantCount).toBe(2)
    expect(effective.protocolTimeoutSecs).toBe(42)
  })

  it('round-trips an override', () => {
    persistDefaultOverrides({ protocolTimeoutSecs: 60, unpairAck: 'not_required' })

    expect(loadDefaultOverrides()).toEqual({
      protocolTimeoutSecs: 60,
      unpairAck: 'not_required',
    })
  })

  it('clears back to the server\'s values', () => {
    persistDefaultOverrides({ participantCount: 2 })
    clearDefaultOverrides()

    expect(loadDefaultOverrides()).toEqual({})
    expect(effectiveDefaults(FALLBACK_SERVER_DEFAULTS)).toEqual(FALLBACK_SERVER_DEFAULTS)
  })

  it('ignores a stored value that is not an object', () => {
    // A key left by an older build, or edited by hand. Falling back beats
    // throwing on every read of a convenience layer.
    localStorage.setItem('derec.protocolDefaults', '"nonsense"')

    expect(loadDefaultOverrides()).toEqual({})
  })

  it('ignores unparseable stored JSON', () => {
    localStorage.setItem('derec.protocolDefaults', '{not json')

    expect(loadDefaultOverrides()).toEqual({})
  })

  it('refits the transport mix when only the count is overridden', () => {
    // The bug this guards: Settings can override the pool size on its own,
    // leaving the breakdown on the node's numbers. The backend rejects a
    // breakdown that does not sum to the count, so provisioning failed outright
    // with "transports must sum to total".
    persistDefaultOverrides({ participantCount: 3 })

    const server = {
      ...FALLBACK_SERVER_DEFAULTS,
      participantCount: 7,
      helperTransports: { http: 7, grpc: 0, both: 0 },
    }
    const { helperTransports } = effectiveDefaults(server)

    expect(helperTransports.http + helperTransports.grpc + helperTransports.both).toBe(3)
  })

  it('keeps deliberately chosen transports when refitting', () => {
    persistDefaultOverrides({ participantCount: 5 })

    const server = {
      ...FALLBACK_SERVER_DEFAULTS,
      participantCount: 7,
      helperTransports: { http: 5, grpc: 1, both: 1 },
    }
    const { helperTransports } = effectiveDefaults(server)

    // http absorbs the difference; the named modes are the choice.
    expect(helperTransports).toEqual({ http: 3, grpc: 1, both: 1 })
  })

  it('folds every helper into HTTP when the node runs no gRPC listener', () => {
    // QA: a mix saved while gRPC was on kept being sent after the node was
    // restarted without it, and every "Provision up to N" failed with
    // "gRPC helpers requested but grpc_enabled is false".
    persistDefaultOverrides({ participantCount: 14, helperTransports: { http: 4, grpc: 5, both: 5 } })

    const server = {
      ...FALLBACK_SERVER_DEFAULTS,
      grpcEnabled: false,
      helperTransports: { http: 3, grpc: 2, both: 2 },
    }

    expect(effectiveDefaults(server).helperTransports).toEqual({ http: 14, grpc: 0, both: 0 })
  })

  it('takes what the node runs from the node, never from an override', () => {
    persistDefaultOverrides({ grpcEnabled: true, grpcRelayEnabled: true })

    const server = { ...FALLBACK_SERVER_DEFAULTS, grpcEnabled: false, grpcRelayEnabled: false }
    const effective = effectiveDefaults(server)

    expect(effective.grpcEnabled).toBe(false)
    expect(effective.grpcRelayEnabled).toBe(false)
  })

  it('survives localStorage throwing', () => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError')
    }

    expect(() => persistDefaultOverrides({ participantCount: 3 })).not.toThrow()

    Storage.prototype.setItem = original
  })
})
