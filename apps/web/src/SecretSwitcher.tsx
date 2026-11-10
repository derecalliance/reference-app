// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { SecretEntry, SecretRunState } from './secret/manager'
import { distinctSecretLabels } from './secretLabels'

export interface SecretSwitcherProps {
  entries: readonly SecretEntry[]
  /** The secret on screen, or `null` when none is (the list, the wizard). */
  currentId: string | null
  onSelect: (id: string) => void
}

/** States worth naming next to a secret's name; a running secret needs no note. */
const STATE_NOTE: Partial<Record<SecretRunState, string>> = {
  starting: 'starting',
  stopped: 'stopped',
  failed: 'failed',
  elsewhere: 'in another tab',
  blocked: 'blocked',
}

/** Placeholder value; local secret ids are UUIDs, so it can never collide with one. */
const NONE = ''

/**
 * Jump straight to any secret this browser holds, from wherever you are.
 *
 * A native `<select>` to sit with the header's plain buttons, as the console's
 * filter does. The placeholder is disabled, so it is shown only while no secret
 * is on screen and cannot be picked back.
 */
export function SecretSwitcher({ entries, currentId, onSelect }: SecretSwitcherProps) {
  const labels = distinctSecretLabels(entries)
  return (
    <select
      className="secret-switcher"
      value={currentId ?? NONE}
      onChange={e => onSelect(e.target.value)}
      aria-label="Go to secret"
      title="Go straight to a secret. The one you leave keeps running."
    >
      <option value={NONE} disabled>
        Go to secret…
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
function optionLabel(entry: SecretEntry, name: string): string {
  const note = STATE_NOTE[entry.state]
  const waiting = entry.attention > 0 ? ` · ${entry.attention} waiting` : ''
  return `${name}${note ? ` (${note})` : ''}${waiting}`
}
