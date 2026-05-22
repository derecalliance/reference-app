// Single front-end protocol configuration.

/**
 * General protocol timeout, in **seconds**. The one timeout the whole app uses:
 *
 * - Library (passive): fed to the WASM `DeRecProtocol` constructor as
 *   `timeout_in_secs`; `process()` uses it to discard expired messages /
 *   pending channels / stale sharing rounds.
 * - App (active): the FE wall-clock watchdog and all FE auto-reject /
 *   pairing-wait timers use this same value as their deadline.
 *
 * User-configurable per session (create-session wizard). This is the default.
 */
export const DEFAULT_PROTOCOL_TIMEOUT_SECS = 300

/** Resolve a (possibly missing) per-session seconds value to milliseconds. */
export function protocolTimeoutMs(secs: number | undefined | null): number {
  const s = secs && secs > 0 ? secs : DEFAULT_PROTOCOL_TIMEOUT_SECS
  return s * 1000
}

/**
 * How the app decides that two pairing channels belong to the same user — an
 * **app-level** concern (the DeRec protocol itself is identity-blind). This
 * choice drives only FE behavior; the backend stores it and echoes it back so
 * every joiner observes the same setting.
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
 * Protocol-level acknowledgement policy for the unpair flow. Chosen at session
 * creation, echoed by the backend to every joiner, and passed to the WASM
 * `DeRecProtocol` constructor.
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
 * auto-accepted or surfaced as a confirmation modal. Not part of the protocol
 * and not echoed by the backend — purely a per-session UI knob persisted with
 * the rest of the session config in localStorage.
 */
export const DEFAULT_AUTO_ACCEPT_UNPAIR_REQUESTS = true
