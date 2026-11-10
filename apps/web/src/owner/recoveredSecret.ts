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

export function snapshotFromEvent(payload: RecoveredSecretPayload): RecoveredSecretSnapshot {
  return {
    helpers: payload.helpers.map(h => ({
      channelId: h.channel_id,
      transports: (h.transports ?? []).map(t => ({ uri: t.uri, protocol: protocolName(t.protocol) })),
      communicationInfo: h.communication_info ?? undefined,
      sharedKey: toBase64Url(toBytes(h.shared_key)),
      ...(h.weight !== undefined ? { weight: h.weight } : {}),
    })),
    items: payload.secrets.map(s => ({
      id: toBase64Url(toBytes(s.id)),
      name: s.name,
      data: toBase64Url(toBytes(s.data)),
    })),
    replicas: payload.replicas
      ? {
          channelId: payload.replicas.channel_id,
          members: payload.replicas.members.map(m => ({
            transports: (m.transports ?? []).map(t => ({ uri: t.uri, protocol: protocolName(t.protocol) })),
            communicationInfo: m.communication_info ?? undefined,
            replicaId: m.replica_id,
            role: m.role,
          })),
          sharedKey: toBase64Url(toBytes(payload.replicas.shared_key)),
        }
      : undefined,
    ...(payload.threshold !== undefined ? { threshold: payload.threshold } : {}),
  }
}

/** Rebuild the event payload `protocol.restore` expects from a persisted snapshot. */
export function snapshotToPayload(snapshot: RecoveredSecretSnapshot): RecoveredSecretPayload {
  return {
    helpers: snapshot.helpers.map(h => ({
      channel_id: h.channelId,
      transports: (h.transports ?? []).map(t => ({ uri: t.uri, protocol: protocolName(t.protocol) })),
      ...communicationInfoField(h.communicationInfo),
      shared_key: fromBase64Url(h.sharedKey),
      // Dropping it would make `restore` record every helper at weight 1, and
      // the next publish would quietly reset the weights the owner chose.
      ...(h.weight !== undefined ? { weight: h.weight } : {}),
    })),
    secrets: snapshot.items.map(s => ({
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
            ...communicationInfoField(m.communicationInfo),
          })),
          shared_key: fromBase64Url(snapshot.replicas.sharedKey),
        }
      : undefined,
    // `restore` writes it as the next publish's threshold; dropped, a restored
    // secret would split at whatever its own builder setting says.
    ...(snapshot.threshold !== undefined ? { threshold: snapshot.threshold } : {}),
  }
}

/**
 * `communication_info` for a `restore` payload entry: present only when there
 * is one. Since SDK 0.0.9 an absent or `null` value reads as an empty map;
 * earlier builds refused an explicit `undefined`/`null`, so the key is still
 * left out rather than sent empty.
 */
function communicationInfoField(
  info: Record<string, string> | null | undefined,
): { communication_info?: Record<string, string> } {
  return info ? { communication_info: info } : {}
}

/** Item payloads are text in this app; decode lossily for display so a
 *  binary surprise renders as replacement chars instead of throwing. */
export function decodeItemText(base64: string): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(fromBase64Url(base64))
}
