// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  Stack,
  Typography,
} from '@mui/material'

import { apiGetDebugConfig, apiGetServerDefaults, type DebugConfig } from '../api'
import { errorText } from '../errorText'
import type { ServerDefaults } from '../config'
import { NodeConfigSection } from './NodeConfigSection'
import { ProtocolDefaultsForm } from './ProtocolDefaultsForm'

/** The node's defaults, as far as this pane knows them. */
type NodeDefaults =
  | { status: 'loading' }
  | { status: 'unreachable' }
  | { status: 'loaded'; defaults: ServerDefaults }

/**
 * What this node is configured with, in two halves that behave differently.
 *
 * **Node configuration** is read-only because it genuinely is — see
 * `NodeConfigSection`.
 *
 * **Protocol defaults** are editable because they are this browser's: they
 * prefill provisioning requests, and the backend holds no policy about them.
 * The form waits for the node's own values before it appears: overrides are
 * stored as the difference from them, so editing against a stand-in would
 * either be overwritten when the real values landed or be saved as overrides
 * of numbers the node never had.
 */
export function SettingsPane() {
  const [config, setConfig] = useState<DebugConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [node, setNode] = useState<NodeDefaults>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  // Both reads are fired on mount (and again on Retry) and guarded by
  // `cancelled`, so a pane closed mid-flight does not write state into an
  // unmounted component. The work lives inside the effect rather than in a
  // `useCallback` above it because that is what makes the guard reachable from
  // the cleanup.
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

      const { defaults, reachable } = await apiGetServerDefaults()
      if (cancelled) return
      setNode(reachable ? { status: 'loaded', defaults } : { status: 'unreachable' })
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [attempt])

  function retry() {
    setNode({ status: 'loading' })
    setConfigError(null)
    setAttempt(n => n + 1)
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

        <NodeConfigSection config={config} configError={configError} />

        <Divider />

        {node.status === 'loaded' ? (
          <ProtocolDefaultsForm server={node.defaults} />
        ) : (
          <Box>
            <Typography variant="h6" component="h2" gutterBottom>
              Protocol defaults
            </Typography>
            {node.status === 'loading' ? (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size={18} />
                <Typography color="text.secondary">Reading the node’s defaults…</Typography>
              </Stack>
            ) : (
              <Alert
                severity="error"
                action={
                  <Button color="inherit" size="small" onClick={retry}>
                    Retry
                  </Button>
                }
              >
                Cannot reach the DeRec server, so its defaults are unknown. Overrides are
                stored as differences from them, so they can be edited once it answers.
              </Alert>
            )}
          </Box>
        )}
      </Stack>
    </Box>
  )
}
