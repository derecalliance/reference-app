// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { ModalFrame } from './ModalFrame'
import type { ReplicaRemovalRequest } from './replicaRemoval'

/**
 * The confirmation in front of both ways a replica row leaves this device's
 * list: "Forget" (local only) and "Remove from group" (the protocol's
 * eviction).
 *
 * The two are confirmed in one place, and in the same shape, because they are
 * easy to confuse and their consequences are opposite. Forget touches nothing
 * but this device's own list — the library keeps the member and keeps
 * mirroring to it. Remove from group is the protocol's real teardown, and it
 * is destructive for the *other* device: once the evicted member sees a roster
 * without itself, the library there drops its whole copy of the vault. Before
 * this dialog existed that was one click, which let a destination erase the
 * source's own vault by accident.
 */

export interface ReplicaRemovalDialogProps {
  request: ReplicaRemovalRequest
  onCancel: () => void
  onConfirm: (request: ReplicaRemovalRequest) => void
}

export function ReplicaRemovalDialog({ request, onCancel, onConfirm }: ReplicaRemovalDialogProps) {
  const titleId = 'replica-removal-title'
  const destructive = request.kind === 'remove' && request.targetIsSource

  return (
    <ModalFrame
      overlayClassName="modal-overlay"
      className="modal"
      labelledBy={titleId}
      onEscape={onCancel}
    >
      <div className="modal-header">
        <h2 className="modal-title" id={titleId}>
          {request.kind === 'forget'
            ? 'Forget this replica?'
            : destructive
              ? `Remove the source, ${request.name}?`
              : `Remove ${request.name} from the group?`}
        </h2>
      </div>
      <div className="modal-body">
        {request.kind === 'forget' ? (
          <ForgetBody name={request.name} channelId={request.channelId} />
        ) : (
          <RemoveBody
            name={request.name}
            replicaId={request.replicaId}
            targetIsSource={request.targetIsSource}
          />
        )}
      </div>
      <div className="modal-actions">
        {/* Cancel first and focused: neither action is something a stray
            Enter should reach. */}
        <button className="secondary" onClick={onCancel} autoFocus>
          Cancel
        </button>
        <button
          className={request.kind === 'remove' ? 'danger' : 'primary'}
          onClick={() => onConfirm(request)}
        >
          {request.kind === 'forget'
            ? 'Forget'
            : destructive
              ? 'Remove the source'
              : 'Remove from group'}
        </button>
      </div>
    </ModalFrame>
  )
}

function ForgetBody({ name, channelId }: { name: string; channelId: string }) {
  return (
    <>
      <p>
        Remove <strong>{name}</strong> on channel <code>{channelId}</code> from this device’s
        list.
      </p>
      {/* Precise about what Forget does *not* do: the library's group is its
          own record, untouched by this, and it goes on mirroring to every
          member it holds. Saying "nothing is mirrored to them again" promised
          a teardown this action does not perform. */}
      <p>
        <strong>Only this device’s list changes.</strong> {name} is not told, and the
        protocol still counts them as a member: every protect round from this vault
        keeps mirroring to them. To stop that, use “Remove from group” instead — it is
        offered once the peer has announced its replica id.
      </p>
    </>
  )
}

function RemoveBody({
  name,
  replicaId,
  targetIsSource,
}: {
  name: string
  replicaId: string
  targetIsSource: boolean
}) {
  return (
    <>
      <p>
        Evict replica <code>{replicaId}</code> ({name}) from the replica group. The rest of
        the group is told, and stops mirroring to it.
      </p>
      {targetIsSource ? (
        <div className="replica-row-notice replica-row-notice--error" role="alert">
          <span className="replica-row-prompt__text">
            <strong>{name} is the source of this group — the device this vault came from.</strong>{' '}
            Once {name} sees the new roster, the protocol on that device erases its whole
            copy of the vault: its secrets, helper channels and shares. The group then
            promotes another member to source, which may be this device — from then on,
            this device publishes the vault. This cannot be undone from here.
          </span>
        </div>
      ) : (
        <p>
          <strong>This erases {name}’s copy.</strong> Once {name} sees the new roster, the
          protocol on that device drops everything it holds for this vault. It would have
          to be paired and mirrored again to come back.
        </p>
      )}
    </>
  )
}
