// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { DeRecEvent } from '@derec-alliance/web'

import type { ServerDefaults } from '../../config'
import type { ProtocolInstance } from '../../owner/protocol'
import type { RestoreFailure } from '../../replicaFlows'
import type { Vault } from '../../types'
import type { VaultLogger, VaultNotifier } from '../types'

/**
 * What a command extracted from `VaultRuntime` may reach.
 *
 * The runtime keeps a thin method per command and hands this over, so the long
 * multi-step commands can live in their own modules without reaching into the
 * runtime's private state.
 */
export interface CommandContext {
  readonly log: VaultLogger
  readonly notify: VaultNotifier
  /** The record as committed right now. */
  getVault(): Vault
  commit(next: Vault): void
  getServerDefaults(): ServerDefaults
  /** The running protocol instance, or null before the vault has started. */
  instance(): ProtocolInstance | null
  /** Serialise a call on the instance — see `VaultRuntime.withLock`. */
  withLock<T>(fn: () => Promise<T>): Promise<T>
  /** Fold one event into `current`, as the drain would. */
  fold(current: Vault, event: DeRecEvent): Vault
  /**
   * Rebind the vault to an instance the command built. Restore and adoption
   * both rebuild state under the recovered `secret_id` in a fresh instance.
   */
  adoptInstance(instance: ProtocolInstance): void
}

/** Adoption can also block the vault. */
export interface AdoptionContext extends CommandContext {
  block(failure: RestoreFailure): void
}
