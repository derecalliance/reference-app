// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PairedParticipant, SecretBag, Vault } from '../types'
import { vault } from '../vault/testVault'
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
    discoveredVersions: versions.map(version => ({ secretId: '42', version, description: 'DeRec Vault' })),
    ...extra,
  }
}

function bag(current: number, previous: number[], threshold: number): SecretBag {
  const version = (v: number) => ({
    version: v,
    participantIds: [],
    verifiedParticipantIds: [],
    failedParticipantIds: [],
    secrets: [],
    rawBytes: '',
    helpers: [],
  })
  return { secretId: '42', threshold, currentVersion: version(current), previousVersions: previous.map(version) }
}

function render(record: Vault, handlers: { discover?: () => Promise<void> } = {}) {
  act(() =>
    root.render(
      <RecoveryPanel
        vault={record}
        onRequestDiscovery={handlers.discover ?? (async () => {})}
        onRecover={async () => {}}
        onRestoreFromBag={async () => {}}
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
    render(vault({ secretBag: null, participants: [holder(1, [3])] }))

    const row = versionRow(3)
    expect(row.textContent).toContain('1 helper holds it')
    expect(row.textContent).not.toContain('Ready')
  })

  it('compares the holders against the threshold this vault published with', () => {
    render(vault({ secretBag: bag(3, [2], 2), participants: [holder(1, [2, 3]), holder(2, [2])] }))

    expect(versionRow(2).textContent).toContain('Ready')
    expect(versionRow(3).textContent).toContain('Needs 2')
  })

  it('leaves out a version this vault rolled back', () => {
    render(vault({ secretBag: bag(4, [2], 1), participants: [holder(1, [2, 3, 4])] }))

    const rows = Array.from(host.querySelectorAll('.available-version-row .version-tag')).map(t => t.textContent)
    expect(rows).toEqual(['v4', 'v2'])
    expect(host.textContent).toContain('1 rolled-back version not shown')
  })

  it('shows why a discovery could not start instead of leaving it unhandled', async () => {
    render(vault({ participants: [holder(1, [], { discoveryComplete: false })] }), {
      discover: async () => {
        throw new Error('No discovery request was sent: the DeRec server cannot be reached.')
      },
    })

    const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Discover All')!
    await act(async () => button.click())

    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/server cannot be reached/)
  })

  it('marks a helper that did not answer instead of leaving it pending', () => {
    render(vault({ participants: [holder(1, [], { discoveryComplete: false, discoveryError: 'No answer within 30s' })] }))

    const tag = host.querySelector('.recovery-helper-row .status-tag')
    expect(tag?.textContent).toBe('No answer')
    expect(tag?.getAttribute('title')).toBe('No answer within 30s')
  })
})
