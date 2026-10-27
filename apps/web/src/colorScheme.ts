// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useSyncExternalStore } from 'react'

/**
 * Which colour scheme the app is drawn in.
 *
 * `index.css` holds both palettes — dark on `:root`, light on
 * `:root[data-theme='light']` — and this module decides which applies by
 * setting `data-theme` on `<html>`. Until the viewer picks one with the header
 * toggle the scheme follows the system's, and keeps following it as it
 * changes; a pick is stored per browser and wins from then on.
 *
 * The attribute is first set by an inline script in `index.html`, before the
 * stylesheet paints, so a light page does not flash dark while the bundle
 * loads. That script repeats `STORAGE_KEY` and the resolution below and must be
 * kept in step with them.
 *
 * Module state rather than React context: `AppMuiTheme` is mounted at the root
 * and again around several dialogs, and every instance has to agree.
 */
export type ColorScheme = 'light' | 'dark'

const STORAGE_KEY = 'derec.theme'
const LIGHT_QUERY = '(prefers-color-scheme: light)'

function isColorScheme(value: string | null): value is ColorScheme {
  return value === 'light' || value === 'dark'
}

function loadStoredScheme(): ColorScheme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isColorScheme(stored) ? stored : null
  } catch {
    // Storage can be unavailable entirely; the system scheme still applies.
    return null
  }
}

/** The media query, or `null` where there is none (jsdom, very old browsers). */
function lightQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(LIGHT_QUERY) : null
}

/** Dark unless the system asks for light: "no preference" is dark, as in `index.css`. */
function systemScheme(): ColorScheme {
  return lightQuery()?.matches ? 'light' : 'dark'
}

let chosen: ColorScheme | null = loadStoredScheme()
const listeners = new Set<() => void>()

function currentScheme(): ColorScheme {
  return chosen ?? systemScheme()
}

/** Point the stylesheet at the current scheme, then tell every subscriber. */
function applyAndNotify(): void {
  document.documentElement.dataset.theme = currentScheme()
  for (const listener of listeners) listener()
}

/**
 * Watch the two things that can change the scheme from outside this page — the
 * system setting, and a pick made in another tab (or cleared by a reset there).
 * Returns the function that stops watching.
 */
function watchExternalChanges(): () => void {
  const query = lightQuery()
  const onSystemChange = () => {
    if (chosen === null) applyAndNotify()
  }
  const onStorage = (event: StorageEvent) => {
    // `key` is null when another tab cleared storage outright.
    if (event.key !== STORAGE_KEY && event.key !== null) return
    chosen = loadStoredScheme()
    applyAndNotify()
  }
  query?.addEventListener('change', onSystemChange)
  window.addEventListener('storage', onStorage)
  return () => {
    query?.removeEventListener('change', onSystemChange)
    window.removeEventListener('storage', onStorage)
  }
}

let stopWatching: (() => void) | null = null

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  stopWatching ??= watchExternalChanges()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopWatching?.()
      stopWatching = null
    }
  }
}

/** Pick a scheme for this browser, overriding the system's from now on. */
export function setColorScheme(scheme: ColorScheme): void {
  chosen = scheme
  try {
    localStorage.setItem(STORAGE_KEY, scheme)
  } catch {
    // Safari in private mode throws here. The pick still holds for this page.
  }
  applyAndNotify()
}

/** The scheme the app is drawn in right now, re-rendering when it changes. */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, currentScheme, () => 'dark')
}
