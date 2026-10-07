// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'
import { errorText } from './errorText'
import {
  Alert,
  AlertTitle,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Stack,
  Typography,
} from '@mui/material'
import {
  ReplicaAdoptionError,
  type PendingReplicaAdoption,
  type RestoreFailure,
} from './replicaFlows'

/**
 * The confirmation gate in front of a wipe-and-adopt.
 *
 * Adoption is the one destructive action in the replica flows: it erases
 * everything this device holds and installs another device's vault in its
 * place. The dialog therefore says so in those words, names the owner whose
 * vault replaces it, and makes **cancel** the default action — it takes focus,
 * carries the filled styling, and is what Escape and a backdrop click resolve
 * to. Confirming takes a deliberate click on a red, outlined button.
 *
 * Nothing here performs the adoption; `onAdopt` does, and it is only ever
 * called from the confirm handler.
 *
 * Raised only for a device that confirmed its replica channel before the app
 * asked about adoption up front. From SDK 0.0.7 confirming the fingerprint is
 * itself the decision to adopt, so the fingerprint dialog asks it first and an
 * agreed offer is adopted without coming here (`VaultRuntime.offerReplicaAdoption`).
 * For an older confirmation this is still the only question asked — but the
 * library has already installed the group's copy by then, so rejecting keeps
 * this vault on screen without taking the device out of the group.
 */

export interface ReplicaAdoptionDialogProps {
  open: boolean
  adoption: PendingReplicaAdoption
  /** The owner whose vault this device would take on. */
  sourceLabel: string
  /**
   * Run the wipe-and-adopt. Rejects with a `ReplicaAdoptionError` when
   * `restore` refused; the dialog renders the failure verbatim and never
   * retries.
   */
  onAdopt: (adoption: PendingReplicaAdoption) => Promise<void>
  /** Adoption committed. The caller drops the pending payload and closes. */
  onAdopted: () => void
  /**
   * A verdict from an earlier attempt on this same channel, if there was one.
   *
   * Held by the caller rather than here so it outlives a remount. The offer is
   * keyed by version, and the source re-sends on every round: without this, a
   * v+1 offer would remount the dialog at `idle` and re-arm a destructive
   * confirm whose previous attempt failed, with the evidence gone.
   */
  priorFailure: RestoreFailure | null
  /** Record a verdict so it survives this dialog. Called once, on failure. */
  onFailed: (failure: RestoreFailure) => void
  /**
   * Leave without adopting. Nothing has been erased; the payload is discarded
   * and the source's next sync re-offers it.
   */
  onCancel: () => void
}

type AdoptionState =
  | { kind: 'idle' }
  | { kind: 'adopting' }
  /** Terminal. `restore` refused, so the confirm is spent — see `canConfirm`. */
  | { kind: 'failed'; failure: RestoreFailure }

/** Present an unexpected throw the same way a structured refusal is presented. */
function failureFrom(err: unknown): RestoreFailure {
  if (err instanceof ReplicaAdoptionError) return err.failure
  const message = errorText(err)
  return {
    code: 'UNKNOWN',
    message,
    channelIds: [],
    wipeDidNotTake: false,
    text: message,
  }
}

export function ReplicaAdoptionDialog({
  open,
  adoption,
  sourceLabel,
  onAdopt,
  onAdopted,
  onCancel,
  priorFailure,
  onFailed,
}: ReplicaAdoptionDialogProps) {
  // Seeded from the caller's record so a remount — which a newer offer for the
  // same channel forces — reopens on the spent verdict rather than at `idle`.
  const [state, setState] = useState<AdoptionState>(
    priorFailure ? { kind: 'failed', failure: priorFailure } : { kind: 'idle' },
  )

  const adopting = state.kind === 'adopting'
  // A refusal is terminal on purpose. `restore` rejects before touching a store
  // when its preconditions fail, which here means the wipe did not take — and a
  // second attempt would run against half-adopted state. There is no retry.
  const canConfirm = state.kind === 'idle'

  async function handleConfirm() {
    setState({ kind: 'adopting' })
    try {
      await onAdopt(adoption)
      onAdopted()
    } catch (err) {
      const failure = failureFrom(err)
      setState({ kind: 'failed', failure })
      onFailed(failure)
    }
  }

  function handleCancel() {
    // Never interrupt an in-flight adoption: the namespace is already erased by
    // then, and closing would only hide what happens next.
    if (adopting) return
    onCancel()
  }

  const shareCount = adoption.shares.length

  return (
    <Dialog
      open={open}
      // Escape and a backdrop click resolve to Reject, exactly as the button
      // does — the safe answer, and the one the README documents. Rejecting
      // erases nothing and the source re-offers on its next sync, so an
      // accidental dismissal costs one more prompt, never the vault.
      // `handleCancel` itself refuses while an adoption is in flight.
      onClose={() => handleCancel()}
      fullWidth
      maxWidth="sm"
      aria-labelledby="replica-adopt-title"
    >
      <DialogTitle id="replica-adopt-title">Replace this vault?</DialogTitle>

      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <Alert severity="warning">
            {/* Scoped to this vault: adoption clears only this vault's own
                namespace (`vault:<id>`), so other vaults saved in this browser
                are untouched — saying "everything" would overstate it. */}
            <AlertTitle>This erases everything this vault holds</AlertTitle>
            Every secret, helper channel and share this vault stores on this device is
            deleted and replaced with {sourceLabel}’s vault. Other vaults in this browser
            are not affected. It cannot be undone from this app.
          </Alert>

          <DialogContentText>
            {sourceLabel} sent this device a mirrored copy of their vault. Adopting it
            makes this vault a replica of theirs: it takes on {sourceLabel}’s secrets and
            helper roster, and stops holding anything of its own.
          </DialogContentText>

          <Divider />

          <Stack spacing={0.5}>
            <Typography variant="body2" color="text.secondary">
              Version {adoption.version} · {shareCount} helper share
              {shareCount === 1 ? '' : 's'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Secret {adoption.secretId} · from replica source {adoption.fromReplicaId} on
              channel {adoption.channelId}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              This device keeps its own identity — only the vault changes.
            </Typography>
          </Stack>

          {state.kind === 'failed' && (
            <Alert severity="error">
              <AlertTitle>The vault was erased and the restore did not complete</AlertTitle>
              <Typography
                variant="body2"
                component="p"
                sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}
              >
                {state.failure.text}
              </Typography>
              <Typography variant="body2" sx={{ mt: 1 }}>
                {state.failure.wipeDidNotTake
                  ? 'This means the erase did not take effect. Adoption will not be retried — retrying would restore over partially adopted state. Close this and inspect the device before trying again.'
                  : 'Adoption will not be retried automatically. Close this and inspect the device before trying again.'}
              </Typography>
            </Alert>
          )}
        </Stack>
      </DialogContent>

      <DialogActions>
        {/* The safe answer, and the default: filled and autofocused, and what
            Escape and a backdrop click resolve to — so the destructive one is
            never the thing a stray keypress reaches. */}
        <Button variant="contained" onClick={handleCancel} disabled={adopting} autoFocus>
          {state.kind === 'failed' ? 'Close' : 'Reject'}
        </Button>
        <Button
          variant="outlined"
          color="error"
          onClick={() => void handleConfirm()}
          disabled={!canConfirm}
        >
          {adopting ? 'Erasing and adopting…' : 'Erase and adopt'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
