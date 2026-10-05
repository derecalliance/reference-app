// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { VaultEntry, VaultRunState } from './vault/manager'
import { distinctVaultLabels } from './vaultLabels'

export interface VaultSwitcherProps {
  entries: readonly VaultEntry[]
  /** The vault on screen, or `null` when none is (the list, the wizard). */
  currentId: string | null
  onSelect: (id: string) => void
}

/** States worth naming next to a vault's name; a running vault needs no note. */
const STATE_NOTE: Partial<Record<VaultRunState, string>> = {
  starting: 'starting',
  stopped: 'stopped',
  failed: 'failed',
  elsewhere: 'in another tab',
  blocked: 'blocked',
}

/** Placeholder value; vault ids are UUIDs, so it can never collide with one. */
const NONE = ''

/**
 * Jump straight to any vault this browser holds, from wherever you are.
 *
 * A native `<select>` to sit with the header's plain buttons, as the console's
 * filter does. The placeholder is disabled, so it is shown only while no vault
 * is on screen and cannot be picked back.
 */
export function VaultSwitcher({ entries, currentId, onSelect }: VaultSwitcherProps) {
  const labels = distinctVaultLabels(entries)
  return (
    <select
      className="vault-switcher"
      value={currentId ?? NONE}
      onChange={e => onSelect(e.target.value)}
      aria-label="Go to vault"
      title="Go straight to a vault. The one you leave keeps running."
    >
      <option value={NONE} disabled>
        Go to vault…
      </option>
      {entries.map(entry => (
        <option key={entry.id} value={entry.id}>
          {optionLabel(entry, labels.get(entry.id) ?? entry.name)}
        </option>
      ))}
    </select>
  )
}

/** "Crypto Seeds", "Crypto Seeds (stopped)", "Crypto Seeds · 2 waiting". */
function optionLabel(entry: VaultEntry, name: string): string {
  const note = STATE_NOTE[entry.state]
  const waiting = entry.attention > 0 ? ` · ${entry.attention} waiting` : ''
  return `${name}${note ? ` (${note})` : ''}${waiting}`
}
