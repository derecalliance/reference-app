// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'

import { errorText } from '../errorText'
import type { PairedParticipant, PublishedRound, Item } from '../types'
import type { PublishChoice, PublishContext } from '../secret/types'
import { ModalFrame } from '../ModalFrame'
import { PublishOptionsPanel } from './PublishOptionsPanel'
import { usePublishOptions } from './usePublishOptions'
import { ModalCloseButton } from './primitives'
import { ProtectRoundProgress } from './ProtectRoundProgress'
import { roundProgress } from './roundProgress'

type RemoveItemStatus =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'confirming'; participantIds: string[]; version: number; threshold: number }
  | { kind: 'error'; message: string }

interface RemoveItemModalProps {
  item: Item
  participants: PairedParticipant[]
  /** Channels the library holds `Pending`, which a round sends nothing — see `publishTargets`. */
  pendingChannelIds: ReadonlySet<string>
  /** What this publish starts from: defaults, committed versions, retention preview. */
  publishContext: PublishContext
  onClose: () => void
  /** Publishes the bag without `itemId`; the round it dispatched, or `null` if nothing was. */
  onRemoveItem: (itemId: string, choice: PublishChoice) => Promise<PublishedRound | null>
}

/**
 * Confirm removing one item, then follow the round that publishes the bag
 * without it.
 *
 * Says plainly that earlier versions keep the item: removal publishes a new
 * version, it does not reach back into shares helpers already hold.
 */
export function RemoveItemModal({
  item,
  participants,
  pendingChannelIds,
  publishContext,
  onClose,
  onRemoveItem,
}: RemoveItemModalProps) {
  const [status, setStatus] = useState<RemoveItemStatus>({ kind: 'idle' })
  const options = usePublishOptions(participants, pendingChannelIds, publishContext)
  const retention = publishContext.policy.helperRetention

  async function handleRemove() {
    if (!options.choice) return
    setStatus({ kind: 'sending' })
    try {
      const round = await onRemoveItem(item.id, options.choice)
      if (round === null) {
        setStatus({ kind: 'error', message: 'The round was not dispatched — the protocol sent no share requests. Check that enough participants are paired and online.' })
        return
      }
      // Who the round was sent to, as the round reports it — see `PublishedRound`.
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

  const progress =
    status.kind === 'confirming' ? roundProgress(participants, status.participantIds, status.version) : null
  const isBlocking = status.kind === 'sending' || (progress !== null && !progress.allResolved)

  return (
    <ModalFrame
      overlayClassName="modal-overlay"
      className="modal"
      label="Remove item"
      onEscape={isBlocking ? undefined : onClose}
    >
      <div className="modal-header">
        <h2 className="modal-title">Remove Item</h2>
        {!isBlocking && <ModalCloseButton onClose={onClose} />}
      </div>

      {progress && status.kind === 'confirming' ? (
        <ProtectRoundProgress
          progress={progress}
          threshold={status.threshold}
          version={status.version}
          failureHeading="Removing the item failed."
          onClose={onClose}
        />
      ) : (
        <div className="modal-body">
          <p className="modal-description">
            Remove <strong>{item.name}</strong> from the item bag? This publishes a new
            version without it to every paired participant.
          </p>
          <p className="modal-description">
            Earlier versions still contain it, and recovering one that helpers still keep brings it
            back.{' '}
            {retention.mode === 'latestCommitted'
              ? 'Helpers keep the newest committed version beside this one, so it is gone from them once one newer version has committed.'
              : 'Pick “None” below to have helpers drop every earlier version now.'}
          </p>

          <PublishOptionsPanel
            helpers={options.helpers}
            policy={publishContext.policy}
            committedVersions={publishContext.committedVersions}
            openVersions={publishContext.openVersions}
            preview={publishContext.preview}
            draft={options.draft}
            onChange={options.setDraft}
            disabled={status.kind === 'sending'}
          />

          {status.kind === 'error' && <p className="field-error">{status.message}</p>}

          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={status.kind === 'sending'}>
              Cancel
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => void handleRemove()}
              disabled={status.kind === 'sending' || options.choice === null}
            >
              {status.kind === 'sending' ? 'Sending…' : 'Remove Item'}
            </button>
          </div>
        </div>
      )}
    </ModalFrame>
  )
}
