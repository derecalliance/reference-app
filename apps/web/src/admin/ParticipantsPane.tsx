// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'

import {
  apiAddHelper,
  apiDeleteParticipant,
  apiEnsureHelpers,
  apiGetActors,
  apiGetServerDefaults,
  apiToggleParticipantStatus,
  type BEActorWithStatus,
} from '../api'
import { errorText } from '../errorText'
import { FALLBACK_SERVER_DEFAULTS, type ServerDefaults } from '../config'
import { effectiveDefaults } from '../protocolDefaults'
import { randomParticipantName } from '../participantNames'
import { participantLabel } from './participantLabel'

/** How often the pool is refreshed while this pane is open. */
const POLL_MS = 4000

/** Every helper this node runs, newest last, in registration order. */
function helpersOf(actors: BEActorWithStatus[]): BEActorWithStatus[] {
  // Browser-managed actors run their protocol in a page and are nobody's to
  // provision, so the pool is the backend-run helpers.
  return actors.filter(a => a.role === 'helper' && !a.browser_managed)
}

/** The transports an actor advertises, as a short badge. */
function transportLabel(actor: BEActorWithStatus): string {
  const protocols = new Set((actor.transports ?? []).map(t => t.protocol))
  if (protocols.has('grpc') && protocols.has('https')) return 'both'
  if (protocols.has('grpc')) return 'grpc'
  return 'http'
}

/**
 * The provisioned-participant pool: what this node runs.
 *
 * This is the operator's half of what used to be one panel on the owner page.
 * The owner keeps a picker for *pairing* with these; provisioning them and
 * switching one offline are node decisions and live here.
 *
 * It holds no owner state and takes no props: the pool belongs to the node, so
 * this pane is usable before any owner exists.
 */
export function ParticipantsPane() {
  const [actors, setActors] = useState<BEActorWithStatus[] | null>(null)
  // Two kinds of failure, kept apart on purpose. The 4 s poll clears its own
  // error when it next succeeds; if it shared one slot with the actions, every
  // provision / toggle / delete failure vanished within seconds of appearing.
  const [pollError, setPollError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [defaults, setDefaults] = useState<ServerDefaults>(FALLBACK_SERVER_DEFAULTS)
  const [defaultsLoaded, setDefaultsLoaded] = useState(false)

  const [name, setName] = useState('')
  const [adding, setAdding] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Deletion is irreversible and server-wide, so it is confirmed rather than
  // done on the click. Holding the whole actor — not just its id — lets the
  // dialog say which participant, and whether it is currently paired.
  const [pendingDelete, setPendingDelete] = useState<BEActorWithStatus | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [ensuring, setEnsuring] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setActors(await apiGetActors())
      setPollError(null)
    } catch (err) {
      setPollError(errorText(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Polled rather than pushed: the node has no event stream, and a pool that
    // silently goes stale while an owner pairs in another tab is worse than a
    // request every few seconds against a local server.
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    // Provisioning needs the node's protocol defaults. Unreachable is not worth
    // blocking on — the built-in fallbacks are the same values the server
    // ships — but the answer is waited for: provisioning from the fallback a
    // moment before `/config` lands would size the pool from numbers the node
    // does not use.
    // Merged with any Settings overrides: provisioning from here must use the
    // same values the wizard would.
    let cancelled = false
    void apiGetServerDefaults().then(result => {
      if (cancelled) return
      setDefaults(effectiveDefaults(result.defaults))
      setDefaultsLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleAdd() {
    const trimmed = name.trim()
    if (!trimmed) return

    setAdding(true)
    setActionError(null)
    try {
      await apiAddHelper(trimmed, {
        protocolTimeoutSecs: defaults.protocolTimeoutSecs,
        unpairAck: defaults.unpairAck,
      })
      setName('')
      await refresh()
    } catch (err) {
      setActionError(errorText(err))
    } finally {
      setAdding(false)
    }
  }

  async function handleToggle(actor: BEActorWithStatus) {
    setBusyId(actor.id)
    setActionError(null)
    try {
      await apiToggleParticipantStatus(actor.id, !actor.disabled)
      await refresh()
    } catch (err) {
      setActionError(errorText(err))
    } finally {
      setBusyId(null)
    }
  }

  /**
   * Bring the pool up to the configured target.
   *
   * Setting up an owner no longer does this — the pool belongs to the node, and
   * an owner quietly re-creating participants an operator had deleted is the
   * bug this replaced. So growing it is an explicit action here, and it is what
   * gives the Settings participant count its effect.
   *
   * Only the shortfall is created; asking for fewer than exist removes nothing,
   * because another owner may be paired with one.
   */
  async function handleEnsurePool() {
    setEnsuring(true)
    setActionError(null)
    try {
      const names = Array.from({ length: defaults.participantCount }, randomParticipantName)
      await apiEnsureHelpers(defaults.participantCount, names, defaults.helperTransports, {
        protocolTimeoutSecs: defaults.protocolTimeoutSecs,
        unpairAck: defaults.unpairAck,
      })
      await refresh()
    } catch (err) {
      setActionError(errorText(err))
    } finally {
      setEnsuring(false)
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return

    setDeleting(true)
    setActionError(null)
    try {
      await apiDeleteParticipant(pendingDelete.id)
      setPendingDelete(null)
      await refresh()
    } catch (err) {
      // The dialog stays open on failure: closing it would leave the row on
      // screen with nothing said about why it is still there.
      setActionError(errorText(err))
    } finally {
      setDeleting(false)
    }
  }

  const helpers = actors === null ? [] : helpersOf(actors)

  return (
    <Box sx={{ maxWidth: 900 }}>
      <Stack spacing={2}>
        <Box>
          <Typography variant="h5" component="h1">
            Participants
          </Typography>
          <Typography color="text.secondary">
            The helpers this node runs. An owner pairs with them from the Owner
            section; provisioning them and switching one offline happen here.
          </Typography>
        </Box>

        {pollError && (
          <Alert severity="error">Could not refresh the pool: {pollError}</Alert>
        )}
        {actionError && (
          <Alert severity="error" onClose={() => setActionError(null)}>
            {actionError}
          </Alert>
        )}

        <Stack direction="row" spacing={1} alignItems="flex-start" flexWrap="wrap" useFlexGap>
          <TextField
            size="small"
            label="Name"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void handleAdd()
            }}
            placeholder="e.g. Alex"
            disabled={adding}
            sx={{ minWidth: 220 }}
          />
          <Button
            variant="contained"
            onClick={() => void handleAdd()}
            disabled={adding || !defaultsLoaded || name.trim() === ''}
            sx={{ mt: 0.25 }}
          >
            {adding ? 'Provisioning…' : 'Provision'}
          </Button>
          <Button
            onClick={() => void handleEnsurePool()}
            disabled={ensuring || !defaultsLoaded || helpers.length >= defaults.participantCount}
            sx={{ mt: 0.25 }}
          >
            {ensuring
              ? 'Provisioning…'
              : `Provision up to ${defaults.participantCount}`}
          </Button>
        </Stack>

        {actors === null ? (
          // Never loaded: the error above already says why, and a spinner next
          // to it would claim a load is still under way when it has failed.
          pollError === null && (
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={18} />
              <Typography color="text.secondary">Loading the pool…</Typography>
            </Stack>
          )
        ) : helpers.length === 0 ? (
          <Alert severity="info">
            No participants provisioned yet. Add one above, or use “Provision up
            to {defaults.participantCount}” to fill the pool to the node’s
            target. Setting up an owner does not provision any.
          </Alert>
        ) : (
          <>
            <Typography variant="body2" color="text.secondary">
              {helpers.length} provisioned
            </Typography>
            <TableContainer>
              <Table size="small" aria-label="Provisioned participants">
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Transport</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {helpers.map(actor => {
                    const label = participantLabel(actor, helpers)
                    return (
                      <TableRow key={actor.id} hover>
                        <TableCell>{actor.name}</TableCell>
                        <TableCell>
                          <Chip size="small" label={transportLabel(actor)} />
                        </TableCell>
                        <TableCell>
                          {actor.disabled ? (
                            <Chip size="small" color="warning" label="offline" />
                          ) : (
                            <Typography variant="body2" color="text.secondary">
                              online
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell align="right">
                          <Stack direction="row" spacing={1} justifyContent="flex-end">
                            {/* Named per row: every row repeats the same two
                                labels, which a screen reader's button list cannot
                                tell apart without the participant's name. */}
                            <Button
                              size="small"
                              onClick={() => void handleToggle(actor)}
                              disabled={busyId === actor.id}
                              aria-label={`${actor.disabled ? 'Bring online' : 'Take offline'} ${label}`}
                            >
                              {actor.disabled ? 'Bring online' : 'Take offline'}
                            </Button>
                            <Button
                              size="small"
                              color="error"
                              onClick={() => setPendingDelete(actor)}
                              disabled={busyId === actor.id}
                              aria-label={`Delete ${label}`}
                            >
                              Delete
                            </Button>
                          </Stack>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}

        <Typography variant="caption" color="text.secondary">
          Taking a participant offline simulates an unreachable peer: the node
          accepts messages for it and drops them, which is how a helper going
          away is tested without stopping anything. Deleting one removes it from
          the node entirely.
        </Typography>
      </Stack>

      <Dialog
        open={pendingDelete !== null}
        onClose={() => !deleting && setPendingDelete(null)}
        aria-labelledby="delete-participant-title"
      >
        <DialogTitle id="delete-participant-title">
          Delete {pendingDelete?.name}?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            This removes the participant from this node completely — its actor,
            its stored channels and shares, and its registry entry. It cannot be
            undone, and the pool is shared, so it disappears for every owner on
            this node.
          </DialogContentText>
          {pendingDelete?.channel_id && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              This participant holds at least one channel — possibly with an
              owner in another browser, since the pool is shared. Each of them
              keeps its channel and will see this participant stop responding,
              exactly as if it had gone offline; clearing the row means
              unpairing from that owner’s side.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDelete(null)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => void handleDelete()}
            disabled={deleting}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
