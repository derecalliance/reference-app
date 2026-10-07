// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useId, useState, type FormEvent } from 'react'

import { ModalFrame } from '../ModalFrame'
import {
  apiLinkRemoteHelperChannels,
  apiListRemoteHelperChannels,
  helperLocationOf,
  parseHelperMailbox,
  type HelperLocation,
} from '../remoteHelperLink'
import type { PairedParticipant } from '../types'
import { ModalCloseButton } from './primitives'
import { ProvisionedLinkModal } from './ProvisionedLinkModal'

export interface RemoteHelperLinkModalProps {
  /** Our channel with the helper — the one to link to its older channel. */
  channel: PairedParticipant
  onClose: () => void
}

/**
 * The operator "Link" step for a helper on another node.
 *
 * The node is read from the helper's mailbox URL. A channel whose endpoint is
 * not a mailbox — a gRPC-only helper — asks for the URL first; the helper's
 * own node shows it on its Share Contact.
 */
export function RemoteHelperLinkModal({ channel, onClose }: RemoteHelperLinkModalProps) {
  const [location, setLocation] = useState<HelperLocation | null>(() => helperLocationOf(channel))

  if (location) {
    return (
      <ProvisionedLinkModal
        participantName={channel.name}
        myChannelId={channel.channelId}
        loadChannels={() => apiListRemoteHelperChannels(location)}
        onLink={linkTo => apiLinkRemoteHelperChannels(location, channel.channelId, linkTo)}
        onClose={onClose}
      />
    )
  }
  return <HelperUrlForm name={channel.name} onLocate={setLocation} onClose={onClose} />
}

function HelperUrlForm({
  name,
  onLocate,
  onClose,
}: {
  name: string
  onLocate: (location: HelperLocation) => void
  onClose: () => void
}) {
  const inputId = useId()
  const [url, setUrl] = useState('')
  const parsed = parseHelperMailbox(url)
  const invalid = url.trim() !== '' && parsed === null

  function submit(e: FormEvent) {
    e.preventDefault()
    if (parsed) onLocate(parsed)
  }

  return (
    <ModalFrame
      overlayClassName="modal-overlay"
      className="modal modal--form"
      labelledBy={`${inputId}-title`}
      onEscape={onClose}
    >
      <div className="modal-header">
        <h2 className="modal-title" id={`${inputId}-title`}>
          Link on {name}
        </h2>
        <ModalCloseButton onClose={onClose} />
      </div>
      <form onSubmit={submit}>
        <div className="modal-body">
          <p className="modal-description">
            This channel does not say which node runs {name}. Paste the helper’s
            mailbox URL — its node shows it as the HTTPS address on Share Contact.
          </p>
          <div className="form-field">
            <label className="form-label" htmlFor={inputId}>
              Helper mailbox URL
            </label>
            <input
              id={inputId}
              className="form-input"
              type="url"
              placeholder="http://other-node:5000/derec/<actor id>"
              value={url}
              onChange={e => setUrl(e.target.value)}
              aria-invalid={invalid}
              autoFocus
            />
          </div>
          {invalid && (
            <p className="field-error">
              Not a helper mailbox. It looks like <code>http://host:port/derec/&lt;actor id&gt;</code>.
            </p>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={parsed === null}>
            Find its channels
          </button>
        </div>
      </form>
    </ModalFrame>
  )
}
