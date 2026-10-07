// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { MIN_PROTOCOL_TIMEOUT_SECS, type ServerDefaults } from '../config'
import type { VaultConfigOverrides } from '../types'

/**
 * The settings an owner can change in the wizard, holding only what the user
 * actually moved.
 *
 * Kept apart from the defaults rather than copied into one form object. The
 * defaults arrive asynchronously (`GET /api/v1/config`, then this browser's Settings
 * overrides on top), and a form seeded from the built-in fallback before they
 * land either clobbered what the user typed when they did, or — guarded by "only
 * while the name is empty" — kept the fallback for good: a vault created with a
 * threshold of 3 when Settings said 2, and an override for a timeout nobody
 * chose. Holding the edits separately makes both impossible: the shown value is
 * always `edit ?? default`, whenever the default turns up.
 */
export interface OwnerEdits {
  protocolTimeoutSecs?: number
  prePairedCount?: number
}

/** What the wizard shows and will use: the defaults, with the user's edits on top. */
export interface OwnerSettings {
  protocolTimeoutSecs: number
  prePairedCount: number
}

/** Lowest protocol timeout the wizard offers, in seconds — the app-wide floor. */
export const MIN_WIZARD_TIMEOUT_SECS = MIN_PROTOCOL_TIMEOUT_SECS
/** How far one press of the timeout stepper moves it, in seconds. */
export const TIMEOUT_STEP_SECS = 30

export function ownerSettings(defaults: ServerDefaults, edits: OwnerEdits): OwnerSettings {
  return {
    protocolTimeoutSecs: edits.protocolTimeoutSecs ?? defaults.protocolTimeoutSecs,
    prePairedCount: edits.prePairedCount ?? defaults.prePairedCount,
  }
}

/**
 * What the new vault overrides: only a setting the user edited *and* left
 * different from the effective default.
 *
 * Recording an untouched value would freeze it — a later Settings edit or node
 * reconfiguration would never reach this vault. See `VaultConfigOverrides`.
 */
export function overridesFromEdits(
  edits: OwnerEdits,
  defaults: ServerDefaults,
): VaultConfigOverrides {
  const overrides: VaultConfigOverrides = {}
  if (
    edits.protocolTimeoutSecs !== undefined &&
    edits.protocolTimeoutSecs !== defaults.protocolTimeoutSecs
  ) {
    overrides.protocolTimeoutSecs = edits.protocolTimeoutSecs
  }
  return overrides
}

/**
 * How many participants setup will pre-pair: the requested count, capped at
 * those online.
 *
 * The one rule for both what the stepper displays and what setup uses, so the
 * two cannot disagree — they used to, while the node was still being probed:
 * the stepper showed 0 against an unknown ceiling and setup then pre-paired the
 * hidden default of 3.
 */
export function prePairTarget(requested: number, online: number): number {
  return Math.max(0, Math.min(requested, online))
}

/**
 * The longest name the node accepts, in Unicode code points — what Rust's
 * `str::chars().count()` counts on the trimmed name (`MAX_NAME_CHARS`).
 */
export const MAX_VAULT_NAME_CHARS = 64

/**
 * A name as it is sent: NFC-normalised and trimmed.
 *
 * The node counts code points, so "é" typed as `e` + a combining accent counts
 * twice — QA's 40-character name of decomposed letters was refused as 80.
 * Composing first means the count the node makes is the count a person sees.
 */
export function normalizeVaultName(raw: string): string {
  return raw.normalize('NFC').trim()
}

/** What is wrong with a vault name, or `null` when the node will accept it. */
export function vaultNameError(raw: string): string | null {
  const name = normalizeVaultName(raw)
  if (name === '') return 'Enter a name'
  const length = Array.from(name).length
  if (length > MAX_VAULT_NAME_CHARS) {
    return `At most ${MAX_VAULT_NAME_CHARS} characters (this is ${length})`
  }
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return 'Remove the control characters'
  return null
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether `value` has the shape of an actor id — the backend's actor ids are UUIDs. */
export function isActorId(value: string): boolean {
  return UUID_PATTERN.test(value.trim())
}

/**
 * How recently an actor's mailbox must have been drained for a claim to warn
 * that another browser is still driving it: two idle poll intervals and then
 * some, so one slow poll does not make a live tab look abandoned.
 */
export const CLAIM_ACTIVE_WINDOW_MS = 30_000

/**
 * Whether the actor last polled recently enough that it is probably open in
 * another browser right now.
 *
 * `false` for anything unknown — no timestamp, an unparseable one, or a node
 * that does not report it — because the warning is a guard, not a gate, and a
 * missing signal must not invent a conflict. A timestamp slightly in the
 * future (clock skew between node and browser) still counts as recent.
 */
export function actorAppearsActive(
  lastPolledAt: string | null | undefined,
  now: number,
  windowMs: number = CLAIM_ACTIVE_WINDOW_MS,
): boolean {
  if (!lastPolledAt) return false
  const at = Date.parse(lastPolledAt)
  if (Number.isNaN(at)) return false
  return now - at < windowMs
}
