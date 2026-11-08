// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import {
  Alert,
  Box,
  Button,
  Chip,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'

import type { SecretEntry, SecretRunState } from './secret/manager'
import { distinctSecretLabels } from './secretLabels'

export interface SecretListProps {
  entries: readonly SecretEntry[]
  /** Shown above the list — e.g. why a link landed here instead of on a secret. */
  notice: string | null
  /** A standing caveat about this browser, e.g. that tab locking is weakened here. */
  warning?: string | null
  onNew: (flow: 'setup' | 'claim') => void
  onOpen: (id: string) => void
  onClaim: (id: string) => void
  onRetry: (id: string) => void
  /** Remove a secret that has no page to do it from — failed or stopped. */
  onRemove: (id: string) => void
}

/**
 * The counts are a glance, not the job: on a phone they pushed the Open button
 * off the right edge, so they give way first and the row keeps its action.
 */
const WIDE_SCREEN_CELL = { display: { xs: 'none', sm: 'table-cell' } } as const

/** Every state in words, so none is carried by colour alone. */
const STATE_LABEL: Record<SecretRunState, string> = {
  starting: 'Starting…',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Failed to start',
  elsewhere: 'Open in another tab',
  blocked: 'Blocked',
}

/** What a row can do, by state. `null`: nothing until it settles. */
const ACTION: Record<SecretRunState, 'open' | 'claim' | 'retry' | null> = {
  starting: null,
  running: 'open',
  stopped: 'open',
  // Opening shows the blocked screen, which is the only place its failure lives.
  blocked: 'open',
  failed: 'retry',
  elsewhere: 'claim',
}

/**
 * Rows that can be removed from the list itself. A running secret is removed by
 * Leave on its page; one open elsewhere is in use by another tab's runtime, and
 * erasing its stores under it would corrupt that tab.
 */
const REMOVABLE: ReadonlySet<SecretRunState> = new Set(['failed', 'stopped'])

/** "1 needs your decision" / "3 need your decision". */
function attentionLabel(count: number): string {
  return `${count} ${count === 1 ? 'needs' : 'need'} your decision`
}

/**
 * The home screen: every secret this browser holds, and the way to add one.
 *
 * Rows come from the `SecretManager`, which lists secrets from storage before any
 * of them has started — so this renders at once and rows flip to Running as
 * each comes up. A secret another tab runs is listed with Claim rather than
 * taken; one that failed to start keeps its row, with Retry, and affects no
 * other.
 */
export function SecretList({
  entries,
  notice,
  warning = null,
  onNew,
  onOpen,
  onClaim,
  onRetry,
  onRemove,
}: SecretListProps) {
  const empty = entries.length === 0
  const labels = distinctSecretLabels(entries)

  return (
    <Stack spacing={3} sx={{ width: '100%', maxWidth: 880 }}>
      <Box>
        <Typography variant="h5" component="h2" gutterBottom>
          {empty ? 'Get started' : 'Your secrets'}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {empty
            ? 'Set up a secret on this device to begin.'
            : 'Every secret saved in this browser runs here at once. Open one to work with it.'}
        </Typography>
      </Box>

      {warning && <Alert severity="warning">{warning}</Alert>}
      {notice && <Alert severity="info">{notice}</Alert>}

      {!empty && (
        <TableContainer>
          <Table size="small" aria-label="Secrets saved in this browser">
            <TableHead>
              <TableRow>
                <TableCell>Secret</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right" sx={WIDE_SCREEN_CELL}>Paired</TableCell>
                <TableCell align="right" sx={WIDE_SCREEN_CELL}>Bag</TableCell>
                <TableCell align="right" sx={WIDE_SCREEN_CELL}>Replicas</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map(entry => (
                <SecretRow
                  key={entry.id}
                  entry={entry}
                  label={labels.get(entry.id) ?? entry.name}
                  onOpen={onOpen}
                  onClaim={onClaim}
                  onRetry={onRetry}
                  onRemove={onRemove}
                />
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} justifyContent="center">
        <Button variant="contained" onClick={() => onNew('setup')}>
          Set up a new secret
        </Button>
        <Button
          variant="outlined"
          onClick={() => onNew('claim')}
          title="Testing shortcut: adopt an existing owner actor's mailbox instead of registering a new one. Recovery itself does not need this — a recovering owner sets up normally and re-pairs."
        >
          Claim an existing actor
        </Button>
      </Stack>
    </Stack>
  )
}

interface SecretRowProps {
  entry: SecretEntry
  /** The name to show — suffixed with the id when another secret shares it. */
  label: string
  onOpen: (id: string) => void
  onClaim: (id: string) => void
  onRetry: (id: string) => void
  onRemove: (id: string) => void
}

function SecretRow({ entry, label, onOpen, onClaim, onRetry, onRemove }: SecretRowProps) {
  const action = ACTION[entry.state]

  return (
    <TableRow hover>
      <TableCell>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="body2" fontWeight={600}>
            {label}
          </Typography>
          {entry.attention > 0 && (
            <Chip size="small" color="warning" label={attentionLabel(entry.attention)} />
          )}
        </Stack>
      </TableCell>
      <TableCell>
        <Typography variant="body2">{STATE_LABEL[entry.state]}</Typography>
        {entry.state === 'failed' && entry.failure && (
          <Typography variant="caption" color="error">
            {entry.failure}
          </Typography>
        )}
      </TableCell>
      <TableCell align="right" sx={WIDE_SCREEN_CELL}>{entry.pairedCount}</TableCell>
      <TableCell align="right" sx={WIDE_SCREEN_CELL}>
        {entry.bagVersion === null ? '—' : `v${entry.bagVersion}`}
      </TableCell>
      <TableCell align="right" sx={WIDE_SCREEN_CELL}>{entry.replicaCount}</TableCell>
      <TableCell align="right">
        {action === 'open' && (
          <Button size="small" onClick={() => onOpen(entry.id)} aria-label={`Open ${label}`}>
            Open
          </Button>
        )}
        {action === 'claim' && (
          <Button
            size="small"
            onClick={() => onClaim(entry.id)}
            aria-label={`Claim ${label}`}
            title="Run this secret here. It must first be closed in the other tab."
          >
            Claim
          </Button>
        )}
        {action === 'retry' && (
          <Button size="small" onClick={() => onRetry(entry.id)} aria-label={`Retry ${label}`}>
            Retry
          </Button>
        )}
        {REMOVABLE.has(entry.state) && (
          <Button
            size="small"
            color="error"
            onClick={() => onRemove(entry.id)}
            aria-label={`Remove ${label}`}
          >
            Remove
          </Button>
        )}
      </TableCell>
    </TableRow>
  )
}
