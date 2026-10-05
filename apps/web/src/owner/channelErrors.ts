// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * Shapes the WASM library reports failures in.
 *
 * Kept apart from the components that render them: these are plain
 * predicates, and a module that exports both components and helpers cannot
 * be fast-refreshed.
 */

export interface NonOkStatus {
  status: number
  memo: string
  channelId?: string
}

/**
 * A `process()` failure for a channel this device has no key for.
 *
 * The library reports it as a generic input error — `invalid_input` since SDK
 * 0.0.6, `DEREC_ERROR` before — so the message text is the only discriminator.
 */
export function isUnknownChannelError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const obj = err as Record<string, unknown>
  return (
    (obj.code === 'invalid_input' || obj.code === 'DEREC_ERROR') &&
    typeof obj.message === 'string' &&
    obj.message.includes('unknown channel_id')
  )
}

/** Channel id carried by a WASM error, when it reports one. */
export function unknownChannelId(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const id = (err as Record<string, unknown>).channel_id
  return typeof id === 'string' ? id : undefined
}

/**
 * Extract structured NonOkStatus from a WASM process() error, or null if it's a
 * different error. The code is `non_ok_status` since SDK 0.0.6, `NON_OK_STATUS`
 * before.
 */
export function asNonOkStatus(err: unknown): NonOkStatus | null {
  const code = typeof err === 'object' && err !== null ? (err as Record<string, unknown>).code : undefined
  if (code === 'non_ok_status' || code === 'NON_OK_STATUS') {
    const obj = err as Record<string, unknown>
    return {
      status: obj.status as number,
      memo: (obj.memo as string) ?? '',
      channelId: obj.channel_id as string | undefined,
    }
  }
  return null
}
