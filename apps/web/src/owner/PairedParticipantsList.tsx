import type { LinkGroup } from './linkGroups'
import { TransportTag } from './TransportTag'
import { SharedKeyRow } from './primitives'
import { pairingRoleLabel } from '../pairingRoleOptions'
import type { PairedParticipant } from '../types'

/** Channel detail line shown under a channel (shared key + share count). */
function ChannelDetails({ h }: { h: PairedParticipant }) {
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
        <span className="channel-prop-value">{h.secretShares.length}</span>
      </div>
    </div>
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
}: {
  groups: LinkGroup[]
  /** Channel IDs whose unpair request is currently in flight — disables the
   *  Unpair button so a repeated click doesn't send a second envelope. */
  unpairingChannelIds: Set<string>
  onTogglePair: (id: string) => void
  onLink: (channelId: string) => void
}) {
  if (groups.length === 0) {
    return <p className="tab-empty-state">No paired participant channels yet. Pair a participant from the side panel. Replicas are listed in the Replicas tab.</p>
  }

  function unpairButton(channelId: string, participantId: string) {
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

  return (
    <div className="channel-table">
      {groups.map(group => {
        // Singleton (unlinked) channel — compact single row with Link + Unpair.
        if (group.channels.length === 1) {
          const h = group.channels[0]

          return (
            <div key={group.key} className="channel-block">
              <div className="channel-row-top">
                <span className={`participant-dot ${h.offline ? 'offline' : 'paired'}`} aria-hidden="true" />
                <span className="channel-row-name" style={{ flex: 'none' }}>{group.name}</span>
                {h.peerRole && (
                  <span className={`role-tag role-tag--${h.peerRole}`}>
                    {pairingRoleLabel(h.peerRole)}
                  </span>
                )}
                <TransportTag h={h} />
                <span className="channel-id-inline">{h.channelId}</span>
                <span style={{ flex: 1 }} />
                {h.offline && <span className="status-tag offline">Offline</span>}
                <button className="channel-link-btn" onClick={() => onLink(h.channelId)}>
                  Link
                </button>
                {unpairButton(h.channelId, h.id)}
              </div>
              <ChannelDetails h={h} />
            </div>
          )
        }

        // Linked group — name header (group-level Link) + one sub-row per channel.
        return (
          <div key={group.key} className="channel-block">
            <div className="channel-group-header">
              <span className="participant-dot paired" aria-hidden="true" />
              <span className="channel-row-name" style={{ flex: 'none' }}>{group.name}</span>
              <span style={{ flex: 1 }} />
              <button className="channel-link-btn" onClick={() => onLink(group.mainChannelId)}>
                Link
              </button>
            </div>
            {group.channels.map(h => (
              <div key={h.id} className="channel-sub">
                <div className="channel-sub-top">
                  <span className={`participant-dot ${h.offline ? 'offline' : 'paired'}`} aria-hidden="true" />
                  {h.peerRole && (
                    <span className={`role-tag role-tag--${h.peerRole}`}>
                      {pairingRoleLabel(h.peerRole)}
                    </span>
                  )}
                  <TransportTag h={h} />
                  <span className="channel-id-inline">{h.channelId}</span>
                  <span style={{ flex: 1 }} />
                  {h.offline && <span className="status-tag offline">Offline</span>}
                  {unpairButton(h.channelId, h.id)}
                </div>
                <ChannelDetails h={h} />
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
