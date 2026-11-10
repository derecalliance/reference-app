// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import {
  DEFAULT_AUTHENTICATION_METHOD,
  DEFAULT_AUTO_ACCEPT_STORE_SHARE_REQUESTS,
  DEFAULT_AUTO_ACCEPT_UNPAIR_REQUESTS,
  DEFAULT_AUTO_ACCEPT_VERIFY_SHARE_REQUESTS,
  DEFAULT_PROTOCOL_TIMEOUT_SECS,
  DEFAULT_UNPAIR_ACK,
  type ServerDefaults,
} from './config'
import type { SecretConfig, SecretConfigOverrides } from './types'
import { fitTransportsTo } from './transportMix'

/**
 * The node-level defaults this browser may override: the helper pool a node is
 * provisioned with, and the counts the setup wizard starts from.
 */
export type PoolDefaultKey =
  | 'participantCount'
  | 'prePairedCount'
  | 'minParticipants'
  | 'recommendedParticipants'
  | 'helperTransports'

export const POOL_DEFAULT_KEYS: readonly PoolDefaultKey[] = [
  'participantCount',
  'prePairedCount',
  'minParticipants',
  'recommendedParticipants',
  'helperTransports',
]

/**
 * Browser-local overrides for the node's pool defaults.
 *
 * The backend resolves its own set at boot — from its config file and `DEREC_*`
 * variables — and serves them from `GET /api/v1/config`. It holds no policy about them
 * beyond that: the values a node actually runs with are whatever the front end
 * sends on each provisioning request. That is what makes these editable here
 * without an endpoint to write them.
 *
 * Only the pool: a secret's protocol settings are its own (`SecretConfig`, set
 * on the owner's Settings tab) and start from the app's defaults, never from
 * the node or this browser.
 *
 * Stored as a *partial* rather than a full copy, deliberately. Freezing a whole
 * snapshot would mean a node reconfigured and restarted still handed a
 * developer the values it had when they last opened Settings, with nothing on
 * screen explaining why. An override names only what it changes; everything
 * else keeps following the server.
 */
export type DefaultOverrides = Partial<Pick<ServerDefaults, PoolDefaultKey>>

const STORAGE_KEY = 'derec.protocolDefaults'

/** The overrides this browser has stored, or none. */
export function loadDefaultOverrides(): DefaultOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return {}

    const parsed: unknown = JSON.parse(raw)
    // A non-object here is a stale or hand-edited value. Spreading a string
    // would produce indexed character keys rather than failing, so the shape is
    // checked rather than trusted.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {}
    }
    // Keys outside the pool are left by older builds, which also kept a
    // secret's protocol settings here; they are no longer read.
    const stored = parsed as Record<string, unknown>
    const overrides: Record<string, unknown> = {}
    for (const key of POOL_DEFAULT_KEYS) {
      if (key in stored) overrides[key] = stored[key]
    }
    return overrides as DefaultOverrides
  } catch {
    // Unparseable, or storage unavailable. This is a convenience layer; losing
    // it must not take a screen down.
    return {}
  }
}

export function persistDefaultOverrides(overrides: DefaultOverrides): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
  } catch {
    // Safari in private mode throws rather than no-opping.
  }
}

export function clearDefaultOverrides(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // As above.
  }
}

/**
 * What to actually provision with: the node's values, with any local pool
 * overrides on top.
 *
 * The single place that merge happens, so the setup wizard, the Participants
 * pane and the Settings pane cannot disagree about what a default is. The
 * protocol fields stay the node's: they are what the node's own helpers are
 * provisioned with.
 */
export function effectiveDefaults(server: ServerDefaults): ServerDefaults {
  const merged: ServerDefaults = {
    ...server,
    ...loadDefaultOverrides(),
    // What the node runs is a fact about the node, not a preference: an
    // override saved against another configuration must not claim a listener
    // or relay this node does not have.
    grpcEnabled: server.grpcEnabled,
    grpcRelayEnabled: server.grpcRelayEnabled,
  }

  // A node without the gRPC listener can only provision HTTP helpers, and it
  // refuses a request naming any other ("gRPC helpers requested but
  // grpc_enabled is false"). A breakdown saved while it had one — or the
  // node's own, reconfigured — would otherwise break every provisioning
  // request, with the fields that hold it hidden on Settings.
  const transports = merged.grpcEnabled
    ? merged.helperTransports
    : { http: merged.participantCount, grpc: 0, both: 0 }

  // The count and the breakdown are configured separately, so a merge can
  // produce a pair that disagree — override the count alone and the breakdown
  // still carries the node's. The backend rejects that outright ("transports
  // must sum to total"), so reconciling here is what stops a perfectly
  // reasonable Settings edit from making provisioning fail.
  return {
    ...merged,
    helperTransports: fitTransportsTo(transports, merged.participantCount),
  }
}

/**
 * The protocol settings every secret starts from, defined by the app rather
 * than taken from the node: they are the defaults the app means to encourage,
 * and a secret's owner changes them for that secret alone on its Settings tab.
 */
export const SECRET_CONFIG_DEFAULTS: SecretConfig = {
  protocolTimeoutSecs: DEFAULT_PROTOCOL_TIMEOUT_SECS,
  authenticationMethod: DEFAULT_AUTHENTICATION_METHOD,
  unpairAck: DEFAULT_UNPAIR_ACK,
  autoAcceptUnpairRequests: DEFAULT_AUTO_ACCEPT_UNPAIR_REQUESTS,
  autoAcceptStoreShareRequests: DEFAULT_AUTO_ACCEPT_STORE_SHARE_REQUESTS,
  autoAcceptVerifyShareRequests: DEFAULT_AUTO_ACCEPT_VERIFY_SHARE_REQUESTS,
}

/**
 * What a secret actually runs with: the app's defaults with the secret's own
 * overrides on top — the only place that merge happens.
 *
 * `minParticipants` is deliberately absent. It is the Shamir threshold passed to
 * `withThreshold`, and shares already distributed depend on it, so it is
 * resolved once and frozen onto the secret record at creation. See
 * `Secret.minParticipants`.
 *
 * Every field is resolved with `??` rather than `||`: `autoAcceptUnpairRequests:
 * false` is a real choice, and `||` would silently restore the default `true`.
 */
export function resolveSecretConfig(overrides: SecretConfigOverrides): SecretConfig {
  const base = SECRET_CONFIG_DEFAULTS
  return {
    protocolTimeoutSecs: overrides.protocolTimeoutSecs ?? base.protocolTimeoutSecs,
    authenticationMethod: overrides.authenticationMethod ?? base.authenticationMethod,
    unpairAck: overrides.unpairAck ?? base.unpairAck,
    autoAcceptUnpairRequests:
      overrides.autoAcceptUnpairRequests ?? base.autoAcceptUnpairRequests,
    autoAcceptStoreShareRequests:
      overrides.autoAcceptStoreShareRequests ?? base.autoAcceptStoreShareRequests,
    autoAcceptVerifyShareRequests:
      overrides.autoAcceptVerifyShareRequests ?? base.autoAcceptVerifyShareRequests,
  }
}

/**
 * The overrides that make a secret run with `config`: only what differs from
 * the app's defaults, so a value left at its default keeps following them.
 */
export function overridesFor(config: SecretConfig): SecretConfigOverrides {
  const overrides: Record<string, unknown> = {}
  for (const key of Object.keys(config) as (keyof SecretConfig)[]) {
    if (config[key] !== SECRET_CONFIG_DEFAULTS[key]) overrides[key] = config[key]
  }
  return overrides as SecretConfigOverrides
}
