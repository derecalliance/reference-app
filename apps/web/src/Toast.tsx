// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { navigate } from './routing'
import { subscribeToasts, type Toast } from './toastBus'
import './Toast.css'

const AUTO_DISMISS_MS = 7000
const MAX_VISIBLE = 4

interface VisibleToast extends Toast {
  /** How many identical messages collapsed into this one. */
  count: number
}

/**
 * Subscribes to the global toast bus and renders a small notification stack.
 * Identical messages are de-duplicated (count badge) so repeated failures
 * (e.g. a flapping mailbox poll) don't spam the UI.
 *
 * A toast with an origin is a banner for a vault not on screen: it names the
 * vault and is a button that opens it.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<VisibleToast[]>([])
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const arm = (id: string) => {
      const existing = timers.current.get(id)
      if (existing) clearTimeout(existing)
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id)
          setToasts(prev => prev.filter(t => t.id !== id))
        }, AUTO_DISMISS_MS),
      )
    }

    const unsub = subscribeToasts(toast => {
      setToasts(prev => {
        const dupe = prev.find(
          t =>
            t.message === toast.message &&
            t.level === toast.level &&
            t.origin?.vaultId === toast.origin?.vaultId,
        )
        if (dupe) {
          arm(dupe.id)
          return prev.map(t => (t.id === dupe.id ? { ...t, count: t.count + 1 } : t))
        }
        arm(toast.id)
        const next = [...prev, { ...toast, count: 1 }]
        return next.length > MAX_VISIBLE ? next.slice(next.length - MAX_VISIBLE) : next
      })
    })

    const pending = timers.current
    return () => {
      unsub()
      for (const t of pending.values()) clearTimeout(t)
      pending.clear()
    }
  }, [])

  function open(toast: VisibleToast) {
    if (!toast.origin) return
    navigate({ kind: 'vault', id: toast.origin.vaultId })
    dismiss(toast.id)
  }

  function dismiss(id: string) {
    const t = timers.current.get(id)
    if (t) {
      clearTimeout(t)
      timers.current.delete(id)
    }
    setToasts(prev => prev.filter(x => x.id !== id))
  }

  return (
    <>
      {children}
      <div className="toast-viewport" role="region" aria-label="Notifications">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`toast toast--${t.level}`}
            role={t.level === 'error' ? 'alert' : 'status'}
          >
            {t.origin ? (
              <button
                type="button"
                className="toast-message toast-link"
                title={`Open ${t.origin.vaultName}`}
                onClick={() => open(t)}
              >
                <ToastText toast={t} />
              </button>
            ) : (
              <span className="toast-message">
                <ToastText toast={t} />
              </span>
            )}
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </>
  )
}

function ToastText({ toast }: { toast: VisibleToast }) {
  return (
    <>
      {toast.origin && <strong>{toast.origin.vaultName}: </strong>}
      {toast.message}
      {toast.count > 1 && <span className="toast-count"> ×{toast.count}</span>}
    </>
  )
}
