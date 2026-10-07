// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * The success envelope every `/api/v1` answer travels in:
 * `{"result": T, "timestamp": "<RFC 3339>", "request_id": "<id>"}`.
 *
 * Unwrapped here, once, so callers deal in the payload alone. Errors travel in
 * their own envelope and are read by `httpError`.
 */

/**
 * The `result` of a successful response.
 *
 * A body without a `result` member is returned whole: that is how a node from
 * before the envelope answered, and a cross-node call may still reach one.
 */
export async function readResult<T>(res: Response): Promise<T> {
  const body: unknown = await res.json()
  if (typeof body === 'object' && body !== null && !Array.isArray(body) && 'result' in body) {
    return (body as { result: T }).result
  }
  return body as T
}
