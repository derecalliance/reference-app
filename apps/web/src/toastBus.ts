import { randomId } from './randomId'

// Framework-agnostic toast/error bus.
//
// `reportError` can be called from anywhere — React components, async poll
// loops, plain modules, or `catch` blocks wrapping WASM calls. It ALWAYS
// writes a full-detail `console.error`, and emits a short user-facing toast.
// The `ToastProvider` subscribes and renders; if no provider is mounted the
// console.error still happens (never a silent failure).

export type ToastLevel = 'error' | 'info'

export interface Toast {
  id: string
  level: ToastLevel
  /** Short, user-facing text. Full detail goes to console.error. */
  message: string
}

type Listener = (toast: Toast) => void

const listeners = new Set<Listener>()

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emit(level: ToastLevel, message: string): void {
  const toast: Toast = { id: randomId(), level, message }
  for (const l of listeners) l(toast)
}

/** Best-effort readable string from any thrown value, including WASM error shapes. */
export function normalizeError(err: unknown): string {
  if (err == null) return 'Unknown error'
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>
    // WASM bridge errors: { code: 'WASM_SERIALIZE_ERROR', message: '...' }
    if (typeof o.message === 'string') {
      return typeof o.code === 'string' ? `${o.code}: ${o.message}` : o.message
    }
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

function truncate(s: string, max = 140): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * Report a failure: verbose `console.error` (always) + a short error toast.
 *
 * @param summary  Short human description of what failed (e.g. "Failed to
 *                 process incoming message").
 * @param err      The caught value (Error, WASM `{code,message}`, string, …).
 * @param context  Extra structured data for the console only.
 */
export function reportError(
  summary: string,
  err?: unknown,
  context?: Record<string, unknown>,
): void {
  const detail = err === undefined ? '' : normalizeError(err)
  console.error(
    `[derec] ${summary}${detail ? ` — ${detail}` : ''}`,
    { error: err, ...(context ?? {}) },
  )
  emit('error', detail ? `${summary}: ${truncate(detail)}` : summary)
}

/** Optional: a non-error, informational toast. */
export function reportInfo(message: string): void {
  emit('info', message)
}
