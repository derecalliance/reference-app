import { beforeEach, describe, expect, it } from 'vitest'
import { getOrCreateReplicaId, resetReplicaId } from './replicaIdentity'
import { clearNamespace } from './stores'

const OWNER = 'owner-1'

describe('replicaIdentity', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns a stable id across calls', () => {
    const first = getOrCreateReplicaId(OWNER)
    const second = getOrCreateReplicaId(OWNER)

    expect(second).toBe(first)
  })

  it('mints a u64-range bigint', () => {
    const id = getOrCreateReplicaId(OWNER)

    expect(id).toBeGreaterThanOrEqual(0n)
    expect(id).toBeLessThan(2n ** 64n)
  })

  it('gives each owner its own identity', () => {
    // Two tabs are two logical devices. Sharing one replica id would present
    // them to a peer as the same device, which is the whole reason this is
    // keyed per owner rather than per origin.
    expect(getOrCreateReplicaId('owner-a')).not.toBe(getOrCreateReplicaId('owner-b'))
  })

  it('survives a namespace wipe, because identity outlives the vault', () => {
    // Adoption clears `derec:owner:{id}:` to take on another device's vault.
    // The identity key sits outside that partition deliberately.
    const before = getOrCreateReplicaId(OWNER)
    localStorage.setItem(`derec:owner:${OWNER}:123:contact-index`, '[]')

    clearNamespace(`owner:${OWNER}`)

    expect(getOrCreateReplicaId(OWNER)).toBe(before)
  })

  it('mints a new id after an explicit reset', () => {
    const before = getOrCreateReplicaId(OWNER)
    resetReplicaId(OWNER)

    expect(getOrCreateReplicaId(OWNER)).not.toBe(before)
  })

  it('resetting one owner leaves another owner’s identity alone', () => {
    const other = getOrCreateReplicaId('owner-b')
    getOrCreateReplicaId('owner-a')

    resetReplicaId('owner-a')

    expect(getOrCreateReplicaId('owner-b')).toBe(other)
  })
})
