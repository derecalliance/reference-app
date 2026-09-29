import { useState } from 'react'

import { copyText } from '../clipboard'
import { EyeIcon, EyeOffIcon } from './icons'

/**
 * Small controls shared across the owner page's panels and modals.
 *
 * They style themselves from `OwnerPage.css`, which the owner page imports
 * once; nothing here imports it again, because a second import of the same
 * global stylesheet would only duplicate work.
 */

export function ClickToCopyCode({ label, value }: { label?: string; value: string }) {
  const [copied, setCopied] = useState(false)

  function handleClick() {
    void copyText(value).then(ok => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <span className="click-to-copy" onClick={handleClick} title="Click to copy" role="button" tabIndex={0}>
      {label && <span className="click-to-copy-label">{label}</span>}
      <code className="click-to-copy-value">{copied ? 'Copied!' : value}</code>
    </span>
  )
}

export function CopyButton({
  label,
  text,
  disabled,
}: {
  label: string
  text: string
  /** Set while `text` is known to be about to change, so nobody copies a value
   *  that is one render away from being superseded. */
  disabled?: boolean
}) {
  // `null` before any attempt; `false` after one that did not take. A button
  // that silently does nothing is worse than one that admits it failed — which
  // is exactly how this read on a LAN origin, where the clipboard API is absent.
  const [copied, setCopied] = useState<boolean | null>(null)

  function handleCopy() {
    void copyText(text).then(ok => {
      setCopied(ok)
      setTimeout(() => setCopied(null), ok ? 1500 : 4000)
    })
  }

  return (
    <button
      className="secondary copy-field-btn"
      onClick={handleCopy}
      disabled={disabled}
      title={copied === false ? 'This browser blocked the copy — select the text and copy it manually' : undefined}
    >
      {copied === true ? '✓ Copied' : copied === false ? 'Copy blocked' : `Copy ${label}`}
    </button>
  )
}

export function SharedKeyRow({ value, label }: { value: string; label?: boolean }) {
  const [visible, setVisible] = useState(false)
  const content = (
    <span className="shared-key-display">
      <code className="shared-key-value">{visible ? value : '••••••••••••'}</code>
      <button
        type="button"
        className="secondary reveal-btn"
        onClick={() => setVisible(v => !v)}
        aria-label={visible ? 'Hide shared key' : 'Reveal shared key'}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </span>
  )
  if (label === false) return content
  return (
    <div className="side-detail-row">
      <span className="side-detail-label">Shared Key</span>
      {content}
    </div>
  )
}

export function ModalCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button className="modal-close" onClick={onClose} aria-label="Close">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  )
}
