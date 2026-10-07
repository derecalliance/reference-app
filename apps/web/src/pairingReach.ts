// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { errorText } from './errorText'
import type { Transport } from './types'

/**
 * Whether a browser vault can reach a peer at all, and how to say it when it
 * cannot.
 *
 * A browser speaks HTTPS only. A peer that advertises nothing but gRPC is
 * reachable from here solely through the node's relay (`/derec/relay`), so
 * with the relay off every message to it fails at the send — and the library
 * reports that as `transport.send promise rejected`, which names neither the
 * peer nor the cause.
 */

/** Whether every endpoint the peer advertises is gRPC — no HTTPS to fall back on. */
export function isGrpcOnly(transport: Transport, transports?: readonly Transport[]): boolean {
  const all = transports && transports.length > 0 ? transports : [transport]
  return all.length > 0 && all.every(t => t.protocol === 'grpc')
}

/**
 * Why pairing with this peer cannot work from a browser right now, or `null`
 * when it can.
 */
export function unreachableReason(
  transport: Transport,
  transports: readonly Transport[] | undefined,
  grpcRelayEnabled: boolean,
): string | null {
  if (grpcRelayEnabled || !isGrpcOnly(transport, transports)) return null
  return (
    'This participant is reachable over gRPC only, and the node’s gRPC relay is off — ' +
    'a browser cannot reach it. Turn the relay on, or pair with an HTTP participant.'
  )
}

const SEND_FAILED = /transport\.send|send promise rejected|failed to fetch|networkerror/i

/**
 * A pairing failure in words a person can act on.
 *
 * A failed send means the request never reached the peer, which is a
 * reachability problem rather than anything the peer decided; everything else
 * is passed through as the library said it.
 */
export function pairingErrorText(err: unknown): string {
  const text = errorText(err)
  if (!SEND_FAILED.test(text)) return text
  return `Could not reach the participant (the node’s gRPC relay is off, or the node is unreachable). Details: ${text}`
}
