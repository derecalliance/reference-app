// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'

import { errorText } from '../errorText'
import { ModalFrame } from '../ModalFrame'
import type { BagVersion } from '../types'
import { ModalCloseButton } from './primitives'

type RemoveVersionStatus = { kind: 'idle' } | { kind: 'removing' } | { kind: 'error'; message: string }

interface RemoveVersionModalProps {
  version: BagVersion
  /** Remove the version and its verification copies from this device. */
  onRemove: (version: number) => Promise<void>
  onClose: () => void
}

/**
 * Confirm removing an earlier version from this device. Says plainly what it
 * does not do: nothing is sent, so helpers keep their shares and the version
 * can still be recovered from them.
 */
export function RemoveVersionModal({ version, onRemove, onClose }: RemoveVersionModalProps) {
  const [status, setStatus] = useState<RemoveVersionStatus>({ kind: 'idle' })
  const removing = status.kind === 'removing'

  async function handleRemove() {
    setStatus({ kind: 'removing' })
    try {
      await onRemove(version.version)
      onClose()
    } catch (err) {
      setStatus({ kind: 'error', message: errorText(err) })
    }
  }

  return (
    <ModalFrame
      overlayClassName="modal-overlay"
      className="modal"
      label={`Remove v${version.version}`}
      onEscape={removing ? undefined : onClose}
    >
      <div className="modal-header">
        <h2 className="modal-title">Remove v{version.version}</h2>
        {!removing && <ModalCloseButton onClose={onClose} />}
      </div>
      <div className="modal-body">
        <p className="modal-description">
          Remove <strong>v{version.version}</strong> from this device? Its record — the{' '}
          {version.items.length} item{version.items.length === 1 ? '' : 's'} it holds and who
          stored it — and this device’s verification copies for it are deleted, so it can no longer
          be viewed or verified here.
        </p>
        <p className="modal-description">
          Nothing is sent: helpers that keep v{version.version} still hold their shares, and it can
          still be recovered from them.
        </p>

        {status.kind === 'error' && <p className="field-error">{status.message}</p>}

        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={removing}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={() => void handleRemove()} disabled={removing}>
            {removing ? 'Removing…' : `Remove v${version.version}`}
          </button>
        </div>
      </div>
    </ModalFrame>
  )
}
