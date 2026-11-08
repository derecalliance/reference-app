// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

// Single front-end protocol configuration.
//
// Configuration is owned by the front end and sent to the backend when
// provisioning actors. The protocol constants here (timeout, unpair
// acknowledgement, auto-accept, authentication method) are the app's defaults
// for every secret — see `SECRET_CONFIG_DEFAULTS`. The pool constants are the
// last-resort fallbacks used when the operator-supplied defaults
// (`GET /api/v1/config`) cannot be fetched.

/**
 * General protocol timeout, in **seconds**. The one timeout the wizard exposes:
 *
 * - Library (passive): fed to the builder as `inbound_message_secs` — the
 *   staleness boundary for inbound envelopes, i.e. the replay-defence window.
 *   The library splits its other waits out separately (`sharing_round`,
 *   `unpair_ack`, `expired_channels`) because those are *liveness* budgets
 *   rather than a security boundary, and this app leaves them at the library's
 *   defaults instead of inheriting this number: a five-minute wait on one
 *   unreachable replica is five minutes of a dialog that looks hung.
 *   `expired_channels` is disabled outright and driven from the page's own
 *   tick — see `PENDING_CHANNEL_TTL_SECS`.
 * - App (active): the FE wall-clock watchdog and all FE auto-reject /
 *   pairing-wait timers use this same value as their deadline.
 *
 * The app's default for every secret (`SECRET_CONFIG_DEFAULTS`); changed per
 * secret in the setup wizard and on the owner's Settings tab.
 */
export const DEFAULT_PROTOCOL_TIMEOUT_SECS = 30

/**
 * Lowest protocol timeout the app accepts, in seconds — on a secret's Settings
 * tab and in the wizard's stepper alike. Below this a handshake or a share round cannot finish
 * even against a local node, so every flow would time out on its own latency.
 */
export const MIN_PROTOCOL_TIMEOUT_SECS = 10

/** Highest protocol timeout the app accepts, in seconds — what the node accepts too. */
export const MAX_PROTOCOL_TIMEOUT_SECS = 86_400

/** Resolve a (possibly missing) seconds value to milliseconds. */
export function protocolTimeoutMs(secs: number | undefined | null): number {
  const s = secs && secs > 0 ? secs : DEFAULT_PROTOCOL_TIMEOUT_SECS
  return s * 1000
}

/**
 * How the app decides that two pairing channels belong to the same user — an
 * **app-level** concern (the DeRec protocol itself is identity-blind). This
 * choice drives only FE behavior.
 *
 * - `user`: the helper manually links channels (today's flow), with an in-modal
 *   atomic "accept + link" path during incoming pairing.
 * - `application`: future automatic linking via app-provided identity. Shown in
 *   the secret's Settings tab but not yet selectable.
 */
export type AuthenticationMethod = 'user' | 'application'

export const DEFAULT_AUTHENTICATION_METHOD: AuthenticationMethod = 'user'

/**
 * Protocol-level acknowledgement policy for the unpair flow. Set per secret on
 * its Settings tab, passed to the WASM `DeRecProtocol` constructor, and sent to
 * the backend with each provisioning request so backend-run actors agree.
 *
 * - `required`: the initiator keeps local state until the peer ACKs or the
 *   configured timeout elapses.
 * - `not_required` (default): fire-and-forget — state is dropped immediately
 *   on `start(Unpair)` and any later response is ignored.
 */
export type UnpairAck = 'required' | 'not_required'

export const DEFAULT_UNPAIR_ACK: UnpairAck = 'not_required'

/**
 * FE-only UI preference: whether incoming Unpair requests from a peer are
 * auto-accepted or surfaced as a confirmation modal. Not part of the protocol —
 * purely a UI knob persisted with the rest of this owner's config.
 */
export const DEFAULT_AUTO_ACCEPT_UNPAIR_REQUESTS = true

/**
 * FE-only UI preferences for a secret acting as a helper: whether a peer's
 * request to store a share, or to verify one, is answered outright or shown as
 * a confirmation dialog first. Answering outright is the default; a secret's
 * owner who wants to see each request turns it off on the Settings tab.
 */
export const DEFAULT_AUTO_ACCEPT_STORE_SHARE_REQUESTS = true
export const DEFAULT_AUTO_ACCEPT_VERIFY_SHARE_REQUESTS = true

/** Fallback participant count for the setup wizard. */
export const DEFAULT_PARTICIPANT_COUNT = 7
/** Fallback count of participants to auto-pair (testing shortcut). */
export const DEFAULT_PRE_PAIRED_COUNT = 3
/** Fallback minimum paired participants required to protect a secret. */
export const DEFAULT_MIN_PARTICIPANTS = 3
/** Fallback recommended paired participants. */
export const DEFAULT_RECOMMENDED_PARTICIPANTS = 5

/**
 * Starting values for the setup wizard's helper pool, and what the node runs,
 * as served by the backend's `GET /api/v1/config`. No protocol settings: those
 * are each secret's, starting from `SECRET_CONFIG_DEFAULTS`.
 *
 * The app ships as a Docker image, so an operator can mount a config file to
 * change what a developer sees on first run instead of making them retype the
 * same values every time. These are only defaults — the wizard remains fully
 * editable, and whatever the user settles on is what gets sent to the backend.
 */
export interface ServerDefaults {
  participantCount: number
  prePairedCount: number
  minParticipants: number
  recommendedParticipants: number
  /** Prefills the wizard's transport breakdown for the helper pool. */
  helperTransports: { http: number; grpc: number; both: number }
  /** Whether the backend runs the gRPC ingress listener at all. */
  grpcEnabled: boolean
  /** Whether the backend dials gRPC on a browser owner's behalf via `/derec/relay`. */
  grpcRelayEnabled: boolean
}

export const FALLBACK_SERVER_DEFAULTS: ServerDefaults = {
  participantCount: DEFAULT_PARTICIPANT_COUNT,
  prePairedCount: DEFAULT_PRE_PAIRED_COUNT,
  minParticipants: DEFAULT_MIN_PARTICIPANTS,
  recommendedParticipants: DEFAULT_RECOMMENDED_PARTICIPANTS,
  helperTransports: { http: DEFAULT_PARTICIPANT_COUNT, grpc: 0, both: 0 },
  grpcEnabled: true,
  grpcRelayEnabled: true,
}

/** Wire shape of `GET /api/v1/config` — snake_case, mirroring the backend's TOML keys. */
export interface ServerDefaultsDto {
  participant_count: number
  pre_paired_count: number
  min_participants: number
  recommended_participants: number
  helper_transports: { http: number; grpc: number; both: number }
  grpc_enabled: boolean
  grpc_relay_enabled: boolean
}

/**
 * Map the wire payload onto the FE shape, substituting the fallback for any
 * field that is missing or not a usable number.
 *
 * Defensive because these values seed a wizard the user then acts on: a `NaN`
 * participant count would surface as a broken stepper rather than an error.
 */
export function toServerDefaults(dto: Partial<ServerDefaultsDto> | null | undefined): ServerDefaults {
  const count = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback

  const helperTransports = (
    value: unknown,
    fallback: ServerDefaults['helperTransports'],
  ): ServerDefaults['helperTransports'] => {
    if (typeof value !== 'object' || value === null) return fallback
    const v = value as Partial<Record<'http' | 'grpc' | 'both', unknown>>
    return {
      http: count(v.http, fallback.http),
      grpc: count(v.grpc, fallback.grpc),
      both: count(v.both, fallback.both),
    }
  }

  return {
    participantCount: count(dto?.participant_count, FALLBACK_SERVER_DEFAULTS.participantCount),
    prePairedCount: count(dto?.pre_paired_count, FALLBACK_SERVER_DEFAULTS.prePairedCount),
    minParticipants: count(dto?.min_participants, FALLBACK_SERVER_DEFAULTS.minParticipants),
    recommendedParticipants: count(
      dto?.recommended_participants,
      FALLBACK_SERVER_DEFAULTS.recommendedParticipants,
    ),
    helperTransports: helperTransports(
      dto?.helper_transports,
      FALLBACK_SERVER_DEFAULTS.helperTransports,
    ),
    grpcEnabled:
      typeof dto?.grpc_enabled === 'boolean'
        ? dto.grpc_enabled
        : FALLBACK_SERVER_DEFAULTS.grpcEnabled,
    grpcRelayEnabled:
      typeof dto?.grpc_relay_enabled === 'boolean'
        ? dto.grpc_relay_enabled
        : FALLBACK_SERVER_DEFAULTS.grpcRelayEnabled,
  }
}
