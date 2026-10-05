// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * Turn a non-2xx backend response into an error a person can act on.
 *
 * The backend answers failures with a `{"error": "..."}` JSON body, and that
 * text is always the best explanation available — it names the field or the
 * actor that was wrong. Some failures never reach a handler, though: Axum's own
 * extractor rejections (a malformed UUID in a path or body, say) answer with a
 * short plain-text body, and a proxy in front of the node may answer with HTML.
 * Each is handled in turn, and only when nothing useful came back does the
 * message fall back to the status — phrased as what it means, not as a bare
 * number like "register owner failed: 422".
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

/**
 * The most useful explanation `res` carries: its JSON `error`, else a short
 * plain-text body, else what its status means. Never throws — a body that
 * cannot be read degrades to the status.
 */
export async function responseDetail(res: Response): Promise<string> {
  let text = ''
  try {
    text = (await res.text()).trim()
  } catch {
    text = ''
  }

  if (text !== '') {
    const fromJson = jsonError(text)
    if (fromJson !== null) return fromJson
    if (!looksLikeMarkup(text) && !looksLikeJson(text) && text.length <= MAX_TEXT_DETAIL) {
      return text
    }
  }

  const meaning = STATUS_MEANING[res.status]
  const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`
  return meaning ? `${meaning} (${status})` : `the server answered ${status}`
}

/**
 * An `Error` for a failed request, reading `"<action>: <detail>"` — e.g.
 * "Could not register the owner: claim_actor_id not found".
 */
export async function responseError(res: Response, action: string): Promise<Error> {
  return new Error(`${action}: ${await responseDetail(res)}`)
}

function jsonError(text: string): string | null {
  if (!looksLikeJson(text)) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null
    const error = (parsed as { error?: unknown }).error
    return typeof error === 'string' && error.trim() !== '' ? error.trim() : null
  } catch {
    return null
  }
}

function looksLikeJson(text: string): boolean {
  return text.startsWith('{') || text.startsWith('[')
}

function looksLikeMarkup(text: string): boolean {
  return text.startsWith('<')
}
