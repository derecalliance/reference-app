// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'
import { transportLabel } from './transportLabel'
import type { Transport } from './types'

const https: Transport = { protocol: 'https', uri: 'http://localhost:5000/derec/a' }
const grpc: Transport = { protocol: 'grpc', uri: 'grpc://localhost:50051' }

describe('transportLabel', () => {
  it('names a single-endpoint peer by its protocol', () => {
    expect(transportLabel(https, [https])).toBe('HTTPS')
    expect(transportLabel(grpc, [grpc])).toBe('GRPC')
  })

  it('names a peer advertising both, whichever order it offered them', () => {
    // The order is the peer's preference and carries no protocol meaning, so
    // the badge must read the same either way.
    expect(transportLabel(grpc, [grpc, https])).toBe('GRPC+HTTPS')
    expect(transportLabel(https, [https, grpc])).toBe('GRPC+HTTPS')
  })

  it('falls back to the singular address when no list is known', () => {
    expect(transportLabel(grpc)).toBe('GRPC')
    expect(transportLabel(https, [])).toBe('HTTPS')
  })

  it('does not let the singular field contradict the list', () => {
    // `transport` is documented as the first of `transports`. If a construction
    // site ever gets that wrong, the list is the one to trust — it is what the
    // peer actually advertised.
    expect(transportLabel(https, [grpc, https])).toBe('GRPC+HTTPS')
  })
})
