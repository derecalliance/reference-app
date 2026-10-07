// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { transportLabel } from '../transportLabel'
import type { PairedParticipant, Transport } from '../types'

/**
 * Which transport a peer advertises, on the row where you are already looking.
 *
 * Answering this used to mean calling `/actors` and reading JSON — the screen
 * showed a peer's name, role and channel id but never how to reach it, which
 * is the first thing you want when a message is not arriving.
 *
 * Stated plainly, with no hedge. A peer advertises its **complete** set of
 * supported transports during pairing, so what this device holds is the whole
 * answer, not a sample of it. This badge used to carry a `~` when the value
 * came from the channel rather than from a roster lookup — but that described
 * where *this app* happened to read it, which is an implementation detail with
 * no meaning to someone reading the screen, and it made a correct label look
 * uncertain.
 */
export function TransportTag({ h }: { h: PairedParticipant }) {
  const label = transportLabel(h.transport, h.transports)
  const uris = (h.transports?.length ? h.transports : [h.transport])
    .map(t => t.uri)
    .filter(uri => uri !== '')
    .join(', ')

  return (
    <span
      className={`transport-tag transport-tag--${label.toLowerCase().replace('+', '-')}`}
      // Never "Advertises " with nothing after it: a row recorded before its
      // endpoints were known says so instead.
      title={uris ? `Advertises ${uris}` : 'Endpoints not known yet'}
    >
      {label}
    </span>
  )
}

export function TransportBlock({ transport }: { transport: Transport }) {
  return (
    <div className="transport-block">
      <div className="transport-row">
        <span className="meta-label">Protocol</span>
        <span className="protocol-badge">{transport.protocol.toUpperCase()}</span>
      </div>
      <div className="transport-row">
        <span className="meta-label">URI</span>
        <code className="uri-value">{transport.uri}</code>
      </div>
    </div>
  )
}
