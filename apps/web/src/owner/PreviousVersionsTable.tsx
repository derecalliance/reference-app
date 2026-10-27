// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'
import { BagPayloadModal } from './BagPayloadModal'
import { TrashIcon } from './icons'
import { recoverability, type Recoverability } from './recoverability'
import { RemoveVersionModal } from './RemoveVersionModal'
import { shareFailureLabel } from './shareFailure'
import { verifyBlockedReason } from './verification'
import type { BagVersion, PairedParticipant, PendingProtectRound } from '../types'

/**
 * The bag's earlier versions, one row each, newest first. They are history —
 * nothing is edited here — so a row summarises what the current version's card
 * spells out in full, and keeps the actions that still apply to an old
 * version: reading its payload, verifying its shares, and removing it from
 * this device.
 */
export function PreviousVersionsTable({
  versions,
  participants,
  pendingRounds,
  onVerify,
  onRemove,
}: {
  versions: readonly BagVersion[]
  participants: readonly PairedParticipant[]
  pendingRounds: readonly PendingProtectRound[]
  /** Open verification for this version. */
  onVerify: (version: number) => void
  /** Remove this version and its verification copies from this device. */
  onRemove: (version: number) => Promise<void>
}) {
  const [payloadVersion, setPayloadVersion] = useState<BagVersion | null>(null)
  const [versionToRemove, setVersionToRemove] = useState<BagVersion | null>(null)

  return (
    <>
      <div className="versions-table-wrap">
        <table className="versions-table">
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Secrets</th>
              <th scope="col">Threshold</th>
              <th scope="col">Helpers</th>
              <th scope="col">Recoverable</th>
              <th scope="col" className="versions-table__actions-th" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {versions.map(v => (
              <PreviousVersionRow
                key={v.version}
                version={v}
                participants={participants}
                verifyDisabledReason={verifyBlockedReason(v, pendingRounds)}
                onVerify={onVerify}
                onViewPayload={setPayloadVersion}
                onRemove={setVersionToRemove}
              />
            ))}
          </tbody>
        </table>
      </div>

      {payloadVersion && (
        <BagPayloadModal version={payloadVersion} onClose={() => setPayloadVersion(null)} />
      )}
      {versionToRemove && (
        <RemoveVersionModal
          version={versionToRemove}
          onRemove={onRemove}
          onClose={() => setVersionToRemove(null)}
        />
      )}
    </>
  )
}

function PreviousVersionRow({
  version,
  participants,
  verifyDisabledReason,
  onVerify,
  onViewPayload,
  onRemove,
}: {
  version: BagVersion
  participants: readonly PairedParticipant[]
  /** Why Verify is unavailable right now; `null` when it is available. */
  verifyDisabledReason: string | null
  onVerify: (version: number) => void
  onViewPayload: (version: BagVersion) => void
  onRemove: (version: BagVersion) => void
}) {
  const confirmed = participants.filter(p => version.participantIds.includes(p.id))
  const verifiedCount = confirmed.filter(p => version.verifiedParticipantIds.includes(p.id)).length
  const failed = version.failedParticipantIds ?? []
  const secretNames = version.secrets.map(s => s.name).join(', ')

  return (
    <tr className="versions-table__row">
      <td>
        <span className="version-tag">v{version.version}</span>
      </td>
      <td className="versions-table__secrets" title={secretNames}>
        <span className="versions-table__count">{version.secrets.length}</span>
        <span className="versions-table__names">{secretNames}</span>
      </td>
      <td>{version.threshold ?? '—'}</td>
      <td title={helperDetail(version, confirmed, participants)}>
        {confirmed.length === 0 ? (
          <span className="empty-hint">None confirmed</span>
        ) : (
          <span>{verifiedCount}/{confirmed.length} verified</span>
        )}
        {failed.length > 0 && (
          <span className="versions-table__failed"> · {failed.length} failed</span>
        )}
      </td>
      <td>
        <RecoverabilityCell verdict={recoverability(version)} />
      </td>
      <td className="versions-table__actions">
        <button
          type="button"
          className="secondary small"
          onClick={() => onViewPayload(version)}
          aria-label={`View Payload of v${version.version}`}
        >
          Payload
        </button>
        {confirmed.length > 0 && (
          <button
            type="button"
            className="secondary small verify-btn"
            onClick={() => onVerify(version.version)}
            disabled={verifyDisabledReason !== null}
            title={verifyDisabledReason ?? undefined}
            aria-label={`Verify Shares of v${version.version}`}
          >
            Verify
          </button>
        )}
        <button
          type="button"
          className="secondary small remove-secret-btn versions-table__remove"
          onClick={() => onRemove(version)}
          title={`Remove v${version.version} from this device`}
          aria-label={`Remove v${version.version}`}
        >
          <TrashIcon />
        </button>
      </td>
    </tr>
  )
}

const RECOVERABILITY_LABELS: Record<Recoverability['kind'], string> = {
  recoverable: 'Yes',
  short: 'Short',
  unknown: 'Unknown',
}

/** The card's recoverability sentence, cut to one word; the numbers move to the tooltip. */
function RecoverabilityCell({ verdict }: { verdict: Recoverability | null }) {
  if (!verdict) {
    return <span className="empty-hint" title="No helper has verified this version yet">—</span>
  }
  const detail =
    verdict.threshold === null
      ? 'Published before subshare counts were recorded'
      : `${verdict.verified} of ${verdict.threshold} subshares verified`
  return (
    <span className={`recoverability--${verdict.kind}`} title={detail}>
      {RECOVERABILITY_LABELS[verdict.kind]}
    </span>
  )
}

/** One line per helper that confirmed or failed this version, for the Helpers cell's tooltip. */
function helperDetail(
  version: BagVersion,
  confirmed: readonly PairedParticipant[],
  participants: readonly PairedParticipant[],
): string {
  const nameOf = (id: string) => participants.find(p => p.id === id)?.name ?? id
  const confirmedLines = confirmed.map(({ id, name }) => {
    if (version.verifiedParticipantIds.includes(id)) return `${name}: verified`
    if (version.invalidProofParticipantIds?.includes(id)) return `${name}: proof invalid`
    if (version.verifyRejections?.some(r => r.id === id)) return `${name}: rejected verification`
    return `${name}: not yet verified`
  })
  const failedLines = (version.failedParticipantIds ?? []).map(
    f => `${nameOf(f.id)}: ${shareFailureLabel(f)}`,
  )
  return [...confirmedLines, ...failedLines].join('\n')
}
