// ── Config ────────────────────────────────────────────────────────────────────

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:5000'

// ── Wire types (BE contract) ──────────────────────────────────────────────────

interface BETransport {
  protocol: 'https'
  uri: string
}

interface BEActor {
  id: string
  role: 'owner' | 'participant' | 'replica'
  name: string
  transport: BETransport
}

interface CreateSessionResponse {
  session_id: string
  actors: BEActor[]
}

interface BEActorWithStatus extends BEActor {
  channel_id?: string
  pending_recovery_channel_id?: string
  shared_key?: string
  disabled?: boolean
  browser_managed?: boolean
  replica_confirmed?: boolean
}

/** GET /sessions/{id} returns actors enriched with pairing status. */
export interface GetSessionResponse {
  session_id: string
  actors: BEActorWithStatus[]
}

export interface JoinSessionResponse {
  session_id: string
  actor: BEActor
  actors: BEActorWithStatus[]
}

// ── Session ───────────────────────────────────────────────────────────────────

export interface CreateSessionParams {
  ownerName: string
  additionalParticipants: number
}

// ── Participant contact DTO (matches BE ContactMessageDto) ────────────────────────

export interface ContactMessageDto {
  channel_id: string
  nonce: string
  transport_protocol: { uri: string; protocol: string }
  mlkem_encapsulation_key: string
  ecies_public_key: string
}

export async function apiCreateParticipantContact(
  sessionId: string,
  participantId: string,
): Promise<ContactMessageDto> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/participants/${participantId}/create-contact`, {
    method: 'POST',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `create-contact failed: ${res.status}`)
  }
  return res.json() as Promise<ContactMessageDto>
}

export async function apiStartParticipantPairing(
  sessionId: string,
  participantId: string,
  ownerContact: ContactMessageDto,
): Promise<{ channel_id: string }> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/participants/${participantId}/pair`, {
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

// ── Participant status toggle ────────────────────────────────────────────────────

export async function apiToggleParticipantStatus(
  sessionId: string,
  participantId: string,
  disabled?: boolean,
): Promise<{ disabled: boolean }> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(participantId)}/toggle-status`, {
    method: 'POST',
    ...(disabled !== undefined && {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled }),
    }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `toggle-status failed: ${res.status}`)
  }
  return res.json() as Promise<{ disabled: boolean }>
}

// ── Channel association (recovery) ───────────────────────────────────────────

export async function apiAssociateChannel(
  sessionId: string,
  participantId: string,
  oldChannelId: string,
  newChannelId: string,
): Promise<{ migrated_shares: number }> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/participants/${participantId}/associate-channel`, {
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

// ── Add participant ──────────────────────────────────────────────────────────────

export interface AddParticipantResponse {
  id: string
  role: 'participant'
  name: string
  transport: BETransport
}

export async function apiAddParticipant(
  sessionId: string,
  name: string,
): Promise<AddParticipantResponse> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/participants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `add-participant failed: ${res.status}`)
  }
  return res.json() as Promise<AddParticipantResponse>
}

// ── Replica endpoints ───────────────────────────────────────────────────────

export interface AddReplicaResponse {
  id: string
  role: 'replica'
  name: string
  transport: BETransport
}

export async function apiAddReplica(
  sessionId: string,
  name: string,
): Promise<AddReplicaResponse> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/replicas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `add-replica failed: ${res.status}`)
  }
  return res.json() as Promise<AddReplicaResponse>
}

export async function apiCreateReplicaContact(
  sessionId: string,
  replicaId: string,
): Promise<ContactMessageDto> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/replicas/${replicaId}/create-contact`, {
    method: 'POST',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `replica create-contact failed: ${res.status}`)
  }
  return res.json() as Promise<ContactMessageDto>
}

export async function apiStartReplicaPairing(
  sessionId: string,
  replicaId: string,
  ownerContact: ContactMessageDto,
): Promise<{ channel_id: string }> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/replicas/${replicaId}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ownerContact),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `replica pair failed: ${res.status}`)
  }
  return res.json() as Promise<{ channel_id: string }>
}

export async function apiGetReplicaFingerprint(
  sessionId: string,
  replicaId: string,
): Promise<{ fingerprint: string }> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/replicas/${replicaId}/fingerprint`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `get fingerprint failed: ${res.status}`)
  }
  return res.json() as Promise<{ fingerprint: string }>
}

export async function apiConfirmReplicaFingerprint(
  sessionId: string,
  replicaId: string,
  channelId: string,
  fingerprint: string,
): Promise<{ confirmed: boolean }> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/replicas/${replicaId}/confirm-fingerprint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel_id: channelId, fingerprint }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `confirm fingerprint failed: ${res.status}`)
  }
  return res.json() as Promise<{ confirmed: boolean }>
}

export async function apiToggleReplicaStatus(
  sessionId: string,
  replicaId: string,
  disabled?: boolean,
): Promise<{ disabled: boolean }> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/replicas/${encodeURIComponent(replicaId)}/toggle-status`, {
    method: 'POST',
    ...(disabled !== undefined && {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled }),
    }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `replica toggle-status failed: ${res.status}`)
  }
  return res.json() as Promise<{ disabled: boolean }>
}

// ── Session creation ────────────────────────────────────────────────────────

export async function apiCreateSession(params: CreateSessionParams): Promise<CreateSessionResponse> {
  const res = await fetch(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: params.ownerName,
      additional_participants: params.additionalParticipants,
    }),
  })

  if (!res.ok) {
    throw new Error(`Failed to create session: ${res.status} ${res.statusText}`)
  }

  return res.json() as Promise<CreateSessionResponse>
}

// ── Join session ────────────────────────────────────────────────────────────

export async function apiJoinSession(
  sessionId: string,
  name: string,
  prePairedCount?: number,
): Promise<JoinSessionResponse> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, pre_paired_count: prePairedCount }),
  })
  if (res.status === 404) {
    throw new Error('Session not found. It may have expired or the server may have restarted.')
  }
  if (!res.ok) {
    throw new Error(`Failed to join session: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<JoinSessionResponse>
}

// ── Browser-managed participant contact signaling ───────────────────────────

export async function apiPostBrowserContact(
  sessionId: string,
  participantId: string,
  contactJson: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/participants/${participantId}/browser-contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: contactJson,
  })
  if (!res.ok) {
    throw new Error(`post browser-contact failed: ${res.status}`)
  }
}

export async function apiGetBrowserContact(
  sessionId: string,
  participantId: string,
): Promise<ContactMessageDto | null> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/participants/${participantId}/browser-contact`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`get browser-contact failed: ${res.status}`)
  }
  return res.json() as Promise<ContactMessageDto>
}
