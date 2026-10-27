// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined'
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined'
import { IconButton } from '@mui/material'

import { setColorScheme, useColorScheme } from './colorScheme'

/**
 * Switches the app between its dark and light schemes.
 *
 * The icon shows the scheme a click switches *to* — a moon on the light page, a
 * sun on the dark one — and the label says so in words.
 */
export function ThemeToggle() {
  const scheme = useColorScheme()
  const next = scheme === 'dark' ? 'light' : 'dark'
  const label = `Switch to ${next} theme`

  return (
    <IconButton aria-label={label} title={label} onClick={() => setColorScheme(next)}>
      {next === 'light' ? <LightModeOutlinedIcon /> : <DarkModeOutlinedIcon />}
    </IconButton>
  )
}
