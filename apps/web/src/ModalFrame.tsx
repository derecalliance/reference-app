// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useCallback, useEffect, useId, type KeyboardEvent, type ReactNode } from 'react'
import { Unstable_TrapFocus as FocusTrap } from '@mui/material'

/**
 * Open frames, innermost last. Only the top one holds focus: two traps
 * enforcing at once would pass focus back and forth between them forever.
 */
const openFrames: string[] = []

/**
 * Whether an MUI modal — a `Dialog`, a `Menu`, a `Select`'s list — is open.
 * Those portal to the body and trap focus themselves; while one is up, this
 * frame's trap stands down so focus can go to it (a closed drawer kept mounted
 * carries `MuiModal-hidden`).
 */
function muiModalOpen(): boolean {
  return document.querySelector('.MuiModal-root:not(.MuiModal-hidden)') !== null
}

export interface ModalFrameProps {
  /** The full-screen scrim's class — `modal-overlay`, `app-dialog-overlay`, … */
  overlayClassName: string
  /** The dialog panel's class — `modal`, `app-dialog`, … */
  className: string
  /** Id of the element naming the dialog. Give this or `label`. */
  labelledBy?: string
  /** The dialog's accessible name, when nothing on screen carries it. */
  label?: string
  /**
   * What Escape does. Leave it out while the dialog must stay open — an
   * operation in flight that closing would orphan — so Escape follows the same
   * rule as the dialog's own close button.
   */
  onEscape?: () => void
  /** What a click on the scrim itself (not the panel) does. Nothing, if left out. */
  onScrimClick?: () => void
  children: ReactNode
}

/**
 * The shared shell of the app's hand-styled modals: focus moves in, stays in,
 * and goes back where it came from; Escape closes when closing is allowed.
 *
 * These dialogs predate MUI in this app and are styled by their own CSS, so
 * rather than restyle each as an MUI `Dialog` this borrows the two behaviours
 * that matter from MUI — its focus trap, and the Escape convention — and keeps
 * the markup, and so the look, untouched. Without it, Tab walked straight out
 * of an open dialog into the page behind it.
 *
 * Not portalled, deliberately: the dialogs render where they always did, so
 * styles scoped to their parents still apply. `aria-modal` tells assistive
 * technology the rest of the page is inert while it is open.
 */
export function ModalFrame({
  overlayClassName,
  className,
  labelledBy,
  label,
  onEscape,
  onScrimClick,
  children,
}: ModalFrameProps) {
  const frameId = useId()
  useEffect(() => {
    openFrames.push(frameId)
    return () => {
      const at = openFrames.lastIndexOf(frameId)
      if (at !== -1) openFrames.splice(at, 1)
    }
  }, [frameId])
  const isEnabled = useCallback(
    () => openFrames[openFrames.length - 1] === frameId && !muiModalOpen(),
    [frameId],
  )

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape') return
    // React bubbles events out of portals along the component tree, so an
    // Escape inside an MUI dialog opened *from* this one arrives here too. That
    // one is its own to handle.
    if (!event.currentTarget.contains(event.target as Node)) return
    // Stopped either way: an outer dialog must not close because an inner one
    // refused to.
    event.stopPropagation()
    onEscape?.()
  }

  return (
    // `open` for as long as this is mounted: the dialogs mount when shown.
    // With nothing inside asking for focus (`autoFocus`), the panel itself
    // takes it — which is why it is focusable but out of the tab order.
    <FocusTrap open isEnabled={isEnabled}>
      <div
        className={overlayClassName}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onClick={event => {
          if (event.target === event.currentTarget) onScrimClick?.()
        }}
      >
        <div className={className}>{children}</div>
      </div>
    </FocusTrap>
  )
}
