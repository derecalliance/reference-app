// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * Copying text, including where the modern clipboard API is unavailable.
 *
 * `navigator.clipboard` is secure-context gated, and this app is routinely
 * served over plain http on a LAN address so it can be reached from a phone.
 * There the whole object is `undefined`, so every `navigator.clipboard.write…`
 * call threw and the button did nothing at all — no copy, no error, no clue.
 * That is the same origin restriction that withholds the camera, except the
 * camera path says so and this one did not.
 *
 * The fallback is the pre-clipboard-API technique: a throwaway textarea, a
 * selection, and `document.execCommand('copy')`. Deprecated, but it works on
 * insecure origins, which is exactly where the modern API does not.
 */

/** Copy `text`, reporting whether it actually happened. */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied, or a context that advertises the API but refuses
      // to use it. The fallback below may still work, so this is not the end.
    }
  }
  return legacyCopy(text)
}

/**
 * The pre-clipboard-API path: select text in a detached node and copy it.
 *
 * The node is positioned off-screen rather than hidden — `display: none` and
 * `visibility: hidden` are not selectable, so the copy would silently produce
 * nothing. Any selection the user already had is restored afterwards, since
 * clobbering it is a visible side effect of an action that claims to copy.
 */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false

  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.top = '0'
  field.style.left = '-9999px'
  document.body.appendChild(field)

  const selection = document.getSelection()
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

  let copied = false
  try {
    field.select()
    copied = typeof document.execCommand === 'function' && document.execCommand('copy')
  } catch {
    copied = false
  } finally {
    document.body.removeChild(field)
    if (previous && selection) {
      selection.removeAllRanges()
      selection.addRange(previous)
    }
  }

  return copied
}
