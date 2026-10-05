// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState } from 'react'

import type { LinkGroup } from './linkGroups'
import { TransportTag } from './TransportTag'
import { SharedKeyRow } from './primitives'
import { pairingRoleLabel } from '../pairingRoleOptions'
import type { PairedParticipant } from '../types'
import { heldShareCount } from './heldShares'
import { lastDeliveryProblem, SHARE_FAILURE_LABEL } from './shareFailure'
import { offersRemoteLink } from '../remoteHelperLink'
import { RemoteHelperLinkModal } from './RemoteHelperLinkModal'

/** Channel detail line shown under a channel (shared key + share count). */
function ChannelDetails({
  h,
  committedVersions,
}: {
  h: PairedParticipant
  committedVersions?: ReadonlySet<number>
}) {
  return (
    <div className="channel-row-bottom">
      {h.sharedKey && (
        <div className="channel-prop channel-prop--key">
          <span className="channel-prop-label">Shared Key</span>
          <SharedKeyRow value={h.sharedKey} label={false} />
        </div>
      )}
      <div className="channel-prop">
        <span className="channel-prop-label">Shares</span>
        <span className="channel-prop-value">
          {heldShareCount(h.secretShares, committedVersions)}
        </span>
      </div>
    </div>
  )
}

/**
 * How a channel is doing, as a dot and — when there is something to say — a tag.
 *
 * Green means the peer answers. A peer switched off on the node, or whose
 * newest share was met with silence or never left, is not shown green: that
 * is exactly the peer a person looking at this list needs to notice.
 */
function channelHealth(h: PairedParticipant) {
  const problem = h.offline ? null : lastDeliveryProblem(h.secretShares)
  return { problem, dot: h.offline ? 'offline' : problem ? 'available' : 'paired' }
}

function ChannelStatusDot({ h }: { h: PairedParticipant }) {
  return <span className={`participant-dot ${channelHealth(h).dot}`} aria-hidden="true" />
}

function ChannelStatusTags({ h }: { h: PairedParticipant }) {
  const { problem } = channelHealth(h)
  return (
    <>
      {h.offline && <span className="status-tag offline">Offline</span>}
      {problem && (
        <span className="status-tag available" title="How the most recent share sent over this channel went">
          Last share: {SHARE_FAILURE_LABEL[problem]}
        </span>
      )}
    </>
  )
}

/**
 * What stands where Unpair would on a channel this vault cannot unpair.
 *
 * Unpairing is the owner's to start: on a channel where the peer is the owner
 * — this vault holds shares *for* them — the library refuses it outright
 * (`role_mismatch: expected Helper, got Owner`). Offering the button there was
 * a promise that always failed.
 */
function OwnerUnpairsNote() {
  return (
    <span
      className="channel-id-inline"
      title="This vault is the helper on this channel. Only the owner can unpair it."
    >
      Only the owner can unpair
    </span>
  )
}

/**
 * The main channel list — participant channels only.
 *
 * Replica channels are deliberately absent: they are listed in the Replicas tab
 * and nowhere else, so a row in this list is always somewhere a share can go.
 * The page feeds both lists from one `splitPairedChannels` call, so neither can
 * show what the other does.
 */
export function PairedParticipantsList({
  groups,
  unpairingChannelIds,
  onTogglePair,
  onLink,
  committedVersions,
}: {
  groups: LinkGroup[]
  /** This vault's committed bag versions — see `committedVersionsOf`. */
  committedVersions?: ReadonlySet<number>
  /** Channel IDs whose unpair request is currently in flight — disables the
   *  Unpair button so a repeated click doesn't send a second envelope. */
  unpairingChannelIds: Set<string>
  onTogglePair: (id: string) => void
  onLink: (channelId: string) => void
}) {
  // The channel whose helper is being linked on its own node, if any.
  const [remoteLinkFor, setRemoteLinkFor] = useState<PairedParticipant | null>(null)

  if (groups.length === 0) {
    return <p className="tab-empty-state">No paired participant channels yet. Pair a participant from the side panel. Replicas are listed in the Replicas tab.</p>
  }

  function unpairButton(h: PairedParticipant) {
    if (h.peerRole === 'owner') return <OwnerUnpairsNote />
    const channelId = h.channelId
    const participantId = h.id
    const inFlight = unpairingChannelIds.has(channelId)
    return (
      <button
        className="channel-unpair-btn"
        onClick={() => onTogglePair(participantId)}
        disabled={inFlight}
        aria-busy={inFlight || undefined}
      >
        {inFlight ? 'Unpairing…' : 'Unpair'}
      </button>
    )
  }

  function remoteLinkButton(h: PairedParticipant) {
    if (!offersRemoteLink(h)) return null
    return (
      <button
        className="channel-link-btn"
        onClick={() => setRemoteLinkFor(h)}
        title="Recovering? Tell this helper, on the node that runs it, that this channel belongs to an owner it already holds shares for."
      >
        Link on its node
      </button>
    )
  }

  return (
    <div className="channel-table">
      {remoteLinkFor && (
        <RemoteHelperLinkModal channel={remoteLinkFor} onClose={() => setRemoteLinkFor(null)} />
      )}
      {groups.map(group => {
        // Singleton (unlinked) channel — compact single row with Link + Unpair.
        if (group.channels.length === 1) {
          const h = group.channels[0]

          return (
            <div key={group.key} className="channel-block">
              <div className="channel-row-top">
                <ChannelStatusDot h={h} />
                <span className="channel-row-name" style={{ flex: 'none' }}>{group.name}</span>
                {h.peerRole && (
                  <span className={`role-tag role-tag--${h.peerRole}`}>
                    {pairingRoleLabel(h.peerRole)}
                  </span>
                )}
                <TransportTag h={h} />
                <span className="channel-id-inline">{h.channelId}</span>
                <span className="channel-row-spacer" />
                <ChannelStatusTags h={h} />
                <button className="channel-link-btn" onClick={() => onLink(h.channelId)}>
                  Link
                </button>
                {remoteLinkButton(h)}
                {unpairButton(h)}
              </div>
              <ChannelDetails h={h} committedVersions={committedVersions} />
            </div>
          )
        }

        // Linked group — name header (group-level Link) + one sub-row per channel.
        return (
          <div key={group.key} className="channel-block">
            <div className="channel-group-header">
              <span className="participant-dot paired" aria-hidden="true" />
              <span className="channel-row-name" style={{ flex: 'none' }}>{group.name}</span>
              <span className="channel-row-spacer" />
              <button className="channel-link-btn" onClick={() => onLink(group.mainChannelId)}>
                Link
              </button>
            </div>
            {group.channels.map(h => (
              <div key={h.id} className="channel-sub">
                <div className="channel-sub-top">
                  <ChannelStatusDot h={h} />
                  {h.peerRole && (
                    <span className={`role-tag role-tag--${h.peerRole}`}>
                      {pairingRoleLabel(h.peerRole)}
                    </span>
                  )}
                  <TransportTag h={h} />
                  <span className="channel-id-inline">{h.channelId}</span>
                  <span className="channel-row-spacer" />
                  <ChannelStatusTags h={h} />
                  {remoteLinkButton(h)}
                  {unpairButton(h)}
                </div>
                <ChannelDetails h={h} committedVersions={committedVersions} />
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
