import { describe, expect, it } from 'vitest'

import type { PairedParticipant } from '../types'
import { buildLinkGroups } from './linkGroups'

/**
 * Grouping paired channels by the Owner identity behind them.
 *
 * This logic used to live inside an effect in `OwnerPage`, where nothing could
 * reach it. The cases that matter are the ones a link record can get wrong:
 * transitivity, a stale link naming a channel that is no longer paired, and
 * which member's name the group takes.
 */

function participant(channelId: string, name: string): PairedParticipant {
  return {
    id: `id-${channelId}`,
    name,
    channelId,
    connectionStatus: 'paired',
    secretShares: [],
  } as unknown as PairedParticipant
}

describe('buildLinkGroups', () => {
  it('leaves unlinked channels in one group each', () => {
    const paired = [participant('1', 'Alex'), participant('2', 'Richard')]

    const groups = buildLinkGroups(paired, new Map(), [])

    expect(groups.map(g => g.name)).toEqual(['Alex', 'Richard'])
    expect(groups.every(g => g.channels.length === 1)).toBe(true)
  })

  it('joins channels transitively', () => {
    // A links to B, B links to C. All three are one peer, even though A never
    // names C — which is the whole reason this is a closure and not a lookup.
    const paired = [participant('a', 'Alex'), participant('b', 'Alex'), participant('c', 'Alex')]
    const closures = new Map([
      ['a', ['a', 'b']],
      ['b', ['b', 'c']],
      ['c', ['c']],
    ])

    const groups = buildLinkGroups(paired, closures, [])

    expect(groups).toHaveLength(1)
    expect(groups[0].channels.map(c => c.channelId)).toEqual(['a', 'b', 'c'])
  })

  it('ignores links to channels that are no longer paired', () => {
    // The store still records a link to 'gone'. Honouring it would resurrect an
    // unpaired channel into the list.
    const paired = [participant('a', 'Alex')]
    const closures = new Map([['a', ['a', 'gone']]])

    const groups = buildLinkGroups(paired, closures, [])

    expect(groups).toHaveLength(1)
    expect(groups[0].channels.map(c => c.channelId)).toEqual(['a'])
  })

  it('takes its name and link source from the main channel', () => {
    const paired = [participant('a', 'Stale name'), participant('b', 'Real name')]
    const closures = new Map([['a', ['a', 'b']], ['b', ['b']]])

    const [group] = buildLinkGroups(paired, closures, ['b'])

    expect(group.mainChannelId).toBe('b')
    expect(group.name).toBe('Real name')
  })

  it('falls back to the lowest channel id when no main is named', () => {
    const paired = [participant('b', 'Second'), participant('a', 'First')]
    const closures = new Map([['a', ['a', 'b']], ['b', ['b']]])

    const [group] = buildLinkGroups(paired, closures, [])

    expect(group.mainChannelId).toBe('a')
    expect(group.name).toBe('First')
  })

  it('keys a group on its sorted members, so it is stable across reorderings', () => {
    const closures = new Map([['a', ['a', 'b']], ['b', ['b']]])

    const one = buildLinkGroups([participant('a', 'Alex'), participant('b', 'Alex')], closures, [])
    const other = buildLinkGroups([participant('b', 'Alex'), participant('a', 'Alex')], closures, [])

    expect(one[0].key).toBe(other[0].key)
  })
})
