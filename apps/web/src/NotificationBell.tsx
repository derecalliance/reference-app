// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive'
import NotificationsNoneIcon from '@mui/icons-material/NotificationsNone'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import { Badge, Box, Divider, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Typography } from '@mui/material'
import { keyframes } from '@mui/material/styles'

import type { SecretNotification } from './types'
import type { SecretEntry } from './secret/manager'
import { unreadCount } from './secret/notifications'

/** How many notifications the dropdown lists; the rest are on each secret's tab. */
const MENU_SIZE = 8

/** A short swing every few seconds, then still — enough to catch the eye, not to nag. */
const ring = keyframes`
  0%, 80%, 100% { transform: rotate(0deg); }
  84% { transform: rotate(14deg); }
  88% { transform: rotate(-12deg); }
  92% { transform: rotate(8deg); }
  96% { transform: rotate(-4deg); }
`

interface NotificationBellProps {
  entries: readonly SecretEntry[]
  /** Open a secret's Notifications tab, marking `notificationId` read when one was picked. */
  onOpen: (localSecretId: string, notificationId: string | null) => void
  /** The secret on screen, whose tab "View all" opens; `null` hides it. */
  currentLocalSecretId: string | null
}

interface BellItem {
  localSecretId: string
  secretName: string
  notification: SecretNotification
}

/**
 * Every secret's notifications behind one bell. An unread critical one —
 * a failed verification — turns the badge red and rings the bell until it is
 * read; with reduced motion the badge alone says it.
 */
export function NotificationBell({ entries, onOpen, currentLocalSecretId }: NotificationBellProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)

  const totals = entries.reduce(
    (sum, e) => {
      const unread = unreadCount(e.notifications)
      return { total: sum.total + unread.total, critical: sum.critical + unread.critical }
    },
    { total: 0, critical: 0 },
  )
  const items: BellItem[] = entries
    .flatMap(e => e.notifications.map(notification => ({ localSecretId: e.id, secretName: e.name, notification })))
    .sort((a, b) => b.notification.at - a.notification.at)
    .slice(0, MENU_SIZE)
  const alarming = totals.critical > 0
  const label =
    totals.total === 0
      ? 'Notifications'
      : `Notifications — ${totals.total} unread${alarming ? `, ${totals.critical} critical` : ''}`

  const pick = (localSecretId: string, notificationId: string | null) => {
    setAnchor(null)
    onOpen(localSecretId, notificationId)
  }

  return (
    <>
      <IconButton
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={event => setAnchor(event.currentTarget)}
        sx={
          alarming
            ? {
                color: 'error.main',
                '& svg': { animation: `${ring} 3s ease-in-out infinite`, transformOrigin: '50% 10%' },
                '@media (prefers-reduced-motion: reduce)': { '& svg': { animation: 'none' } },
              }
            : undefined
        }
      >
        <Badge
          color={alarming ? 'error' : 'default'}
          badgeContent={totals.total}
          invisible={totals.total === 0}
          max={99}
          sx={alarming ? undefined : { '& .MuiBadge-badge': { bgcolor: 'action.selected' } }}
        >
          {alarming ? <NotificationsActiveIcon /> : <NotificationsNoneIcon />}
        </Badge>
      </IconButton>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 380, maxWidth: 'calc(100vw - 32px)' } } }}
      >
        {items.length === 0 ? (
          <MenuItem disabled>
            <ListItemText primary="No notifications yet" />
          </MenuItem>
        ) : (
          items.map(({ localSecretId, secretName, notification: n }) => (
            <MenuItem
              key={n.id}
              onClick={() => pick(localSecretId, n.id)}
              sx={{ alignItems: 'flex-start', whiteSpace: 'normal', opacity: n.read ? 0.7 : 1 }}
            >
              <ListItemIcon sx={{ mt: 0.25 }}>
                {n.severity === 'critical' ? (
                  <ErrorOutlineIcon fontSize="small" color="error" />
                ) : (
                  <InfoOutlinedIcon fontSize="small" color="action" />
                )}
              </ListItemIcon>
              <ListItemText
                primary={
                  <Box component="span" sx={{ fontWeight: n.read ? 400 : 600 }}>
                    {n.title}
                  </Box>
                }
                secondary={
                  <Typography component="span" variant="caption" color="text.secondary">
                    {secretName} · {new Date(n.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    {n.read ? '' : ' · unread'}
                  </Typography>
                }
              />
            </MenuItem>
          ))
        )}
        {currentLocalSecretId && <Divider />}
        {currentLocalSecretId && (
          <MenuItem onClick={() => pick(currentLocalSecretId, null)}>
            <ListItemText primary="View all for this secret" sx={{ textAlign: 'center' }} />
          </MenuItem>
        )}
      </Menu>
    </>
  )
}
