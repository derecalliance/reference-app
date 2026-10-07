// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { randomId } from './randomId'

// Framework-agnostic toast/error bus.
//
// `reportError` can be called from anywhere — React components, async poll
// loops, plain modules, or `catch` blocks wrapping WASM calls. It ALWAYS
// writes a full-detail `console.error`, and emits a short user-facing toast.
// The `ToastProvider` subscribes and renders; if no provider is mounted the
// console.error still happens (never a silent failure).

export type ToastLevel = 'error' | 'info'

/** The vault a toast is about, when that vault is not the one on screen. */
export interface ToastOrigin {
  vaultId: string
  vaultName: string
}

export interface Toast {
  id: string
  level: ToastLevel
  /** Short, user-facing text. Full detail goes to console.error. */
  message: string
  /** Set for a vault off screen: the toast names it and clicking it opens it. */
  origin?: ToastOrigin
}

type Listener = (toast: Toast) => void

const listeners = new Set<Listener>()

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emit(level: ToastLevel, message: string, origin?: ToastOrigin): void {
  const toast: Toast = { id: randomId(), level, message, origin }
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
 * @param origin   The vault it came from, when that vault is off screen.
 */
export function reportError(
  summary: string,
  err?: unknown,
  context?: Record<string, unknown>,
  origin?: ToastOrigin,
): void {
  const detail = err === undefined ? '' : normalizeError(err)
  console.error(
    `[derec] ${summary}${detail ? ` — ${detail}` : ''}`,
    { error: err, ...(context ?? {}), ...(origin ? { vaultId: origin.vaultId } : {}) },
  )
  emit('error', detail ? `${summary}: ${truncate(detail)}` : summary, origin)
}

/** A non-error, informational toast — a banner, when it carries an origin. */
export function reportInfo(message: string, origin?: ToastOrigin): void {
  emit('info', message, origin)
}

// ── Standing notices ─────────────────────────────────────────────────────────
//
// A condition rather than an event: shown for as long as it holds and cleared
// when it ends, not on a timer. One per key, so a condition reported by many
// sources at once — the node down, seen by every vault's poll — is one notice.

export interface Notice {
  key: string
  level: ToastLevel
  message: string
}

type NoticeListener = (notices: readonly Notice[]) => void

let notices: readonly Notice[] = []
const noticeListeners = new Set<NoticeListener>()

function publishNotices(next: readonly Notice[]): void {
  notices = next
  for (const l of noticeListeners) l(notices)
}

/** Called at once with the current notices, then on every change. */
export function subscribeNotices(listener: NoticeListener): () => void {
  noticeListeners.add(listener)
  listener(notices)
  return () => {
    noticeListeners.delete(listener)
  }
}

/** Show the notice `key`, replacing any shown under the same key. */
export function showNotice(key: string, level: ToastLevel, message: string): void {
  const current = notices.find(n => n.key === key)
  if (current && current.level === level && current.message === message) return
  publishNotices([...notices.filter(n => n.key !== key), { key, level, message }])
}

/** Take the notice `key` down. A no-op when none is shown. */
export function clearNotice(key: string): void {
  if (!notices.some(n => n.key === key)) return
  publishNotices(notices.filter(n => n.key !== key))
}
