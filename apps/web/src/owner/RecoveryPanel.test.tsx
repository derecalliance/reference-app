// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PairedParticipant, RecoveredSecret, RecoveredSecretReplica, ItemBag, Secret } from '../types'
import { secret } from '../secret/testSecret'
import { RecoveryPanel } from './RecoveryPanel'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function holder(n: number, versions: number[], extra: Partial<PairedParticipant> = {}): PairedParticipant {
  return {
    id: `h${n}`,
    name: `Helper ${n}`,
    channelId: `90${n}`,
    transport: { protocol: 'https', uri: `http://localhost:5000/derec/h${n}` },
    secretShares: [],
    connectionStatus: 'paired',
    discoveryComplete: true,
    discoveredVersions: versions.map(version => ({ secretId: '42', version, description: 'DeRec Secret' })),
    ...extra,
  }
}

function bag(current: number, previous: number[], threshold: number): ItemBag {
  const version = (v: number) => ({
    version: v,
    participantIds: [],
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    items: [],
    rawBytes: '',
    helpers: [],
  })
  return { secretId: '42', threshold, currentVersion: version(current), previousVersions: previous.map(version) }
}

function render(
  record: Secret,
  handlers: { discover?: () => Promise<void>; join?: () => void; joinThrough?: (s: RecoveredSecret, m: RecoveredSecretReplica) => Promise<void> } = {},
) {
  act(() =>
    root.render(
      <RecoveryPanel
        secret={record}
        onRequestDiscovery={handlers.discover ?? (async () => {})}
        onRecover={async () => {}}
        onRestoreFromBag={async () => {}}
        onJoinGroup={handlers.join ?? (() => {})}
        onJoinThrough={handlers.joinThrough ?? (async () => {})}
      />,
    ),
  )
}

function versionRow(version: number): HTMLElement {
  const row = Array.from(host.querySelectorAll<HTMLElement>('.available-version-row')).find(
    r => r.querySelector('.version-tag')?.textContent === `v${version}`,
  )
  if (!row) throw new Error(`no row for v${version}`)
  return row
}

describe('RecoveryPanel', () => {
  it('claims no readiness on a device that does not know the threshold', () => {
    render(secret({ itemBag: null, participants: [holder(1, [3])] }))

    const row = versionRow(3)
    expect(row.textContent).toContain('1 helper holds it')
    expect(row.textContent).not.toContain('Ready')
  })

  it('compares the holders against the threshold this secret published with', () => {
    render(secret({ itemBag: bag(3, [2], 2), participants: [holder(1, [2, 3]), holder(2, [2])] }))

    expect(versionRow(2).textContent).toContain('Ready')
    expect(versionRow(3).textContent).toContain('Needs 2')
  })

  it('leaves out a version this secret rolled back', () => {
    render(secret({ itemBag: bag(4, [2], 1), participants: [holder(1, [2, 3, 4])] }))

    const rows = Array.from(host.querySelectorAll('.available-version-row .version-tag')).map(t => t.textContent)
    expect(rows).toEqual(['v4', 'v2'])
    expect(host.textContent).toContain('1 rolled-back version not shown')
  })

  it('shows why a discovery could not start instead of leaving it unhandled', async () => {
    render(secret({ participants: [holder(1, [], { discoveryComplete: false })] }), {
      discover: async () => {
        throw new Error('No discovery request was sent: the DeRec server cannot be reached.')
      },
    })

    const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Discover All')!
    await act(async () => button.click())

    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/server cannot be reached/)
  })

  it('marks a helper that did not answer instead of leaving it pending', () => {
    render(secret({ participants: [holder(1, [], { discoveryComplete: false, discoveryError: 'No answer within 30s' })] }))

    const tag = host.querySelector('.recovery-helper-row .status-tag')
    expect(tag?.textContent).toBe('No answer')
    expect(tag?.getAttribute('title')).toBe('No answer within 30s')
  })
})

describe('restore or join (SDK 0.0.9)', () => {
  function recovered(members: Array<{ replicaId: string; role: 'Source' | 'Destination'; name: string }>): RecoveredSecret {
    return {
      secretId: '77',
      version: 3,
      label: 'DeRec Secret',
      restored: false,
      snapshot: {
        helpers: [],
        items: [],
        replicas: members.length
          ? {
              channelId: '5',
              sharedKey: '',
              members: members.map(m => ({ replicaId: m.replicaId, role: m.role, transports: [], communicationInfo: { name: m.name } })),
            }
          : undefined,
      },
    } as RecoveredSecret
  }

  const button = (name: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === name)

  it('offers to join the group when the recovered secret names a live replica', () => {
    const join = vi.fn()
    render(secret({ recoveredSecrets: [recovered([
      { replicaId: '1', role: 'Source', name: 'Old laptop' },
      { replicaId: '2', role: 'Destination', name: 'Phone' },
    ])] }), { join })

    act(() => button('Join group…')?.click())

    expect(host.textContent).toContain('Phone')
    expect(host.textContent).toContain('do not restore')
    act(() => button('Pair as replica destination')?.click())
    expect(join).toHaveBeenCalled()
  })

  it('joins straight through a member this node runs, and says why when it cannot', async () => {
    const joinThrough = vi.fn(async () => {
      throw new Error('Phone is not a provisioned helper on this node')
    })
    render(secret({ recoveredSecrets: [recovered([
      { replicaId: '1', role: 'Source', name: 'Old laptop' },
      { replicaId: '2', role: 'Destination', name: 'Phone' },
    ])] }), { joinThrough })

    act(() => button('Join group…')?.click())
    await act(async () => button('Join through Phone')?.click())

    expect(joinThrough).toHaveBeenCalledWith(expect.objectContaining({ secretId: '77' }), expect.objectContaining({ replicaId: '2' }))
    expect(host.textContent).toContain('not a provisioned helper on this node')
  })

  it('keeps Join through usable but ties it to the known SDK limitation (review I5)', () => {
    render(secret({ recoveredSecrets: [recovered([
      { replicaId: '1', role: 'Source', name: 'Old laptop' },
      { replicaId: '2', role: 'Destination', name: 'Phone' },
    ])] }))

    act(() => button('Join group…')?.click())
    const through = button('Join through Phone')
    const note = host.querySelector(`#${through?.getAttribute('aria-describedby')}`)

    expect(through?.disabled).toBe(false)
    expect(note?.textContent).toContain('SDK 0.0.9 limitation')
  })

  it('offers only restore when the group has no other member', () => {
    render(secret({ recoveredSecrets: [recovered([{ replicaId: '1', role: 'Source', name: 'Old laptop' }])] }))

    expect(button('Join group…')).toBeUndefined()
  })
})

