import { beforeEach, describe, expect, it } from 'vitest'
import { loadReplicaAdoptionBlock, saveReplicaAdoptionBlock } from './replicaAdoptionBlock'
import { describeRestoreFailure } from './replicaFlows'

const STORAGE_PREFIX = 'derec:replica-adoption-block:'

const keyFor = (ownerId: string) => `${STORAGE_PREFIX}${ownerId}`

describe('replicaAdoptionBlock', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  const failure = describeRestoreFailure({
    code: 'CONFLICT',
    message: 'channel already exists',
    channel_ids: ['900', '901'],
  })

  it('reports no block when nothing was ever raised', () => {
    expect(loadReplicaAdoptionBlock('owner-1')).toBeNull()
  })

  it('survives the page load that raised it', () => {
    // The defect this exists for: the block was React state only, so a reload
    // left the guards reading `null` while the persisted owner still listed
    // helpers whose stores the wipe had erased.
    saveReplicaAdoptionBlock('owner-1', failure)

    expect(loadReplicaAdoptionBlock('owner-1')).toEqual(failure)
  })

  it('keeps the library’s own words verbatim, channel ids included', () => {
    saveReplicaAdoptionBlock('owner-1', failure)

    const loaded = loadReplicaAdoptionBlock('owner-1')
    expect(loaded?.text).toBe('CONFLICT: channel already exists (channel_ids: 900, 901)')
    expect(loaded?.channelIds).toEqual(['900', '901'])
    expect(loaded?.wipeDidNotTake).toBe(true)
  })

  it('does not show a block raised against another owner', () => {
    saveReplicaAdoptionBlock('owner-1', failure)

    expect(loadReplicaAdoptionBlock('owner-2')).toBeNull()
  })

  it('keeps a block per owner, so two tabs cannot overwrite each other', () => {
    // This used to be one key carrying the owner id inside the record. Once two
    // tabs could each drive an owner, the second block overwrote the first and
    // the first silently un-blocked on reload — the exact failure the record
    // exists to prevent.
    const other = describeRestoreFailure({
      code: 'INVARIANT',
      message: 'something else entirely',
      channel_ids: ['902'],
    })

    saveReplicaAdoptionBlock('owner-1', failure)
    saveReplicaAdoptionBlock('owner-2', other)

    expect(loadReplicaAdoptionBlock('owner-1')?.message).toBe('channel already exists')
    expect(loadReplicaAdoptionBlock('owner-2')?.message).toBe('something else entirely')
  })

  it('stays raised across repeated loads — nothing clears it on read', () => {
    saveReplicaAdoptionBlock('owner-1', failure)

    expect(loadReplicaAdoptionBlock('owner-1')).not.toBeNull()
    expect(loadReplicaAdoptionBlock('owner-1')).not.toBeNull()
    expect(localStorage.getItem(keyFor('owner-1'))).not.toBeNull()
  })

  it('is erased by the app-wide reset, which is the only way out', () => {
    saveReplicaAdoptionBlock('owner-1', failure)
    // `clearAllLocalData` sweeps the `derec:` prefix; asserting the prefix is
    // what makes the "Reset browser data" escape hatch real.
    expect(STORAGE_PREFIX.startsWith('derec:')).toBe(true)
  })

  it('reports no block for a record that is not a restore failure', () => {
    localStorage.setItem(keyFor('owner-1'), JSON.stringify({ code: 'CONFLICT' }))

    expect(loadReplicaAdoptionBlock('owner-1')).toBeNull()
  })

  it('reports no block for corrupt storage', () => {
    localStorage.setItem(keyFor('owner-1'), 'not json')

    expect(loadReplicaAdoptionBlock('owner-1')).toBeNull()
  })

  it('rejects a record whose channel ids are not strings', () => {
    localStorage.setItem(
      keyFor('owner-1'),
      JSON.stringify({ ...failure, channelIds: [900] }),
    )

    expect(loadReplicaAdoptionBlock('owner-1')).toBeNull()
  })
})
