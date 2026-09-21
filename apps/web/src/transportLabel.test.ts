import { describe, expect, it } from 'vitest'
import { transportLabel, transportLabelIsComplete } from './transportLabel'
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

describe('transportLabelIsComplete', () => {
  it('is false when only the fallback address was available', () => {
    // A badge built from one address cannot rule out more, so the UI must not
    // present it as the whole truth.
    expect(transportLabelIsComplete(undefined)).toBe(false)
    expect(transportLabelIsComplete([])).toBe(false)
  })

  it('is true once the advertised list is known', () => {
    expect(transportLabelIsComplete([grpc])).toBe(true)
  })
})
