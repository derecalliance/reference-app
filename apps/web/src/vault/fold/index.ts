// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { DeRecEvent } from '@derec-alliance/web'

import type { Vault } from '../../types'
import type { EventHandlers, FoldContext } from './context'
import { outcomeHandlers } from './outcomes'
import { pairingHandlers } from './pairing'
import { recoveryHandlers } from './recovery'
import { replicaHandlers } from './replica'
import { sharingHandlers } from './sharing'

export type { FoldContext } from './context'

/**
 * Every event type, mapped to what it does to the vault.
 *
 * Exhaustive by type: `EventHandlers` requires a key per `DeRecEvent` variant,
 * so an SDK upgrade that adds an event fails to compile here until someone
 * decides what it means — rather than falling through to "nothing" unnoticed.
 * Events with nothing to fold still get an explicit entry.
 */
const HANDLERS: EventHandlers = {
  ...pairingHandlers,
  ...sharingHandlers,
  ...recoveryHandlers,
  ...replicaHandlers,
  ...outcomeHandlers,
}

/** An erased handler: the table is indexed by a runtime value. */
type AnyHandler = (current: Vault, event: DeRecEvent, ctx: FoldContext) => Vault

/**
 * Fold one protocol event into the vault record.
 *
 * A reducer: returns the next record rather than mutating, and the caller
 * threads the result forward.
 */
export function foldEvent(current: Vault, event: DeRecEvent, ctx: FoldContext): Vault {
  // The cast is the one place the table's per-key typing cannot follow: TS does
  // not correlate `HANDLERS[event.type]` with `event`'s own variant. Sound,
  // because the table maps each type to the handler for that type.
  const handler = HANDLERS[event.type] as AnyHandler | undefined

  // Exhaustive at compile time, but the wire is not: a newer library can still
  // deliver a type this build has never heard of.
  if (!handler) {
    ctx.log({
      role: 'owner',
      flow: 'protocol',
      step: 'unhandled_event',
      description: `Ignored an event this app does not know: ${String((event as { type: unknown }).type)}`,
      payload: { type: (event as { type: unknown }).type },
    })
    return current
  }

  return handler(current, event, ctx)
}
