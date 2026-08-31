/**
 * A random identifier that also works on an insecure origin.
 *
 * `crypto.randomUUID` is gated on a **secure context**, which `http://` on a
 * LAN address is not. Calling it there throws `crypto.randomUUID is not a
 * function` — and because these ids are minted while building toasts and
 * console entries, the throw lands in the middle of whatever produced the
 * message rather than anywhere near the cause. Opening the app from a phone
 * failed at the setup wizard with exactly that.
 *
 * `crypto.getRandomValues` carries no such restriction, so the fallback is a
 * plain RFC 4122 v4 built from it. These ids label UI rows; nothing here is
 * protocol key material, which the library generates itself.
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()

  const bytes = crypto.getRandomValues(new Uint8Array(16))
  // Version 4, variant 1 — the two fields RFC 4122 pins.
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}
