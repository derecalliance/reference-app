// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { DeRecEvent } from '@derec-alliance/web'

import type { PendingReplicaAdoption } from '../../replicaFlows'
import type { StoredChannelInfo } from '../../stores'
import type { Vault } from '../../types'
import type { RoundTracker } from '../rounds'
import type { ChannelInfoOutcome, VaultLogger, VaultNotifier, VaultViewEffects } from '../types'

export type EventType = DeRecEvent['type']

/** The event variant carrying `type: K`. */
export type EventOf<K extends EventType> = Extract<DeRecEvent, { type: K }>

/**
 * Fold one event into the vault record.
 *
 * A reducer: returns the next record rather than mutating it, and the caller
 * threads the result forward. Side effects — logging, notifying, the round
 * tracker — go through `ctx`.
 */
export type EventHandler<K extends EventType> = (
  current: Vault,
  event: EventOf<K>,
  ctx: FoldContext,
) => Vault

/**
 * One handler per event type. Exhaustive by construction — see `fold/index.ts`.
 *
 * A handler shared by several types is written as a plain function over their
 * union (`EventOf<A | B>`), not as `EventHandler<A | B>`: `EventOf` is a
 * conditional type, so TS compares `EventHandler`'s type argument invariantly
 * and would reject a union handler in a single-type slot.
 */
export type EventHandlers = { [K in EventType]: EventHandler<K> }

/**
 * Everything an event handler may reach, and nothing more.
 *
 * Deliberately narrow: handlers are reducers over the vault record, and this is
 * the complete list of ways they are allowed to touch anything else.
 */
export interface FoldContext {
  readonly log: VaultLogger
  readonly notify: VaultNotifier
  readonly effects: VaultViewEffects
  readonly rounds: RoundTracker
  /** A flow made progress: restart the watchdog, if a flow is in flight. */
  flowProgressed(): void
  /** A sharing round resolved: cancel the watchdog, unless another round still needs it. */
  roundResolved(): void
  /**
   * The record as committed right now. For the few handlers that commit on
   * their own schedule rather than through the reducer's return value.
   */
  getVault(): Vault
  commit(next: Vault): void
  /** Put a mirrored vault in front of the owner as an adoption offer. */
  offerReplicaAdoption(offer: PendingReplicaAdoption): void
  /**
   * The name and endpoints the store now holds for a helper-type channel —
   * where `UpdateChannelInfo` leaves what a peer announced, since the event
   * itself names only the channel.
   */
  readChannelInfo(channelId: string): StoredChannelInfo | null
  /**
   * A peer answered this vault's own identity update. Ignored for a channel
   * the latest update did not go to — the same events fire when a *peer*
   * updates this vault.
   */
  channelInfoOutcome(channelId: string, outcome: ChannelInfoOutcome, detail: string | null): void
  /**
   * Whether this vault's latest identity update is still waiting on the peer
   * on `channelId` — so a `ChannelInfoUpdated` there is that peer's answer
   * rather than its own announcement.
   */
  awaitingIdentityAnswer(channelId: string): boolean
  /**
   * Whether this vault, as a helper, still stores the share it received on
   * `channelId` at `version`. The library deletes the versions an owner's
   * `keepList` leaves out while it stores a new one, through the share store
   * and without an event of its own.
   */
  isShareHeld(channelId: string, version: number): boolean
}
