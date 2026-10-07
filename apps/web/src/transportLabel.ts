// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { Transport } from './types'

/**
 * How a peer's advertised endpoints read as a badge.
 *
 * This app exists to debug interoperability, so "which transport is this peer
 * on" is a question the screen should answer without anyone opening a terminal.
 * Until this existed, the only way to tell a gRPC-only helper from one offering
 * both was to call `/actors` and read the JSON.
 *
 * Derived from the endpoints themselves rather than stored alongside them, so
 * the badge cannot disagree with what the peer actually advertises.
 */
export function transportLabel(
  transport: Transport,
  transports?: Transport[],
): string {
  // The singular field is only ever the first entry, so on its own it cannot
  // distinguish `grpc` from `both`. Fall back to it only when the list is
  // genuinely unknown — a channel resolved from what travelled on the wire.
  const list = transports?.length ? transports : [transport]

  const grpc = list.some(t => t.protocol === 'grpc')
  const https = list.some(t => t.protocol === 'https')

  if (grpc && https) return 'GRPC+HTTPS'
  if (grpc) return 'GRPC'
  return 'HTTPS'
}
