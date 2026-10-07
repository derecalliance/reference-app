// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'
import { Alert, AlertTitle, Button, Stack } from '@mui/material'

import { AppMuiTheme } from './AppMuiTheme'
import { errorText } from './errorText'
import { ReplicaConflictDialog } from './ReplicaConflictDialog'
import type { ReplicaConflict, UserSecret } from './types'

export interface ReplicaConflictPanelProps {
  conflict: ReplicaConflict
  mySecrets: readonly UserSecret[]
  /** The member holding the rival copy, for display. */
  rivalLabel: string
  /** Ask the group for its copy — a replica discovery. */
  onFetchRival: () => Promise<void>
  onResolve: (secrets: UserSecret[]) => Promise<number | null>
}

type FetchState = { kind: 'idle' } | { kind: 'fetching' } | { kind: 'asked' } | { kind: 'error'; message: string }

/**
 * The standing notice on a vault whose copy has diverged from its replica
 * group's, and the way out of it.
 *
 * Publishing is paused while it shows — every control that would publish says
 * so — because a further version from this device would erase the other
 * member's change. It stays at the top of the page until the conflict is
 * resolved, here or by another member publishing past it.
 */
export function ReplicaConflictPanel({
  conflict,
  mySecrets,
  rivalLabel,
  onFetchRival,
  onResolve,
}: ReplicaConflictPanelProps) {
  const [resolving, setResolving] = useState(false)
  const [fetchState, setFetchState] = useState<FetchState>({ kind: 'idle' })
  const haveRival = conflict.rivalSecrets !== null

  async function handleFetch() {
    setFetchState({ kind: 'fetching' })
    try {
      await onFetchRival()
      setFetchState({ kind: 'asked' })
    } catch (err) {
      setFetchState({ kind: 'error', message: errorText(err) })
    }
  }

  return (
    <AppMuiTheme>
      <Alert
        severity="warning"
        sx={{ mx: 2, my: 1, textAlign: 'left' }}
        action={
          <Stack direction="row" spacing={1}>
            {!haveRival && (
              <Button
                color="inherit"
                size="small"
                onClick={() => void handleFetch()}
                disabled={fetchState.kind === 'fetching'}
              >
                {fetchState.kind === 'fetching' ? 'Asking…' : 'Get the group’s copy'}
              </Button>
            )}
            <Button color="inherit" size="small" onClick={() => setResolving(true)}>
              Resolve…
            </Button>
          </Stack>
        }
      >
        <AlertTitle>This vault has diverged from its replica group</AlertTitle>
        {rivalLabel} holds a different copy of v{conflict.version}. Publishing from this device is
        paused: a new version from here would replace {rivalLabel}’s copy and lose its change.{' '}
        {haveRival
          ? 'Both copies are here — resolve the conflict to merge them and publish once.'
          : 'Get the group’s copy, then resolve the conflict to merge the two and publish once.'}
        {fetchState.kind === 'asked' && !haveRival && (
          <> Asked the group — its copy is offered here as soon as it arrives.</>
        )}
        {fetchState.kind === 'error' && <> Could not ask the group: {fetchState.message}</>}
      </Alert>

      {resolving && (
        <ReplicaConflictDialog
          open
          conflict={conflict}
          mySecrets={mySecrets}
          rivalLabel={rivalLabel}
          onResolve={onResolve}
          onClose={() => setResolving(false)}
        />
      )}
    </AppMuiTheme>
  )
}
