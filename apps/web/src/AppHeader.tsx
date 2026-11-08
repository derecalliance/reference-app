// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import { Badge, Box, IconButton, Menu, MenuItem, useMediaQuery, useTheme } from '@mui/material'

import type { SecretEntry } from './secret/manager'
import { NotificationBell } from './NotificationBell'
import { ThemeToggle } from './ThemeToggle'
import { SecretSwitcher } from './SecretSwitcher'

const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, '') // e.g. "/reference-app"

/** Hidden from sight, not from screen readers. */
// Explicit px: in `sx`, a number in (0, 1] is a *fraction*, so `width: 1`
// meant 100% — a full-width absolute box that pushed the page sideways on a
// phone.
const VISUALLY_HIDDEN = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const

export interface AppHeaderProps {
  entries: readonly SecretEntry[]
  /** The secret the route names, or `null` on the list and the wizard. */
  localSecretId: string | null
  /** Whether that secret's own page is showing — what Leave acts on. */
  secretPageShown: boolean
  /** Other secrets with a decision waiting; `0` hides the notice. */
  othersWaiting: number
  onShowAll: () => void
  onSwitch: (id: string) => void
  /** Open a secret's Notifications tab — from the bell — marking `notificationId` read when one was picked. */
  onOpenNotifications: (localSecretId: string, notificationId: string | null) => void
  onLeave: () => void
  onReset: () => void
}

/** "1 other secret needs your decision" / "2 other secrets need your decision". */
function othersWaitingLabel(count: number): string {
  return count === 1
    ? '1 other secret needs your decision'
    : `${count} other secrets need your decision`
}

/**
 * The page header: logo, the secret switcher, the theme toggle and the app-wide
 * actions.
 *
 * Below `md` the actions fold into a menu. Laid out in one row they need about
 * 700px — the switcher alone may take 260 — and on a phone they ran off the
 * right edge of the page rather than wrapping. The switcher stays out of the
 * menu because getting to another secret is what the header is for; the theme
 * toggle and the bell are icons, small enough to stay too.
 */
export function AppHeader({
  entries,
  localSecretId,
  secretPageShown,
  othersWaiting,
  onShowAll,
  onSwitch,
  onOpenNotifications,
  onLeave,
  onReset,
}: AppHeaderProps) {
  const theme = useTheme()
  const compact = useMediaQuery(theme.breakpoints.down('md'))
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const waitingLabel = othersWaiting > 0 ? othersWaitingLabel(othersWaiting) : null

  /** Close the menu, then act — so focus is not left on a menu being torn down. */
  const fromMenu = (action: () => void) => () => {
    setMenuAnchor(null)
    action()
  }

  return (
    <header className={compact ? 'header--compact' : undefined}>
      <img src={`${BASE_PATH}/logo-color.svg`} alt="DeRec Alliance" height="32" />
      <div className="header-spacer" />

      {compact ? (
        <>
          {/* Always mounted, so screen readers hear the count when it appears. */}
          <Box component="span" aria-live="polite" sx={VISUALLY_HIDDEN}>
            {waitingLabel ?? ''}
          </Box>
          <ThemeToggle />
          <NotificationBell entries={entries} currentLocalSecretId={secretPageShown ? localSecretId : null} onOpen={onOpenNotifications} />
          {entries.length > 0 && (
            <SecretSwitcher entries={entries} currentId={localSecretId} onSelect={onSwitch} />
          )}
          <IconButton
            aria-label={waitingLabel ? `More actions — ${waitingLabel}` : 'More actions'}
            aria-haspopup="menu"
            aria-expanded={menuAnchor !== null}
            onClick={event => setMenuAnchor(event.currentTarget)}
          >
            <Badge color="warning" badgeContent={othersWaiting} invisible={othersWaiting === 0}>
              <MoreVertIcon />
            </Badge>
          </IconButton>
          <Menu
            anchorEl={menuAnchor}
            open={menuAnchor !== null}
            onClose={() => setMenuAnchor(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          >
            {waitingLabel && <MenuItem onClick={fromMenu(onShowAll)}>{waitingLabel}</MenuItem>}
            {localSecretId && <MenuItem onClick={fromMenu(onShowAll)}>All secrets</MenuItem>}
            {secretPageShown && <MenuItem onClick={fromMenu(onLeave)}>Leave</MenuItem>}
            <MenuItem onClick={fromMenu(onReset)} sx={{ color: 'error.main' }}>
              Reset browser data
            </MenuItem>
          </Menu>
        </>
      ) : (
        <>
          {/* Always mounted, so screen readers hear the count when it appears. */}
          <span aria-live="polite">
            {waitingLabel && (
              <button
                className="secondary leave-btn attention-btn"
                onClick={onShowAll}
                title="Show every secret, with the ones waiting on you marked"
              >
                {waitingLabel}
              </button>
            )}
          </span>
          {localSecretId && (
            // Back to the list. Nothing stops: every secret keeps running in the
            // background, which is what lets it answer its counterparties.
            <button
              className="secondary leave-btn"
              onClick={onShowAll}
              title="Show every secret in this browser. This one keeps running."
            >
              All secrets
            </button>
          )}
          <ThemeToggle />
          <NotificationBell entries={entries} currentLocalSecretId={secretPageShown ? localSecretId : null} onOpen={onOpenNotifications} />
          {entries.length > 0 && (
            <SecretSwitcher entries={entries} currentId={localSecretId} onSelect={onSwitch} />
          )}
          {secretPageShown && (
            <button
              className="secondary leave-btn"
              onClick={onLeave}
              title="Stop running this secret here, or remove it from this browser"
            >
              Leave
            </button>
          )}
          <button
            className="secondary reset-btn"
            onClick={onReset}
            title="Erase all DeRec data stored in this browser and start fresh"
          >
            Reset browser data
          </button>
        </>
      )}
    </header>
  )
}
