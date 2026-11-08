// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { parseWholeNumber, wholeNumberError } from '../admin/defaultsValidation'
import { MAX_PROTOCOL_TIMEOUT_SECS, MIN_PROTOCOL_TIMEOUT_SECS } from '../config'
import type { SecretConfig } from '../types'
import {
  DEFAULT_RETAINED_VERSIONS,
  publishPolicyProblems,
  type HelperRetention,
  type ProofCleanup,
  type PublishPolicy,
} from './publishPolicy'
import { scheduleProblem, type ScheduleUnit, type VerificationSchedule } from './verificationSchedule'

/** A verification schedule as the tab edits it — `since` is the runtime's. */
export type ScheduleChoice = Pick<VerificationSchedule, 'every' | 'unit'>

export type RetentionMode = HelperRetention['mode']
export type CleanupChoice = 'manual' | 'retention' | 'lastN'

/**
 * Everything the Settings tab edits, as the form holds it: numbers as the text
 * typed, so a half-typed value stays on screen while it is invalid.
 */
export interface SecretSettingsDraft {
  protocol: SecretConfig
  timeoutText: string
  retentionMode: RetentionMode
  cleanup: CleanupChoice
  cleanupN: string
  verifyAuto: boolean
  verifyEvery: string
  verifyUnit: ScheduleUnit
}

/** What saving the tab stores: a secret's settings, resolved. */
export interface SecretSettingsValues {
  protocol: SecretConfig
  policy: PublishPolicy
  /** The automatic verification schedule, or `null` when verification is by hand only. */
  schedule: ScheduleChoice | null
}

/** A field that cannot be saved as typed, with why. */
export interface SecretSettingsProblems {
  timeout?: string
  cleanupN?: string
  verifyEvery?: string
}

/** The form's starting point: what the secret is saved with. */
export function draftOf(values: SecretSettingsValues): SecretSettingsDraft {
  const { protocol, policy, schedule } = values
  return {
    protocol,
    timeoutText: String(protocol.protocolTimeoutSecs),
    retentionMode: policy.helperRetention.mode,
    cleanup: policy.proofCleanup.mode === 'manual' ? 'manual' : policy.proofCleanup.criterion,
    cleanupN: String(
      policy.proofCleanup.mode === 'auto' && policy.proofCleanup.criterion === 'lastN'
        ? policy.proofCleanup.n
        : DEFAULT_RETAINED_VERSIONS,
    ),
    verifyAuto: schedule !== null,
    verifyEvery: String(schedule?.every ?? 1),
    verifyUnit: schedule?.unit ?? 'days',
  }
}

/**
 * The settings `draft` describes, on top of the secret's current `policy` (the
 * threshold and weights in it are the Channels tab's and pass through).
 */
export function valuesOf(draft: SecretSettingsDraft, policy: PublishPolicy): SecretSettingsValues {
  const proofCleanup: ProofCleanup =
    draft.cleanup === 'manual'
      ? { mode: 'manual' }
      : draft.cleanup === 'retention'
        ? { mode: 'auto', criterion: 'retention' }
        : { mode: 'auto', criterion: 'lastN', n: Number(draft.cleanupN) }
  return {
    protocol: { ...draft.protocol, protocolTimeoutSecs: parseWholeNumber(draft.timeoutText) },
    policy: { ...policy, helperRetention: { mode: draft.retentionMode }, proofCleanup },
    schedule: draft.verifyAuto ? { every: Number(draft.verifyEvery), unit: draft.verifyUnit } : null,
  }
}

/** What stops `draft` from being saved, field by field; empty when it can be. */
export function draftProblems(draft: SecretSettingsDraft, policy: PublishPolicy): SecretSettingsProblems {
  const values = valuesOf(draft, policy)
  const problems: SecretSettingsProblems = {}
  const timeout = wholeNumberError(
    values.protocol.protocolTimeoutSecs,
    MIN_PROTOCOL_TIMEOUT_SECS,
    MAX_PROTOCOL_TIMEOUT_SECS,
  )
  if (timeout) problems.timeout = timeout
  const cleanupN = publishPolicyProblems(values.policy).cleanupN
  if (cleanupN) problems.cleanupN = cleanupN
  const verifyEvery = values.schedule ? scheduleProblem(values.schedule.every) : null
  if (verifyEvery) problems.verifyEvery = verifyEvery
  return problems
}

/** Whether two schedules differ — saving an unchanged one must not restart its clock. */
export function scheduleChanged(a: ScheduleChoice | null, b: ScheduleChoice | null): boolean {
  return a?.every !== b?.every || a?.unit !== b?.unit
}

/** Whether two sets of settings are the same, whatever order their keys were written in. */
export function sameSettings(a: SecretSettingsValues, b: SecretSettingsValues): boolean {
  return canonical(a) === canonical(b)
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)))
      : v,
  )
}
