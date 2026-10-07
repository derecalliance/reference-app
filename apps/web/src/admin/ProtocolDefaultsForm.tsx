// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState, type ChangeEvent } from 'react'
import {
  Alert,
  Box,
  Button,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material'

import {
  MIN_PROTOCOL_TIMEOUT_SECS,
  type AuthenticationMethod,
  type ServerDefaults,
  type UnpairAck,
} from '../config'
import { fitTransportsTo, rebalance, type TransportModeKey } from '../transportMix'
import {
  clearDefaultOverrides,
  effectiveDefaults,
  loadDefaultOverrides,
  persistDefaultOverrides,
} from '../protocolDefaults'
import {
  MAX_PARTICIPANTS,
  MAX_PROTOCOL_TIMEOUT_SECS,
  MIN_THRESHOLD,
  hasErrors,
  parseWholeNumber,
  validateDefaults,
  type NumericDefault,
} from './defaultsValidation'

/** What each transport column means, in the operator's terms. */
const TRANSPORT_LABELS: Record<TransportModeKey, string> = {
  http: 'HTTP only',
  grpc: 'gRPC only',
  both: 'Both',
}

/** A number for a field's `value`: `NaN` shows as empty rather than as "NaN". */
function shown(value: number): number | '' {
  return Number.isNaN(value) ? '' : value
}

/** A key per editable number on the form: the counts, and each transport column. */
type FieldKey = Exclude<NumericDefault, 'helperTransports'> | TransportModeKey

export interface ProtocolDefaultsFormProps {
  /**
   * The node's own defaults, as `GET /api/v1/config` served them.
   *
   * Required rather than defaulted to the built-in fallback: the form only
   * mounts once these have loaded. Seeded from the fallback, an edit made while
   * the request was in flight was overwritten when it landed, and a save in
   * that window stored overrides computed against values the node does not use.
   */
  server: ServerDefaults
}

/**
 * The editable half of Settings: this browser's protocol defaults.
 *
 * Editable because they are this browser's — they prefill provisioning
 * requests and the setup wizard, and the backend holds no policy about them.
 */
export function ProtocolDefaultsForm({ server }: ProtocolDefaultsFormProps) {
  const [draft, setDraft] = useState<ServerDefaults>(() => effectiveDefaults(server))
  const [overridden, setOverridden] = useState<boolean>(
    () => Object.keys(loadDefaultOverrides()).length > 0,
  )
  const [saved, setSaved] = useState(false)
  // Text a field holds that is not a count — `1e3`, `2.5`. The draft records
  // `NaN` for it, so validation flags it; this keeps what was typed on screen
  // rather than blanking the field under the cursor.
  const [rejectedText, setRejectedText] = useState<Partial<Record<FieldKey, string>>>({})

  /** Parse a field's text, remembering it when it is not a plain count. */
  function parseField(field: FieldKey, text: string): number {
    const value = parseWholeNumber(text)
    setRejectedText(current => {
      const next = { ...current }
      if (Number.isNaN(value) && text.trim() !== '') next[field] = text
      else delete next[field]
      return next
    })
    return value
  }

  /** What a field shows: rejected text as typed, otherwise the draft's number. */
  function display(field: FieldKey, value: number): number | string {
    return rejectedText[field] ?? shown(value)
  }

  const errors = validateDefaults(draft)
  const invalid = hasErrors(errors)

  function update<K extends keyof ServerDefaults>(key: K, value: ServerDefaults[K]) {
    setDraft(current => {
      const next = { ...current, [key]: value }
      // Changing the pool size moves the breakdown with it, so what is on
      // screen is what would actually be provisioned. The backend refuses a
      // breakdown that does not sum to the count.
      const pool = next.participantCount
      if (key === 'participantCount' && Number.isInteger(pool) && pool > 0) {
        next.helperTransports = fitTransportsTo(next.helperTransports, pool)
      }
      return next
    })
    setSaved(false)
  }

  function save() {
    if (invalid) return
    // Only what actually differs from the node is stored, so a value left alone
    // keeps following the server when it is reconfigured.
    const overrides: Partial<ServerDefaults> = {}
    for (const key of Object.keys(draft) as (keyof ServerDefaults)[]) {
      if (JSON.stringify(draft[key]) !== JSON.stringify(server[key])) {
        overrides[key] = draft[key] as never
      }
    }

    if (Object.keys(overrides).length === 0) {
      clearDefaultOverrides()
      setOverridden(false)
    } else {
      persistDefaultOverrides(overrides)
      setOverridden(true)
    }
    setSaved(true)
  }

  function reset() {
    clearDefaultOverrides()
    setRejectedText({})
    setDraft(server)
    setOverridden(false)
    setSaved(true)
  }

  /** The props every count field shares: its value, parsing, and error. */
  function countField(key: Exclude<NumericDefault, 'helperTransports'>, hint: string) {
    return {
      size: 'small' as const,
      type: 'number',
      value: display(key, draft[key]),
      onChange: (e: ChangeEvent<HTMLInputElement>) =>
        update(key, parseField(key, e.target.value)),
      error: errors[key] !== undefined,
      helperText: errors[key] ?? hint,
    }
  }

  return (
    <Box>
      <Typography variant="h6" component="h2" gutterBottom>
        Protocol defaults
      </Typography>

      <Stack spacing={3}>
        <Alert severity={overridden ? 'warning' : 'info'}>
          {overridden
            ? 'Overridden in this browser. Values you have not changed still follow the node.'
            : 'Following the node. Changing one here overrides it for this browser only — it travels on each provisioning request rather than being stored on the server.'}
        </Alert>

        {/* The pool belongs to the node: an app would never ask someone
            creating an account how many helpers to run, so none of this
            appears in the owner wizard. */}
        <Box>
          <Typography variant="subtitle2" gutterBottom>
            Participant pool
          </Typography>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
            <TextField
              label="Participants"
              {...countField('participantCount', 'Target pool size')}
              slotProps={{ htmlInput: { min: MIN_THRESHOLD, max: MAX_PARTICIPANTS, step: 1 } }}
              sx={{ width: 180 }}
            />
            <TextField
              label="Minimum"
              {...countField('minParticipants', `Needed to protect (${MIN_THRESHOLD} or more)`)}
              slotProps={{ htmlInput: { min: MIN_THRESHOLD, max: MAX_PARTICIPANTS, step: 1 } }}
              sx={{ width: 180 }}
            />
            <TextField
              label="Recommended"
              {...countField('recommendedParticipants', 'Advised, not enforced')}
              slotProps={{ htmlInput: { min: 1, max: MAX_PARTICIPANTS, step: 1 } }}
              sx={{ width: 200 }}
            />
          </Stack>
        </Box>

        <Box>
          <Typography variant="subtitle2" gutterBottom>
            Transport mix
          </Typography>
          {draft.grpcEnabled ? (
            <Stack spacing={1}>
              <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
                {(['http', 'grpc', 'both'] as const).map(mode => (
                  <TextField
                    key={mode}
                    size="small"
                    type="number"
                    label={TRANSPORT_LABELS[mode]}
                    value={display(mode, draft.helperTransports[mode])}
                    error={errors.helperTransports !== undefined}
                    slotProps={{ htmlInput: { min: 0, step: 1 } }}
                    // Rebalanced rather than set: the three must sum to the
                    // pool size, and the node refuses a breakdown that does
                    // not.
                    onChange={e =>
                      update(
                        'helperTransports',
                        rebalance(
                          draft.helperTransports,
                          mode,
                          parseField(mode, e.target.value),
                          draft.participantCount,
                        ),
                      )
                    }
                    sx={{ width: 160 }}
                  />
                ))}
              </Stack>
              {errors.helperTransports ? (
                <Typography variant="caption" color="error" role="alert">
                  {errors.helperTransports}
                </Typography>
              ) : (
                <Typography variant="caption" color="text.secondary">
                  The three always add up to the pool size ({draft.participantCount}). The
                  field you edit keeps its value; the others shift to make room — a raise
                  takes from the largest, a cut goes to HTTP only (or to gRPC only, when
                  HTTP only is the field being cut).
                </Typography>
              )}
            </Stack>
          ) : (
            <Alert severity="info">
              This node does not run the gRPC listener, so every participant
              is reachable over HTTP only.
            </Alert>
          )}
        </Box>

        <Box>
          <Typography variant="subtitle2" gutterBottom>
            Protocol policy
          </Typography>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
            <TextField
              size="small"
              select
              label="Unpair acknowledgement"
              value={draft.unpairAck}
              onChange={e => update('unpairAck', e.target.value as UnpairAck)}
              sx={{ width: 220 }}
            >
              <MenuItem value="required">required</MenuItem>
              <MenuItem value="not_required">not_required</MenuItem>
            </TextField>
            <TextField
              size="small"
              select
              label="Incoming unpair requests"
              value={draft.autoAcceptUnpairRequests ? 'auto' : 'prompt'}
              onChange={e => update('autoAcceptUnpairRequests', e.target.value === 'auto')}
              sx={{ width: 220 }}
            >
              <MenuItem value="auto">auto-accept</MenuItem>
              <MenuItem value="prompt">show a dialog</MenuItem>
            </TextField>
            <TextField
              size="small"
              select
              label="Incoming share storage requests"
              value={draft.autoAcceptStoreShareRequests ? 'auto' : 'prompt'}
              onChange={e => update('autoAcceptStoreShareRequests', e.target.value === 'auto')}
              sx={{ width: 220 }}
            >
              <MenuItem value="auto">auto-accept</MenuItem>
              <MenuItem value="prompt">show a dialog</MenuItem>
            </TextField>
            <TextField
              size="small"
              select
              label="Incoming verification requests"
              value={draft.autoAcceptVerifyShareRequests ? 'auto' : 'prompt'}
              onChange={e => update('autoAcceptVerifyShareRequests', e.target.value === 'auto')}
              sx={{ width: 220 }}
            >
              <MenuItem value="auto">auto-accept</MenuItem>
              <MenuItem value="prompt">show a dialog</MenuItem>
            </TextField>
            <TextField
              size="small"
              select
              label="Authentication method"
              value={draft.authenticationMethod}
              onChange={e => update('authenticationMethod', e.target.value as AuthenticationMethod)}
              sx={{ width: 220 }}
            >
              <MenuItem value="user">user</MenuItem>
              <MenuItem value="application" disabled>
                application (not yet enabled)
              </MenuItem>
            </TextField>
          </Stack>
        </Box>

        {/* Defaults for values the owner wizard still asks about, so a new
            owner starts from the node's answer and can change it. */}
        <Box>
          <Typography variant="subtitle2" gutterBottom>
            Defaults for new owners
          </Typography>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
            <TextField
              label="Protocol timeout (s)"
              {...countField('protocolTimeoutSecs', 'Owner can change at setup')}
              slotProps={{
                htmlInput: { min: MIN_PROTOCOL_TIMEOUT_SECS, max: MAX_PROTOCOL_TIMEOUT_SECS, step: 1 },
              }}
              sx={{ width: 200 }}
            />
            <TextField
              label="Pre-paired"
              {...countField('prePairedCount', 'Owner can change at setup')}
              slotProps={{ htmlInput: { min: 0, max: MAX_PARTICIPANTS, step: 1 } }}
              sx={{ width: 200 }}
            />
          </Stack>
        </Box>

        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Button variant="contained" onClick={save} disabled={invalid}>
            Save
          </Button>
          <Button onClick={reset} disabled={!overridden}>
            Reset to node
          </Button>
          <Typography variant="body2" color={invalid ? 'error' : 'text.secondary'} aria-live="polite">
            {invalid ? 'Fix the highlighted fields to save.' : saved ? 'Saved.' : ''}
          </Typography>
        </Stack>

        <Typography variant="caption" color="text.secondary">
          These prefill provisioning and the setup wizard. They are defaults
          only — the settings a node actually runs with are whatever the
          front end sends on each request.
        </Typography>
      </Stack>
    </Box>
  )
}
