// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'
import { buildSecretContainerPayload, hexDump } from './bag'
import { ModalFrame } from '../ModalFrame'
import { ModalCloseButton } from './primitives'
import type { BagVersion } from '../types'

export function BagPayloadModal({
  version,
  onClose,
}: {
  version: BagVersion
  onClose: () => void
}) {
  const [activeTab, setActiveTab] = useState<'structured' | 'raw'>('structured')
  // Hidden until asked for, exactly like the Secrets table: the raw bytes are
  // the same values in another encoding, so they follow the same toggle.
  const [revealed, setRevealed] = useState(false)

  const payload = buildSecretContainerPayload(version, { maskSecrets: !revealed })
  const jsonString = JSON.stringify(payload, null, 2)
  const jsonBytes = new TextEncoder().encode(jsonString)
  const dump = hexDump(jsonBytes)

  return (
    <ModalFrame
      overlayClassName="modal-overlay"
      className="modal payload-modal"
      labelledBy="payload-modal-title"
      onEscape={onClose}
    >
      <div className="modal-header">
        <h2 className="modal-title" id="payload-modal-title">
          Secret Bag Payload — v{version.version}
        </h2>
        <ModalCloseButton onClose={onClose} />
      </div>
      <div className="modal-body">
        <div className="payload-tabs">
          <button
            type="button"
            className={`payload-tab ${activeTab === 'structured' ? 'payload-tab--active' : ''}`}
            onClick={() => setActiveTab('structured')}
          >
            Structured
          </button>
          <button
            type="button"
            className={`payload-tab ${activeTab === 'raw' ? 'payload-tab--active' : ''}`}
            onClick={() => setActiveTab('raw')}
          >
            Raw Bytes ({jsonBytes.length} B)
          </button>
        </div>
        <div className="payload-reveal-row">
          <span className="payload-note">
            {revealed
              ? 'Secret values are shown in clear text.'
              : 'Secret values are masked, as in the Secrets table — the byte count is of what is shown.'}
          </span>
          <button
            type="button"
            className="secondary small"
            onClick={() => setRevealed(v => !v)}
            aria-pressed={revealed}
          >
            {revealed ? 'Hide values' : 'Reveal values'}
          </button>
        </div>

        {activeTab === 'structured' ? (
          <pre className="payload-pre">{jsonString}</pre>
        ) : (
          <pre className="payload-pre payload-pre--hex">{dump.join('\n')}</pre>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="primary" onClick={onClose}>Close</button>
      </div>
    </ModalFrame>
  )
}
