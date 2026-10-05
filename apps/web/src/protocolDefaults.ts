// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { ServerDefaults } from './config'
import type { VaultConfig, VaultConfigOverrides } from './types'
import { fitTransportsTo } from './transportMix'

/**
 * Browser-local overrides for the node's protocol defaults.
 *
 * The backend resolves its own set at boot — from its config file and `DEREC_*`
 * variables — and serves them from `GET /config`. It holds no policy about them
 * beyond that: the values a node actually runs with are whatever the front end
 * sends on each provisioning request. That is what makes these editable here
 * without an endpoint to write them.
 *
 * Stored as a *partial* rather than a full copy, deliberately. Freezing a whole
 * snapshot would mean a node reconfigured and restarted still handed a
 * developer the values it had when they last opened Settings, with nothing on
 * screen explaining why. An override names only what it changes; everything
 * else keeps following the server.
 */
export type DefaultOverrides = Partial<ServerDefaults>

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
    return parsed as DefaultOverrides
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
 * What to actually provision with: the node's values, with any local overrides
 * on top.
 *
 * The single place that merge happens, so the setup wizard, the Participants
 * pane and the Settings pane cannot disagree about what a default is.
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
 * What a vault actually runs with: the node's defaults, this browser's
 * overrides, then the vault's own — the third tier of the merge
 * [`effectiveDefaults`] performs, and the only place it happens.
 *
 * `minParticipants` is deliberately absent. It is the Shamir threshold passed to
 * `withThreshold`, and shares already distributed depend on it, so it is
 * resolved once and frozen onto the vault record at creation rather than
 * inherited live — otherwise editing a browser default would retroactively
 * change the threshold of a vault that has already published. See
 * `Vault.minParticipants`.
 *
 * Every field is resolved with `??` rather than `||`: `autoAcceptUnpairRequests:
 * false` is a real choice, and `||` would silently restore the server's `true`.
 */
export function resolveVaultConfig(
  overrides: VaultConfigOverrides,
  server: ServerDefaults,
): VaultConfig {
  const base = effectiveDefaults(server)
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
