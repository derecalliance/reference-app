// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { DeRecEvent } from '@derec-alliance/web'

import { toBytes } from '../bytes'
import { fromBase64Url, toBase64Url } from '../derecApi'
import { protocolName } from '../contactDto'
import type { RecoveredSecretSnapshot } from '../types'

// ── Recovered secret snapshot ────────────────────────────────────────────────
//
// `SecretRecovered` carries a typed roster snapshot — the library handles the
// two-stage DeRecSecret -> Secret protobuf decode internally. The app only
// converts between that in-memory shape (binary fields as Uint8Array) and the
// persisted one (base64url), because `protocol.restore` needs the original
// shape back after a reload.

/** The `secret` payload of a SecretRecovered event. */
export type RecoveredSecretPayload = Extract<DeRecEvent, { type: 'SecretRecovered' }>['secret']

export function snapshotFromEvent(secret: RecoveredSecretPayload): RecoveredSecretSnapshot {
  return {
    helpers: secret.helpers.map(h => ({
      channelId: h.channel_id,
      transports: (h.transports ?? []).map(t => ({ uri: t.uri, protocol: protocolName(t.protocol) })),
      communicationInfo: h.communication_info,
      sharedKey: toBase64Url(toBytes(h.shared_key)),
    })),
    secrets: secret.secrets.map(s => ({
      id: toBase64Url(toBytes(s.id)),
      name: s.name,
      data: toBase64Url(toBytes(s.data)),
    })),
    replicas: secret.replicas
      ? {
          channelId: secret.replicas.channel_id,
          members: secret.replicas.members.map(m => ({
            transports: (m.transports ?? []).map(t => ({ uri: t.uri, protocol: protocolName(t.protocol) })),
            communicationInfo: m.communication_info,
            replicaId: m.replica_id,
            role: m.role,
          })),
          sharedKey: toBase64Url(toBytes(secret.replicas.shared_key)),
        }
      : undefined,
  }
}

/** Rebuild the event payload `protocol.restore` expects from a persisted snapshot. */
export function snapshotToPayload(snapshot: RecoveredSecretSnapshot): RecoveredSecretPayload {
  return {
    helpers: snapshot.helpers.map(h => ({
      channel_id: h.channelId,
      transports: (h.transports ?? []).map(t => ({ uri: t.uri, protocol: protocolName(t.protocol) })),
      communication_info: h.communicationInfo,
      shared_key: fromBase64Url(h.sharedKey),
    })),
    secrets: snapshot.secrets.map(s => ({
      id: fromBase64Url(s.id),
      name: s.name,
      data: fromBase64Url(s.data),
    })),
    replicas: snapshot.replicas
      ? {
          channel_id: snapshot.replicas.channelId,
          members: snapshot.replicas.members.map(m => ({
            replica_id: m.replicaId,
            transports: (m.transports ?? []).map(t => ({ uri: t.uri, protocol: protocolName(t.protocol) })),
            role: m.role,
            communication_info: m.communicationInfo,
          })),
          shared_key: fromBase64Url(snapshot.replicas.sharedKey),
        }
      : undefined,
  }
}

/** Secret payloads are text in this app; decode lossily for display so a
 *  binary surprise renders as replacement chars instead of throwing. */
export function decodeSecretText(base64: string): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(fromBase64Url(base64))
}
