// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useId, type ReactNode } from 'react'
import './InfoTooltip.css'

interface InfoTooltipProps {
  /** Tooltip body content. */
  children: ReactNode
  /** Accessible label for the trigger button. */
  label?: string
  /** Visual variant: question mark (default) or info bang. */
  variant?: 'question' | 'info'
  /** Where the popup appears relative to the trigger. */
  placement?: 'top' | 'bottom'
  /**
   * How the popup lines up with the trigger: centred on it, or starting at it
   * and opening to the right — for a trigger near the left edge of a scrolling
   * area, where a centred popup would be cut off.
   */
  align?: 'center' | 'start'
}

/**
 * Small, reusable info hint. Renders a circular icon trigger; the body appears
 * on hover, on click, or on keyboard focus. The body is always present in the DOM (visible
 * to assistive tech via `aria-describedby` + `role="tooltip"`), but visually
 * hidden until the user shows interest.
 *
 * Pure-CSS show/hide — no portal, no JS state, no extra layout cost. A click
 * shows it by focusing the trigger, which Safari does not do on its own.
 */
export function InfoTooltip({
  children,
  label = 'More information',
  variant = 'question',
  placement = 'top',
  align = 'center',
}: InfoTooltipProps) {
  const id = useId()
  const glyph = variant === 'info' ? 'i' : '?'

  return (
    <span className="info-tooltip">
      <button
        type="button"
        className="info-tooltip-trigger"
        aria-label={label}
        aria-describedby={id}
        onClick={e => e.currentTarget.focus()}
      >
        <span aria-hidden="true">{glyph}</span>
      </button>
      <span
        id={id}
        role="tooltip"
        className={`info-tooltip-content info-tooltip-content--${placement} info-tooltip-content--align-${align}`}
      >
        {children}
      </span>
    </span>
  )
}

export default InfoTooltip
