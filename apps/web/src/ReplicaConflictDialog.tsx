// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  List,
  ListItem,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  Typography,
} from '@mui/material'

import { errorText } from './errorText'
import type { ReplicaConflict, UserSecret } from './types'
import {
  conflictEntries,
  defaultResolution,
  isIdentical,
  mergedSecrets,
  type ConflictEntry,
  type EntryResolution,
} from './vault/replicaConflict'

export interface ReplicaConflictDialogProps {
  open: boolean
  conflict: ReplicaConflict
  /** This device's copy — the vault's current secrets. */
  mySecrets: readonly UserSecret[]
  /** The member holding the rival copy, for display. */
  rivalLabel: string
  /** Publish the chosen secrets as one new version. */
  onResolve: (secrets: UserSecret[]) => Promise<number | null>
  onClose: () => void
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'publishing' }
  | { kind: 'error'; message: string }

/**
 * Merge two copies of a diverged vault and publish the result once — steps 3
 * and 4 of the library README's procedure for a replica version conflict.
 *
 * Every secret either copy holds is listed and kept by default: dropping is
 * the one choice that loses data, so it is never made for the owner. A secret
 * both copies hold with different contents is the one real decision, and it
 * defaults to this device's version.
 */
export function ReplicaConflictDialog({
  open,
  conflict,
  mySecrets,
  rivalLabel,
  onResolve,
  onClose,
}: ReplicaConflictDialogProps) {
  const rival = conflict.rivalSecrets
  const entries = useMemo(() => conflictEntries(mySecrets, rival ?? []), [mySecrets, rival])
  const [choices, setChoices] = useState<Record<string, EntryResolution>>({})
  const [showValues, setShowValues] = useState(false)
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' })

  const merged = mergedSecrets(entries, choices)
  const publishing = submit.kind === 'publishing'
  const choiceOf = (entry: ConflictEntry) => choices[entry.id] ?? defaultResolution(entry)
  const choose = (id: string, choice: EntryResolution) =>
    setChoices(current => ({ ...current, [id]: choice }))

  async function handlePublish() {
    setSubmit({ kind: 'publishing' })
    try {
      const version = await onResolve(merged)
      if (version === null) {
        setSubmit({ kind: 'error', message: 'No round was dispatched, so the vault is still diverged.' })
        return
      }
      onClose()
    } catch (err) {
      setSubmit({ kind: 'error', message: errorText(err) })
    }
  }

  return (
    <Dialog
      open={open}
      // Escape and the backdrop leave without publishing, which changes nothing.
      onClose={() => {
        if (!publishing) onClose()
      }}
      fullWidth
      maxWidth="sm"
      aria-labelledby="replica-conflict-title"
    >
      <DialogTitle id="replica-conflict-title">Resolve the conflict at v{conflict.version}</DialogTitle>

      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <DialogContentText>
            Choose what the vault should hold. It is published once, as a new version that replaces
            both copies on every member and helper.
          </DialogContentText>

          {rival === null && (
            <Alert severity="warning">
              {rivalLabel}’s copy has not reached this device yet, so only this device’s secrets are
              listed. Close this and use “Get the group’s copy” first — publishing now replaces{' '}
              {rivalLabel}’s copy with this one, and whatever only theirs holds is lost.
            </Alert>
          )}

          <FormControlLabel
            control={<Switch checked={showValues} onChange={e => setShowValues(e.target.checked)} />}
            label="Show secret values"
          />

          <List dense disablePadding aria-label="Secrets in the two copies">
            {entries.map(entry => (
              <ListItem key={entry.id} disableGutters divider sx={{ display: 'block' }}>
                <ConflictEntryRow
                  entry={entry}
                  choice={choiceOf(entry)}
                  onChoose={choice => choose(entry.id, choice)}
                  rivalLabel={rivalLabel}
                  showValues={showValues}
                  disabled={publishing}
                />
              </ListItem>
            ))}
          </List>

          <Typography variant="body2" color="text.secondary" role="status">
            The new version will hold {merged.length} secret{merged.length === 1 ? '' : 's'}.
          </Typography>

          {submit.kind === 'error' && <Alert severity="error">{submit.message}</Alert>}
        </Stack>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} disabled={publishing}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => void handlePublish()}
          disabled={publishing || merged.length === 0}
        >
          {publishing ? 'Publishing…' : 'Publish this version'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** A secret's value, or a mask when values are hidden. */
function valueText(secret: UserSecret, showValues: boolean): string {
  return showValues ? secret.data : '•'.repeat(Math.min(12, Math.max(4, secret.data.length)))
}

function ConflictEntryRow({
  entry,
  choice,
  onChoose,
  rivalLabel,
  showValues,
  disabled,
}: {
  entry: ConflictEntry
  choice: EntryResolution
  onChoose: (choice: EntryResolution) => void
  rivalLabel: string
  showValues: boolean
  disabled: boolean
}) {
  // Both copies hold it, and they differ: the one place to pick a side.
  if (entry.mine && entry.theirs && !isIdentical(entry)) {
    return (
      <Stack spacing={0.5}>
        <Typography variant="subtitle2">
          {entry.mine.name === entry.theirs.name
            ? entry.mine.name
            : `${entry.mine.name} / ${entry.theirs.name}`}{' '}
          <Typography component="span" variant="caption" color="text.secondary">
            — changed in both copies
          </Typography>
        </Typography>
        <RadioGroup
          value={choice}
          onChange={e => onChoose(e.target.value as EntryResolution)}
          aria-label={`Which version of ${entry.mine.name} to keep`}
        >
          <FormControlLabel
            value="mine"
            control={<Radio size="small" />}
            disabled={disabled}
            label={`This device’s: ${entry.mine.name} = ${valueText(entry.mine, showValues)}`}
          />
          <FormControlLabel
            value="theirs"
            control={<Radio size="small" />}
            disabled={disabled}
            label={`${rivalLabel}’s: ${entry.theirs.name} = ${valueText(entry.theirs, showValues)}`}
          />
          <FormControlLabel
            value="drop"
            control={<Radio size="small" />}
            disabled={disabled}
            label="Neither — leave it out"
          />
        </RadioGroup>
      </Stack>
    )
  }

  // Every entry holds at least one side — see `conflictEntries`.
  const secret = entry.mine ?? entry.theirs
  if (!secret) return null
  const origin = isIdentical(entry)
    ? 'in both copies'
    : entry.mine
      ? 'only on this device'
      : `only in ${rivalLabel}’s copy`
  const kept = choice !== 'drop'
  return (
    <FormControlLabel
      control={
        <Checkbox
          checked={kept}
          disabled={disabled}
          onChange={e => onChoose(e.target.checked ? defaultResolution(entry) : 'drop')}
        />
      }
      label={
        <span>
          <strong>{secret.name}</strong> = {valueText(secret, showValues)}{' '}
          <Typography component="span" variant="caption" color="text.secondary">
            — {origin}
          </Typography>
        </span>
      }
    />
  )
}
