// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'

import { errorText } from '../errorText'
import { ModalFrame } from '../ModalFrame'
import type { PairedParticipant, PublishedRound } from '../types'
import type { PublishChoice, PublishContext } from '../vault/types'
import { ModalCloseButton } from './primitives'
import { ProtectRoundProgress } from './ProtectRoundProgress'
import { PublishOptionsPanel } from './PublishOptionsPanel'
import { roundProgress } from './roundProgress'
import { usePublishOptions } from './usePublishOptions'

type RepublishStatus =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'confirming'; participantIds: string[]; version: number; threshold: number }
  | { kind: 'error'; message: string }

interface RepublishModalProps {
  participants: PairedParticipant[]
  /** Channels the library holds `Pending`, which a round sends nothing — see `publishTargets`. */
  pendingChannelIds: ReadonlySet<string>
  publishContext: PublishContext
  onClose: () => void
  /** Publish the current secrets again with `choice`. */
  onRepublish: (choice: PublishChoice) => Promise<PublishedRound | null>
}

/**
 * Publish the current secrets again as a new version — how changed default
 * weights, a different threshold, or a different set of kept versions take
 * effect without changing the secrets. The library records weights and the
 * threshold only as part of a round.
 */
export function RepublishModal({ participants, pendingChannelIds, publishContext, onClose, onRepublish }: RepublishModalProps) {
  const options = usePublishOptions(participants, pendingChannelIds, publishContext)
  const [status, setStatus] = useState<RepublishStatus>({ kind: 'idle' })
  const sending = status.kind === 'sending'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!options.choice) return
    setStatus({ kind: 'sending' })
    try {
      const round = await onRepublish(options.choice)
      if (round === null) {
        setStatus({
          kind: 'error',
          message: 'No round was started, so nothing changed. Check the Console for the reason, then try again.',
        })
        return
      }
      setStatus({
        kind: 'confirming',
        participantIds: round.recipientIds,
        version: round.version,
        threshold: round.threshold,
      })
    } catch (err) {
      setStatus({ kind: 'error', message: errorText(err) })
    }
  }

  const confirming = status.kind === 'confirming' ? status : null
  const progress = confirming ? roundProgress(participants, confirming.participantIds, confirming.version) : null
  const isBlocking = sending || (progress !== null && !progress.allResolved)

  return (
    <ModalFrame
      overlayClassName="modal-overlay"
      className="modal"
      label="Republish"
      onEscape={isBlocking ? undefined : onClose}
    >
      <div className="modal-header">
        <h2 className="modal-title">Republish</h2>
        {!isBlocking && <ModalCloseButton onClose={onClose} />}
      </div>

      {progress && confirming ? (
        <ProtectRoundProgress
          progress={progress}
          threshold={confirming.threshold}
          version={confirming.version}
          failureHeading="The new version was not published."
          onClose={onClose}
        />
      ) : (
        <form className="modal-body" onSubmit={handleSubmit}>
          <p className="modal-description">
            Publish the current secrets again as a new version, with the threshold, weights and kept
            versions below. The secrets themselves do not change.
          </p>

          <PublishOptionsPanel
            helpers={options.helpers}
            policy={publishContext.policy}
            committedVersions={publishContext.committedVersions}
            openVersions={publishContext.openVersions}
            preview={publishContext.preview}
            draft={options.draft}
            onChange={options.setDraft}
            disabled={sending}
          />

          {status.kind === 'error' && <p className="field-error">{status.message}</p>}

          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={sending}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={sending || options.choice === null || options.helpers.length === 0}
            >
              {sending ? 'Publishing…' : 'Republish'}
            </button>
          </div>
        </form>
      )}
    </ModalFrame>
  )
}
