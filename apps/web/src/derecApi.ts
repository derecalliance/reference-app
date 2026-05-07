
// ── Config ────────────────────────────────────────────────────────────────────

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:5000'

// ── Polled mailbox message ────────────────────────────────────────────────────

export interface MailboxMessage {
  /** Raw DeRec wire bytes to feed to DeRecProtocol.process(). */
  bytes: Uint8Array
}

// ── Binary transport ──────────────────────────────────────────────────────────

/**
 * Delivers a raw protobuf-encoded DeRec wire message to an actor's transport URI.
 * This is the implementation used by the DeRecProtocolWasm Transport adapter.
 */
export async function sendMessage(uri: string, message: Uint8Array): Promise<void> {
  const res = await fetch(uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: message as unknown as BodyInit,
  })

  if (!res.ok) {
    throw new Error(`Failed to deliver message to ${uri}: ${res.status} ${res.statusText}`)
  }
}

/**
 * Polls an actor's mailbox and returns all pending wire messages, draining the
 * queue.  Each message's `bytes` field is ready to pass to
 * `DeRecProtocolWasm.process()`.
 */
export async function pollMailbox(
  sessionId: string,
  role: 'owners' | 'participants',
  actorId: string,
): Promise<MailboxMessage[]> {
  const res = await fetch(
    `${API_BASE}/derec/sessions/${sessionId}/${role}/${actorId}/mailbox`,
  )

  if (!res.ok) {
    throw new Error(`Failed to poll mailbox: ${res.status} ${res.statusText}`)
  }

  const body = (await res.json()) as { messages: { data: string }[] }
  return body.messages.map(m => ({ bytes: fromBase64Url(m.data) }))
}

// ── Encoding helpers ──────────────────────────────────────────────────────────

export function fromBase64Url(encoded: string): Uint8Array {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
