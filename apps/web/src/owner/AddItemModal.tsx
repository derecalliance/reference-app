// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { ItemDataField } from './VerifySharesModal'
import { useState } from 'react'
import { errorText } from '../errorText'
import { ModalFrame } from '../ModalFrame'
import { ModalCloseButton } from './primitives'
import { ProtectRoundProgress } from './ProtectRoundProgress'
import { roundProgress } from './roundProgress'
import { bagBytes, bagSizeProblem, formatBytes, MAX_BAG_SIZE_LABEL } from './secretLimits'
import type { PairedParticipant, PublishedRound, ItemBag } from '../types'
import type { PublishChoice, PublishContext } from '../secret/types'
import { PublishOptionsPanel } from './PublishOptionsPanel'
import { usePublishOptions } from './usePublishOptions'

type AddItemStatus =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'confirming'; participantIds: string[]; version: number; threshold: number }
  | { kind: 'error'; message: string }

export function AddItemModal({
  participants,
  pendingChannelIds,
  itemBag,
  publishContext,
  onClose,
  onAddItem,
}: {
  participants: PairedParticipant[]
  /** Channels the library holds `Pending`, which a round sends nothing — see `publishTargets`. */
  pendingChannelIds: ReadonlySet<string>
  itemBag: ItemBag | null
  /** What this publish starts from: defaults, committed versions, retention preview. */
  publishContext: PublishContext
  onClose: () => void
  onAddItem: (name: string, data: string, choice: PublishChoice) => Promise<PublishedRound | null>
}) {
  // Exactly the participants the round will target: owner-role channels the
  // library does not hold `Pending` — see `publishTargets`. A helper whose
  // fingerprint was refused is sent nothing, so listing it here promised a
  // share the round never sends.
  const options = usePublishOptions(participants, pendingChannelIds, publishContext)

  const [form, setForm] = useState({ name: '', data: '' })
  const [status, setStatus] = useState<AddItemStatus>({ kind: 'idle' })

  // Checked here for immediate feedback, and again by the engine before it
  // dispatches anything: the shares carry the whole bag, so the limit is on
  // what the bag would hold with this item in it.
  const existingItems = itemBag?.currentVersion.items ?? []
  const draft = { name: form.name.trim(), data: form.data.trim() }
  const sizeProblem = draft.data ? bagSizeProblem([...existingItems, draft]) : null
  const usedBytes = bagBytes(existingItems)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!draft.name || !draft.data || sizeProblem || !options.choice) return

    setStatus({ kind: 'sending' })
    try {
      const round = await onAddItem(draft.name, draft.data, options.choice)
      if (round === null) {
        setStatus({
          kind: 'error',
          message: 'No round was started, so the bag is unchanged. Check the Console for the reason, then try again.',
        })
        return
      }
      // Deliberately *not* `bag.version + 1`. Version progression is anchored
      // to the library's own snapshot, which also advances on pair-completion
      // auto-publish, so a guess drifts the moment anything else publishes —
      // and every `ShareConfirmed` then files against a round nobody is
      // watching, leaving this dialog stuck at "0 of N confirmed" while the
      // round underneath it completes normally.
      //
      // Followed for the participants the round was actually sent to, as the
      // library reported them, rather than the list above: the two agree
      // unless a channel changed state between listing and sending.
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
  const progress = confirming
    ? roundProgress(participants, confirming.participantIds, confirming.version)
    : null

  const canSubmit =
    draft.name.length > 0 && draft.data.length > 0 && sizeProblem === null && options.choice !== null
  const isBlocking = status.kind === 'sending' || (progress !== null && !progress.allResolved)
  const isFirstItem = !itemBag

  return (
    <ModalFrame
      overlayClassName="modal-overlay"
      className="modal"
      label="Add item"
      // The same rule as the close button: not while the round is being sent or
      // is still waiting on participants it was sent to.
      onEscape={isBlocking ? undefined : onClose}
    >
      <div className="modal-header">
        <h2 className="modal-title">Add Item</h2>
        {!isBlocking && <ModalCloseButton onClose={onClose} />}
      </div>

      {progress && confirming ? (
        <ProtectRoundProgress
          progress={progress}
          threshold={confirming.threshold}
          version={confirming.version}
          failureHeading="Secret protection failed."
          onClose={onClose}
        />
      ) : (
        <form className="modal-body" onSubmit={handleSubmit}>
          {isFirstItem && (
            <p className="modal-description">
              This will create the item bag and distribute it to all paired participants.
            </p>
          )}

          <div className="form-field">
            <label className="form-label" htmlFor="ps-name">Name</label>
            <input
              id="ps-name"
              className="full-input"
              type="text"
              placeholder="e.g. Google Password"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              disabled={status.kind === 'sending'}
              autoFocus
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="ps-data">Item Data</label>
            <ItemDataField
              value={form.data}
              onChange={data => setForm(f => ({ ...f, data }))}
              disabled={status.kind === 'sending'}
              describedBy={sizeProblem ? 'ps-data-error' : 'ps-data-help'}
              invalid={sizeProblem !== null}
            />
            {sizeProblem ? (
              <p className="field-error" id="ps-data-error" role="alert">{sizeProblem}</p>
            ) : (
              <p className="empty-hint" id="ps-data-help">
                Up to {MAX_BAG_SIZE_LABEL} across all of this secret’s items
                {usedBytes > 0 ? ` (${formatBytes(usedBytes)} used)` : ''}. Every helper’s share
                and every kept version is stored in this browser, whose storage is limited.
              </p>
            )}
          </div>

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

          {status.kind === 'error' && (
            <p className="field-error">{status.message}</p>
          )}

          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={status.kind === 'sending'}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!canSubmit || status.kind === 'sending'}>
              {status.kind === 'sending' ? 'Sending…' : 'Add Item'}
            </button>
          </div>
        </form>
      )}
    </ModalFrame>
  )
}
