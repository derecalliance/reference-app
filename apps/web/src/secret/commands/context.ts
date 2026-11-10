// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { DeRecEvent } from '@derec-alliance/web'

import type { ProtocolInstance } from '../../owner/protocol'
import type { RestoreFailure } from '../../replicaFlows'
import type { KeepVersionSource } from '../../stores'
import type { Secret } from '../../types'
import type { SecretLogger, SecretNotifier } from '../types'

/**
 * What a command extracted from `SecretRuntime` may reach.
 *
 * The runtime keeps a thin method per command and hands this over, so the long
 * multi-step commands can live in their own modules without reaching into the
 * runtime's private state.
 */
export interface CommandContext {
  readonly log: SecretLogger
  readonly notify: SecretNotifier
  /** The record as committed right now. */
  getSecret(): Secret
  commit(next: Secret): void
  /** The running protocol instance, or null before the secret has started. */
  instance(): ProtocolInstance | null
  /** Serialise a call on the instance — see `SecretRuntime.withLock`. */
  withLock<T>(fn: () => Promise<T>): Promise<T>
  /** Fold one event into `current`, as the drain would. */
  fold(current: Secret, event: DeRecEvent): Secret
  /**
   * Rebind the secret to an instance the command built. Restore and adoption
   * both rebuild state under the recovered `secret_id` in a fresh instance.
   */
  adoptInstance(instance: ProtocolInstance): void
  /**
   * The secret's retention policy, for every instance a command builds — see
   * `secret/keepVersion.ts`. Read from the record at the moment a round asks,
   * so an instance built mid-restore answers for the record it ends up under.
   */
  readonly keepVersion: KeepVersionSource
}

/** Adoption can also block the secret. */
export interface AdoptionContext extends CommandContext {
  block(failure: RestoreFailure): void
}
