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
}

/**
 * Small, reusable info hint. Renders a circular icon trigger; the body appears
 * on hover or keyboard focus. The body is always present in the DOM (visible
 * to assistive tech via `aria-describedby` + `role="tooltip"`), but visually
 * hidden until the user shows interest.
 *
 * Pure-CSS show/hide — no portal, no JS state, no extra layout cost.
 */
export function InfoTooltip({
  children,
  label = 'More information',
  variant = 'question',
  placement = 'top',
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
      >
        <span aria-hidden="true">{glyph}</span>
      </button>
      <span
        id={id}
        role="tooltip"
        className={`info-tooltip-content info-tooltip-content--${placement}`}
      >
        {children}
      </span>
    </span>
  )
}

export default InfoTooltip
