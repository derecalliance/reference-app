// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'

import type { SecretNotification } from '../types'
import { unreadCount } from '../secret/notifications'

type NotificationFilter = 'all' | 'unread' | 'critical'

interface NotificationsPanelProps {
  notifications: readonly SecretNotification[]
  /** Mark `ids` — or every notification — read. */
  onMarkRead: (ids: readonly string[] | 'all') => void
  /** Open the tab a notification is about. */
  onOpenLink: (link: NonNullable<SecretNotification['link']>) => void
}

const FILTERS: readonly { id: NotificationFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'critical', label: 'Critical' },
]

const LINK_LABELS: Record<NonNullable<SecretNotification['link']>, string> = {
  secrets: 'Items',
}

/**
 * Everything this secret told the owner, newest first. A critical one stays
 * flagged on the header bell until it is marked read here or opened from the
 * bell; dismissing its toast does not count.
 */
export function NotificationsPanel({ notifications, onMarkRead, onOpenLink }: NotificationsPanelProps) {
  const [filter, setFilter] = useState<NotificationFilter>('all')
  const unread = unreadCount(notifications)
  const shown = notifications.filter(n =>
    filter === 'unread' ? !n.read : filter === 'critical' ? n.severity === 'critical' : true,
  )

  if (notifications.length === 0) {
    return (
      <div className="tab-empty-state">
        <p>No notifications yet. Automatic verification and failed proofs are recorded here.</p>
      </div>
    )
  }

  return (
    <div className="card-list">
      <div className="detail-card">
        <div className="card-header">
          <span className="card-title">Notifications</span>
          <span className="empty-hint">
            {unread.total === 0 ? 'All read' : `${unread.total} unread${unread.critical > 0 ? `, ${unread.critical} critical` : ''}`}
          </span>
        </div>
        <div className="card-body">
          <div className="copies-toolbar">
            <div className="notification-filters" role="group" aria-label="Show">
              {FILTERS.map(f => (
                <button
                  key={f.id}
                  type="button"
                  className={`secondary small${filter === f.id ? ' notification-filter--active' : ''}`}
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="secondary small"
              onClick={() => onMarkRead('all')}
              disabled={unread.total === 0}
            >
              Mark all read
            </button>
          </div>

          {shown.length === 0 ? (
            <p className="empty-hint">Nothing to show for this filter.</p>
          ) : (
            <div className="versions-table-wrap">
              <table className="versions-table notifications-table">
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Notification</th>
                    <th scope="col" className="versions-table__actions-th" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map(({ link, ...n }) => (
                    <tr
                      key={n.id}
                      className={`versions-table__row${n.read ? '' : ' notification-row--unread'}`}
                    >
                      <td title={new Date(n.at).toLocaleString()}>{formatTime(n.at)}</td>
                      <td>
                        <span className={`notification-severity notification-severity--${n.severity}`}>
                          {n.severity === 'critical' ? 'Critical' : 'Info'}
                        </span>
                      </td>
                      <td className="notifications-table__message">
                        <span className="notifications-table__title">{n.title}</span>
                        {n.detail && <span className="notifications-table__detail">{n.detail}</span>}
                      </td>
                      <td className="versions-table__actions">
                        {link && (
                          <button
                            type="button"
                            className="secondary small"
                            onClick={() => {
                              onMarkRead([n.id])
                              onOpenLink(link)
                            }}
                          >
                            Open {LINK_LABELS[link]}
                          </button>
                        )}
                        {!n.read && (
                          <button type="button" className="secondary small" onClick={() => onMarkRead([n.id])}>
                            Mark read
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Today's as a time, older ones with their date. */
function formatTime(at: number): string {
  const date = new Date(at)
  const today = new Date().toDateString() === date.toDateString()
  return today
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
