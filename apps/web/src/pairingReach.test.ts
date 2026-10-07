// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import { isGrpcOnly, pairingErrorText, unreachableReason } from './pairingReach'

const GRPC = { protocol: 'grpc' as const, uri: 'grpc://node:50051' }
const HTTPS = { protocol: 'https' as const, uri: 'http://node/derec/a' }

describe('isGrpcOnly', () => {
  it('is true only when no HTTPS endpoint is advertised', () => {
    expect(isGrpcOnly(GRPC)).toBe(true)
    expect(isGrpcOnly(GRPC, [GRPC, HTTPS])).toBe(false)
    expect(isGrpcOnly(HTTPS)).toBe(false)
  })
})

describe('unreachableReason', () => {
  it('blocks a gRPC-only peer when the relay is off', () => {
    expect(unreachableReason(GRPC, [GRPC], false)).toContain('relay is off')
  })

  it('allows it with the relay on, and any peer with HTTPS', () => {
    expect(unreachableReason(GRPC, [GRPC], true)).toBeNull()
    expect(unreachableReason(GRPC, [GRPC, HTTPS], false)).toBeNull()
  })
})

describe('pairingErrorText', () => {
  it('turns a failed send into a reachability message', () => {
    const text = pairingErrorText({ message: 'invalid input: transport.send promise rejected', code: 'invalid_input' })
    expect(text).toMatch(/^Could not reach the participant/)
    expect(text).toContain('transport.send promise rejected')
  })

  it('passes anything else through', () => {
    expect(pairingErrorText(new Error('role mismatch'))).toBe('role mismatch')
  })
})
