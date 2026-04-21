// ── Config ────────────────────────────────────────────────────────────────────

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:5000'

// ── Wire types (BE contract) ──────────────────────────────────────────────────

interface BETransport {
  protocol: 'https'
  uri: string
}

interface BEActor {
  id: string
  role: 'owner' | 'helper'
  name: string
  transport: BETransport
}

interface CreateSessionResponse {
  session_id: string
  actors: BEActor[]
}

/** GET /sessions/{id} returns actors enriched with pairing status. */
export interface GetSessionResponse {
  session_id: string
  actors: (BEActor & { channel_id?: string; pending_recovery_channel_id?: string })[]
}

// ── Session ───────────────────────────────────────────────────────────────────

export interface CreateSessionParams {
  ownerName: string
  additionalHelpers: number
}

// ── Helper contact DTO (matches BE ContactMessageDto) ────────────────────────

export interface ContactMessageDto {
  channel_id: string
  nonce: string
  transport_protocol: { uri: string; protocol: string }
  mlkem_encapsulation_key: string
  ecies_public_key: string
}

export async function apiCreateHelperContact(
  sessionId: string,
  helperId: string,
): Promise<ContactMessageDto> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/helpers/${helperId}/create-contact`, {
    method: 'POST',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `create-contact failed: ${res.status}`)
  }
  return res.json() as Promise<ContactMessageDto>
}

export async function apiStartHelperPairing(
  sessionId: string,
  helperId: string,
  ownerContact: ContactMessageDto,
): Promise<{ channel_id: string }> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/helpers/${helperId}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ownerContact),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `pair failed: ${res.status}`)
  }
  return res.json() as Promise<{ channel_id: string }>
}

// ── Channel association (recovery) ───────────────────────────────────────────

export async function apiAssociateChannel(
  sessionId: string,
  helperId: string,
  oldChannelId: string,
  newChannelId: string,
): Promise<{ migrated_shares: number }> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/helpers/${helperId}/associate-channel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_channel_id: oldChannelId, new_channel_id: newChannelId }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `associate-channel failed: ${res.status}`)
  }
  return res.json() as Promise<{ migrated_shares: number }>
}

// ── Recovery ─────────────────────────────────────────────────────────────────

export async function apiClearPendingAssociations(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/pending-associations`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `clear pending associations failed: ${res.status}`)
  }
}

// ── Session ───────────────────────────────────────────────────────────────────

export async function apiGetSession(sessionId: string): Promise<GetSessionResponse> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}`)
  if (res.status === 404) {
    throw new Error('Session not found. It may have expired or the server may have restarted.')
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch session: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<GetSessionResponse>
}

export async function apiCreateSession(params: CreateSessionParams): Promise<CreateSessionResponse> {
  const res = await fetch(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      role: 'owner',
      name: params.ownerName,
      additional_helpers: params.additionalHelpers,
    }),
  })

  if (!res.ok) {
    throw new Error(`Failed to create session: ${res.status} ${res.statusText}`)
  }

  return res.json() as Promise<CreateSessionResponse>
}
