import { useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'

import {
  apiGetDebugConfig,
  apiGetServerDefaults,
  type ConfigOrigin,
  type DebugConfig,
} from '../api'
import { errorText } from '../errorText'
import {
  FALLBACK_SERVER_DEFAULTS,
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

/** What each transport column means, in the operator's terms. */
const TRANSPORT_LABELS: Record<TransportModeKey, string> = {
  http: 'HTTP only',
  grpc: 'gRPC only',
  both: 'Both',
}

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

/**
 * What this node is configured with, in two halves that behave differently.
 *
 * **Node configuration** is read-only because it genuinely is: the backend
 * resolves it once at boot from its config file and `DEREC_*` variables, and
 * exposes no endpoint to change it. Rendering it as a form would promise
 * something the server cannot honour, so it renders as a table that says where
 * each value came from — the same data the node prints as its boot banner.
 *
 * **Protocol defaults** are editable because they are this browser's: they
 * prefill provisioning requests, and the backend holds no policy about them.
 */
export function SettingsPane() {
  const [config, setConfig] = useState<DebugConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)

  const [server, setServer] = useState<ServerDefaults>(FALLBACK_SERVER_DEFAULTS)
  const [draft, setDraft] = useState<ServerDefaults>(FALLBACK_SERVER_DEFAULTS)
  const [overridden, setOverridden] = useState<boolean>(
    () => Object.keys(loadDefaultOverrides()).length > 0,
  )
  const [saved, setSaved] = useState(false)

  // Both reads are fired once on mount and guarded by `cancelled`, so a pane
  // closed mid-flight does not write state into an unmounted component. The
  // work lives inside the effect rather than in a `useCallback` above it
  // because that is what makes the guard reachable from the cleanup.
  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const debug = await apiGetDebugConfig()
        if (cancelled) return
        setConfig(debug)
        setConfigError(null)
      } catch (err) {
        if (cancelled) return
        setConfigError(errorText(err))
      }

      try {
        const { defaults } = await apiGetServerDefaults()
        if (cancelled) return
        setServer(defaults)
        setDraft(effectiveDefaults(defaults))
      } catch {
        // The built-in fallbacks are the values the server ships, so an
        // unreachable node leaves the editor usable rather than empty.
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  function update<K extends keyof ServerDefaults>(key: K, value: ServerDefaults[K]) {
    setDraft(current => {
      const next = { ...current, [key]: value }
      // Changing the pool size moves the breakdown with it, so what is on
      // screen is what would actually be provisioned. The backend refuses a
      // breakdown that does not sum to the count.
      if (key === 'participantCount') {
        next.helperTransports = fitTransportsTo(next.helperTransports, next.participantCount)
      }
      return next
    })
    setSaved(false)
  }

  function save() {
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
    setDraft(server)
    setOverridden(false)
    setSaved(true)
  }

  return (
    <Box sx={{ maxWidth: 900 }}>
      <Stack spacing={3}>
        <Box>
          <Typography variant="h5" component="h1">
            Settings
          </Typography>
          <Typography color="text.secondary">
            What this node is configured with, and the protocol defaults new
            participants are provisioned with.
          </Typography>
        </Box>

        {/* ── Node configuration ──────────────────────────────────────────── */}
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

        <Divider />

        {/* ── Protocol defaults ───────────────────────────────────────────── */}
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
                  size="small"
                  type="number"
                  label="Participants"
                  value={draft.participantCount}
                  onChange={e => update('participantCount', Number(e.target.value))}
                  helperText="Target pool size"
                  sx={{ width: 160 }}
                />
                <TextField
                  size="small"
                  type="number"
                  label="Minimum"
                  value={draft.minParticipants}
                  onChange={e => update('minParticipants', Number(e.target.value))}
                  helperText="Needed to protect"
                  sx={{ width: 160 }}
                />
                <TextField
                  size="small"
                  type="number"
                  label="Recommended"
                  value={draft.recommendedParticipants}
                  onChange={e => update('recommendedParticipants', Number(e.target.value))}
                  helperText="Advised, not enforced"
                  sx={{ width: 180 }}
                />
              </Stack>
            </Box>

            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Transport mix
              </Typography>
              {draft.grpcEnabled ? (
                <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
                  {(['http', 'grpc', 'both'] as const).map(mode => (
                    <TextField
                      key={mode}
                      size="small"
                      type="number"
                      label={TRANSPORT_LABELS[mode]}
                      value={draft.helperTransports[mode]}
                      // Rebalanced rather than set: the three must sum to the
                      // pool size, and the node refuses a breakdown that does
                      // not.
                      onChange={e =>
                        update(
                          'helperTransports',
                          rebalance(
                            draft.helperTransports,
                            mode,
                            Number(e.target.value),
                            draft.participantCount,
                          ),
                        )
                      }
                      sx={{ width: 160 }}
                    />
                  ))}
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
                  onChange={e =>
                    update('autoAcceptUnpairRequests', e.target.value === 'auto')
                  }
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
                  onChange={e =>
                    update('authenticationMethod', e.target.value as AuthenticationMethod)
                  }
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
                  size="small"
                  type="number"
                  label="Protocol timeout (s)"
                  value={draft.protocolTimeoutSecs}
                  onChange={e => update('protocolTimeoutSecs', Number(e.target.value))}
                  helperText="Owner can change at setup"
                  sx={{ width: 200 }}
                />
                <TextField
                  size="small"
                  type="number"
                  label="Pre-paired"
                  value={draft.prePairedCount}
                  onChange={e => update('prePairedCount', Number(e.target.value))}
                  helperText="Owner can change at setup"
                  sx={{ width: 200 }}
                />
              </Stack>
            </Box>

            <Stack direction="row" spacing={1} alignItems="center">
              <Button variant="contained" onClick={save}>
                Save
              </Button>
              <Button onClick={reset} disabled={!overridden}>
                Reset to node
              </Button>
              {saved && (
                <Typography variant="body2" color="text.secondary">
                  Saved.
                </Typography>
              )}
            </Stack>

            <Typography variant="caption" color="text.secondary">
              These prefill provisioning and the setup wizard. They are defaults
              only — the settings a node actually runs with are whatever the
              front end sends on each request.
            </Typography>
          </Stack>
        </Box>
      </Stack>
    </Box>
  )
}
