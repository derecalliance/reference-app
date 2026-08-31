// Single front-end protocol configuration.
//
// Configuration is owned by the front end: each browser context picks its own
// settings in the setup wizard and sends them to the backend when provisioning
// actors. The constants here are the last-resort fallbacks used when the
// operator-supplied defaults (`GET /config`) cannot be fetched.

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
 * User-configurable in the setup wizard. This is the fallback default.
 */
export const DEFAULT_PROTOCOL_TIMEOUT_SECS = 300

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
 *   the wizard for now but not yet selectable.
 */
export type AuthenticationMethod = 'user' | 'application'

export const DEFAULT_AUTHENTICATION_METHOD: AuthenticationMethod = 'user'

export function normalizeAuthenticationMethod(
  value: string | undefined | null,
): AuthenticationMethod {
  return value === 'application' ? 'application' : 'user'
}

/**
 * Protocol-level acknowledgement policy for the unpair flow. Chosen in the
 * setup wizard, passed to the WASM `DeRecProtocol` constructor, and sent to the
 * backend with each provisioning request so backend-run actors agree.
 *
 * - `required` (default): the initiator keeps local state until the peer ACKs
 *   or the configured timeout elapses.
 * - `not_required`: fire-and-forget — state is dropped immediately on
 *   `start(Unpair)` and any later response is ignored.
 */
export type UnpairAck = 'required' | 'not_required'

export const DEFAULT_UNPAIR_ACK: UnpairAck = 'required'

export function normalizeUnpairAck(value: string | undefined | null): UnpairAck {
  return value === 'not_required' ? 'not_required' : 'required'
}

/**
 * FE-only UI preference: whether incoming Unpair requests from a peer are
 * auto-accepted or surfaced as a confirmation modal. Not part of the protocol —
 * purely a UI knob persisted with the rest of this owner's config.
 */
export const DEFAULT_AUTO_ACCEPT_UNPAIR_REQUESTS = true

/** Fallback participant count for the setup wizard. */
export const DEFAULT_PARTICIPANT_COUNT = 7
/** Fallback count of participants to auto-pair (testing shortcut). */
export const DEFAULT_PRE_PAIRED_COUNT = 3
/** Fallback minimum paired participants required to protect a secret. */
export const DEFAULT_MIN_PARTICIPANTS = 3
/** Fallback recommended paired participants. */
export const DEFAULT_RECOMMENDED_PARTICIPANTS = 5

/**
 * Starting values for the setup wizard, as served by the backend's `GET /config`.
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
  protocolTimeoutSecs: number
  authenticationMethod: AuthenticationMethod
  unpairAck: UnpairAck
  autoAcceptUnpairRequests: boolean
}

export const FALLBACK_SERVER_DEFAULTS: ServerDefaults = {
  participantCount: DEFAULT_PARTICIPANT_COUNT,
  prePairedCount: DEFAULT_PRE_PAIRED_COUNT,
  minParticipants: DEFAULT_MIN_PARTICIPANTS,
  recommendedParticipants: DEFAULT_RECOMMENDED_PARTICIPANTS,
  protocolTimeoutSecs: DEFAULT_PROTOCOL_TIMEOUT_SECS,
  authenticationMethod: DEFAULT_AUTHENTICATION_METHOD,
  unpairAck: DEFAULT_UNPAIR_ACK,
  autoAcceptUnpairRequests: DEFAULT_AUTO_ACCEPT_UNPAIR_REQUESTS,
}

/** Wire shape of `GET /config` — snake_case, mirroring the backend's TOML keys. */
export interface ServerDefaultsDto {
  participant_count: number
  pre_paired_count: number
  min_participants: number
  recommended_participants: number
  protocol_timeout_secs: number
  authentication_method: string
  unpair_ack: string
  auto_accept_unpair_requests: boolean
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

  return {
    participantCount: count(dto?.participant_count, FALLBACK_SERVER_DEFAULTS.participantCount),
    prePairedCount: count(dto?.pre_paired_count, FALLBACK_SERVER_DEFAULTS.prePairedCount),
    minParticipants: count(dto?.min_participants, FALLBACK_SERVER_DEFAULTS.minParticipants),
    recommendedParticipants: count(
      dto?.recommended_participants,
      FALLBACK_SERVER_DEFAULTS.recommendedParticipants,
    ),
    protocolTimeoutSecs: count(
      dto?.protocol_timeout_secs,
      FALLBACK_SERVER_DEFAULTS.protocolTimeoutSecs,
    ),
    authenticationMethod: normalizeAuthenticationMethod(dto?.authentication_method),
    unpairAck: normalizeUnpairAck(dto?.unpair_ack),
    autoAcceptUnpairRequests:
      typeof dto?.auto_accept_unpair_requests === 'boolean'
        ? dto.auto_accept_unpair_requests
        : FALLBACK_SERVER_DEFAULTS.autoAcceptUnpairRequests,
  }
}
