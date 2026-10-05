// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { MIN_PROTOCOL_TIMEOUT_SECS, type ServerDefaults } from '../config'

/** The editable numbers on the Settings pane. */
export type NumericDefault =
  | 'participantCount'
  | 'minParticipants'
  | 'recommendedParticipants'
  | 'prePairedCount'
  | 'protocolTimeoutSecs'
  | 'helperTransports'

/** One message per field that is wrong; a field absent here is fine. */
export type DefaultsErrors = Partial<Record<NumericDefault, string>>

/**
 * The most participants a pool, threshold or recommendation can name.
 *
 * The node holds every one of these counts as a `u8`, so 256 reaches it as a
 * request it refuses with a raw deserialiser message.
 */
export const MAX_PARTICIPANTS = 255

/**
 * The smallest usable threshold. The library refuses to split a secret into
 * shares any one helper could reconstruct alone (`threshold must be >= 2`), so
 * a vault created with 1 could never start.
 */
export const MIN_THRESHOLD = 2

/** Upper bound the node accepts for a protocol timeout, in seconds. */
export const MAX_PROTOCOL_TIMEOUT_SECS = 86_400

const DIGITS_ONLY = /^\d+$/

/**
 * A count field's text as a number, or `NaN` when it is not plain digits.
 *
 * `Number()` alone accepts `1e3`, `0x10` and ` 12.0 `, each of which a person
 * typing a count did not mean — and `1e3` then sailed past every check below
 * as 1000. Only decimal digits are a count.
 */
export function parseWholeNumber(text: string): number {
  const trimmed = text.trim()
  return DIGITS_ONLY.test(trimmed) ? Number(trimmed) : Number.NaN
}

export function wholeNumberError(value: number, min: number, max?: number): string | null {
  if (!Number.isFinite(value)) return 'Enter a whole number'
  if (!Number.isInteger(value)) return 'Must be a whole number'
  if (value < min) return `Must be at least ${min}`
  if (max !== undefined && value > max) return `Must be at most ${max}`
  return null
}

/** What is wrong with a vault threshold, or `null` when it is usable. */
export function thresholdError(value: number, pool?: number): string | null {
  const error = wholeNumberError(value, MIN_THRESHOLD, MAX_PARTICIPANTS)
  if (error) return error
  if (pool !== undefined && value > pool) return `Cannot exceed the pool of ${pool}`
  return null
}

/**
 * What is wrong with a draft of the protocol defaults, field by field.
 *
 * These values are written straight into provisioning requests and into every
 * new vault, and nothing downstream re-checks them: a minimum above the pool
 * size makes protecting impossible, a timeout of 0 makes every flow time out at
 * once, and a negative pool size reaches the backend as a request it refuses
 * with a status code. So they are checked here, where the field can say why.
 */
export function validateDefaults(draft: ServerDefaults): DefaultsErrors {
  const errors: DefaultsErrors = {}
  const pool = draft.participantCount

  const poolError = wholeNumberError(pool, MIN_THRESHOLD, MAX_PARTICIPANTS)
  if (poolError) errors.participantCount = poolError
  const poolKnown = poolError === null

  const minError = thresholdError(draft.minParticipants, poolKnown ? pool : undefined)
  if (minError) errors.minParticipants = minError

  const recommendedError = wholeNumberError(draft.recommendedParticipants, 1, MAX_PARTICIPANTS)
  if (recommendedError) {
    errors.recommendedParticipants = recommendedError
  } else if (
    Number.isInteger(draft.minParticipants) &&
    draft.recommendedParticipants < draft.minParticipants
  ) {
    errors.recommendedParticipants = `Cannot be below the minimum of ${draft.minParticipants}`
  } else if (poolKnown && draft.recommendedParticipants > pool) {
    errors.recommendedParticipants = `Cannot exceed the pool of ${pool}`
  }

  const prePairedError = wholeNumberError(draft.prePairedCount, 0, MAX_PARTICIPANTS)
  if (prePairedError) {
    errors.prePairedCount = prePairedError
  } else if (poolKnown && draft.prePairedCount > pool) {
    errors.prePairedCount = `Cannot exceed the pool of ${pool}`
  }

  const timeoutError = wholeNumberError(
    draft.protocolTimeoutSecs,
    MIN_PROTOCOL_TIMEOUT_SECS,
    MAX_PROTOCOL_TIMEOUT_SECS,
  )
  if (timeoutError) errors.protocolTimeoutSecs = timeoutError

  if (draft.grpcEnabled && poolKnown) {
    const { http, grpc, both } = draft.helperTransports
    const parts = [http, grpc, both]
    if (parts.some(n => wholeNumberError(n, 0) !== null)) {
      errors.helperTransports = 'Each count must be a whole number, 0 or more'
    } else if (http + grpc + both !== pool) {
      errors.helperTransports = `The three must add up to the pool of ${pool}`
    }
  }

  return errors
}

export function hasErrors(errors: DefaultsErrors): boolean {
  return Object.keys(errors).length > 0
}
