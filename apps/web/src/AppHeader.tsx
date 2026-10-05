// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import { Badge, Box, IconButton, Menu, MenuItem, useMediaQuery, useTheme } from '@mui/material'

import type { VaultEntry } from './vault/manager'
import { VaultSwitcher } from './VaultSwitcher'

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
  entries: readonly VaultEntry[]
  /** The vault the route names, or `null` on the list and the wizard. */
  vaultId: string | null
  /** Whether that vault's own page is showing — what Leave acts on. */
  vaultPageShown: boolean
  /** Other vaults with a decision waiting; `0` hides the notice. */
  othersWaiting: number
  onShowAll: () => void
  onSwitch: (id: string) => void
  onLeave: () => void
  onReset: () => void
}

/** "1 other vault needs your decision" / "2 other vaults need your decision". */
function othersWaitingLabel(count: number): string {
  return count === 1
    ? '1 other vault needs your decision'
    : `${count} other vaults need your decision`
}

/**
 * The page header: logo, the vault switcher, and the app-wide actions.
 *
 * Below `md` the actions fold into a menu. Laid out in one row they need about
 * 700px — the switcher alone may take 260 — and on a phone they ran off the
 * right edge of the page rather than wrapping. The switcher stays out of the
 * menu because getting to another vault is what the header is for.
 */
export function AppHeader({
  entries,
  vaultId,
  vaultPageShown,
  othersWaiting,
  onShowAll,
  onSwitch,
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
          {entries.length > 0 && (
            <VaultSwitcher entries={entries} currentId={vaultId} onSelect={onSwitch} />
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
            {vaultId && <MenuItem onClick={fromMenu(onShowAll)}>All vaults</MenuItem>}
            {vaultPageShown && <MenuItem onClick={fromMenu(onLeave)}>Leave</MenuItem>}
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
                title="Show every vault, with the ones waiting on you marked"
              >
                {waitingLabel}
              </button>
            )}
          </span>
          {vaultId && (
            // Back to the list. Nothing stops: every vault keeps running in the
            // background, which is what lets it answer its counterparties.
            <button
              className="secondary leave-btn"
              onClick={onShowAll}
              title="Show every vault in this browser. This one keeps running."
            >
              All vaults
            </button>
          )}
          {entries.length > 0 && (
            <VaultSwitcher entries={entries} currentId={vaultId} onSelect={onSwitch} />
          )}
          {vaultPageShown && (
            <button
              className="secondary leave-btn"
              onClick={onLeave}
              title="Stop running this vault here, or remove it from this browser"
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
