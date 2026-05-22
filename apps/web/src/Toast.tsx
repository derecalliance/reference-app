import { useEffect, useRef, useState, type ReactNode } from 'react'
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
        const dupe = prev.find(t => t.message === toast.message && t.level === toast.level)
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
            <span className="toast-message">
              {t.message}
              {t.count > 1 && <span className="toast-count"> ×{t.count}</span>}
            </span>
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
