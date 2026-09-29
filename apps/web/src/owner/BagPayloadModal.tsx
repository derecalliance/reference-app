import { useState } from 'react'
import { buildSecretContainerPayload, hexDump } from './bag'
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

  const payload = buildSecretContainerPayload(version)
  const jsonString = JSON.stringify(payload, null, 2)
  const jsonBytes = new TextEncoder().encode(jsonString)
  const dump = hexDump(jsonBytes)

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="payload-modal-title">
      <div className="modal payload-modal">
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

          {activeTab === 'structured' ? (
            <pre className="payload-pre">{jsonString}</pre>
          ) : (
            <pre className="payload-pre payload-pre--hex">{dump.join('\n')}</pre>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
