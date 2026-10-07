// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material'

import type { ConfigOrigin, DebugConfig } from '../api'

/** The leaf name a setting is shown under, e.g. `defaults.grpc_port` → `grpc_port`. */
function leafOf(path: string): string {
  const cut = path.indexOf('.')
  return cut === -1 ? path : path.slice(cut + 1)
}

/** Everything under one table of the settings tree, in the order reported. */
function rowsFor(config: DebugConfig, table: 'server' | 'defaults'): ConfigOrigin[] {
  return config.origins.filter(o => o.path.startsWith(`${table}.`))
}

/** A settings value, read out of the nested tree by its dotted path. */
function valueAt(config: DebugConfig, path: string): string {
  const parts = path.split('.')
  let cursor: unknown = config.settings
  for (const part of parts) {
    if (typeof cursor !== 'object' || cursor === null) return ''
    cursor = (cursor as Record<string, unknown>)[part]
  }
  if (cursor === undefined || cursor === null) return ''
  return typeof cursor === 'object' ? JSON.stringify(cursor) : String(cursor)
}

function SourceChip({ origin }: { origin: ConfigOrigin }) {
  if (origin.source === 'env') {
    return (
      <Tooltip title={origin.variable ?? 'environment'}>
        <Chip size="small" color="primary" label={origin.variable ?? 'env'} />
      </Tooltip>
    )
  }
  if (origin.source === 'file') {
    return <Chip size="small" color="secondary" label="config file" />
  }
  return <Chip size="small" variant="outlined" label="default" />
}

export interface NodeConfigSectionProps {
  config: DebugConfig | null
  configError: string | null
}

/**
 * The node's own configuration, read-only because it genuinely is: the backend
 * resolves it once at boot from its config file and `DEREC_*` variables, and
 * exposes no endpoint to change it. Rendering it as a form would promise
 * something the server cannot honour, so it renders as a table that says where
 * each value came from — the same data the node prints as its boot banner.
 */
export function NodeConfigSection({ config, configError }: NodeConfigSectionProps) {
  return (
    <Box>
      <Typography variant="h6" component="h2" gutterBottom>
        Node configuration
      </Typography>

      {configError ? (
        <Alert severity="error">{configError}</Alert>
      ) : config === null ? (
        <Stack direction="row" spacing={1} alignItems="center">
          <CircularProgress size={18} />
          <Typography color="text.secondary">Reading configuration…</Typography>
        </Stack>
      ) : (
        <Stack spacing={1}>
          <Alert severity="info">
            Read-only. The node resolves these once at boot and has no
            endpoint to change them — edit <code>config.toml</code> or set the{' '}
            <code>DEREC_</code> variable, then restart.
            {config.file_found
              ? ' A config file was found.'
              : ' No config file was found, so these are defaults and variables only.'}
          </Alert>

          {config.unknown_env.length > 0 && (
            <Alert severity="warning">
              Ignored, because they match no setting:{' '}
              {config.unknown_env.join(', ')}
            </Alert>
          )}

          {(['server', 'defaults'] as const).map(table => (
            <Box key={table}>
              <Typography variant="overline" color="text.secondary">
                [{table}]
              </Typography>
              <TableContainer>
                <Table size="small" aria-label={`${table} configuration`}>
                  <TableHead>
                    <TableRow>
                      <TableCell>Setting</TableCell>
                      <TableCell>Value</TableCell>
                      <TableCell>Source</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rowsFor(config, table).map(origin => (
                      <TableRow key={origin.path} hover>
                        <TableCell>
                          <code>{leafOf(origin.path)}</code>
                        </TableCell>
                        <TableCell>{valueAt(config, origin.path)}</TableCell>
                        <TableCell>
                          <SourceChip origin={origin} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          ))}
        </Stack>
      )}
    </Box>
  )
}
