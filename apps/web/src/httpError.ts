// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * Turn a non-2xx backend response into an error a person can act on — and a
 * program can branch on.
 *
 * The backend answers every failure with its error envelope,
 * `{"error": {"code": "NOT_FOUND", "message": "..."}, "timestamp", "request_id"}`:
 * the `message` is always the best explanation available, and the `code` is
 * what callers compare against. A node from before the envelope answered
 * `{"error": "..."}`, which is still read, so a cross-node call to an older
 * peer explains itself too. A proxy in front of a node may answer with plain
 * text or HTML. Each is handled in turn, and only when nothing useful came back
 * does the message fall back to the status — phrased as what it means, not as
 * a bare number like "register owner failed: 422".
 */

/** Longest plain-text body worth quoting; anything longer is a page, not a reason. */
const MAX_TEXT_DETAIL = 300

/** What a status means to someone using the app, for when the body says nothing. */
const STATUS_MEANING: Readonly<Record<number, string>> = {
  400: 'the server rejected the request as invalid',
  404: 'the server does not know that resource',
  409: 'the request conflicts with the server’s current state',
  413: 'the request is too large for the server',
  422: 'the server could not understand the request',
  500: 'the server hit an internal error',
  502: 'a proxy in front of the server could not reach it',
  503: 'the server is not ready to answer yet',
  504: 'a proxy in front of the server timed out',
}

/** What a failed response said, as far as it said anything. */
export interface ResponseDetail {
  /** A sentence to show. Never empty. */
  message: string
  /** The envelope's machine-readable code — absent for any other body. */
  code?: string
  /** The node's id for the request, to quote in a report. */
  requestId?: string
}

/** A request the backend answered with a non-2xx status. */
export class ApiRequestError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly requestId: string | undefined

  constructor(message: string, status: number, detail: ResponseDetail) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = detail.code
    this.requestId = detail.requestId
  }
}

/**
 * Everything `res` says about why it failed: the envelope's message and code,
 * else a short plain-text body, else what its status means. Never throws — a
 * body that cannot be read degrades to the status.
 */
export async function readResponseDetail(res: Response): Promise<ResponseDetail> {
  let text = ''
  try {
    text = (await res.text()).trim()
  } catch {
    text = ''
  }

  const requestId = res.headers.get('x-request-id') ?? undefined
  if (text !== '') {
    const fromJson = jsonError(text)
    if (fromJson !== null) return { ...fromJson, requestId: fromJson.requestId ?? requestId }
    if (!looksLikeMarkup(text) && !looksLikeJson(text) && text.length <= MAX_TEXT_DETAIL) {
      return { message: text, requestId }
    }
  }

  const meaning = STATUS_MEANING[res.status]
  const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`
  return { message: meaning ? `${meaning} (${status})` : `the server answered ${status}`, requestId }
}

/** The most useful sentence `res` carries; see `readResponseDetail`. */
export async function responseDetail(res: Response): Promise<string> {
  return (await readResponseDetail(res)).message
}

/**
 * An `ApiRequestError` for a failed request, reading `"<action>: <detail>"` —
 * e.g. "Could not register the owner: claim_actor_id not found".
 */
export async function responseError(res: Response, action: string): Promise<ApiRequestError> {
  const detail = await readResponseDetail(res)
  return new ApiRequestError(`${action}: ${detail.message}`, res.status, detail)
}

/** The envelope's error, or the pre-envelope `{"error": "..."}`, or `null`. */
function jsonError(text: string): ResponseDetail | null {
  if (!looksLikeJson(text)) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) return null
    const requestId = typeof parsed.request_id === 'string' ? parsed.request_id : undefined
    const error = parsed.error
    if (typeof error === 'string') {
      return error.trim() === '' ? null : { message: error.trim(), requestId }
    }
    if (isRecord(error) && typeof error.message === 'string' && error.message.trim() !== '') {
      const code = typeof error.code === 'string' ? error.code : undefined
      return { message: error.message.trim(), code, requestId }
    }
    return null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function looksLikeJson(text: string): boolean {
  return text.startsWith('{') || text.startsWith('[')
}

function looksLikeMarkup(text: string): boolean {
  return text.startsWith('<')
}
