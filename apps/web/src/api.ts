const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:5000'

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
  shared_key?: string
  disabled?: boolean
  browser_managed?: boolean
  replica_confirmed?: boolean
}

/** GET /sessions/{id} returns actors enriched with pairing status. */
export interface GetSessionResponse {
  session_id: string
  actors: BEActorWithStatus[]
  min_participants: number
  recommended_participants: number
  protocol_timeout_secs: number
  /** App-level auth method chosen at session creation; echoed back to joiners. */
  authentication_method: 'user' | 'application'
  /** Protocol-level unpair ack policy; echoed back to joiners. */
  unpair_ack: 'required' | 'not_required'
  /** FE-only UX policy (auto-accept incoming Unpair vs surface modal); echoed
   *  back to joiners so the whole session shares the same UX. */
  auto_accept_unpair_requests: boolean
}

export interface JoinSessionResponse {
  session_id: string
  actor: BEActor
  actors: BEActorWithStatus[]
  min_participants: number
  recommended_participants: number
  protocol_timeout_secs: number
  authentication_method: 'user' | 'application'
  unpair_ack: 'required' | 'not_required'
  auto_accept_unpair_requests: boolean
}

export interface CreateSessionParams {
  ownerName: string
  additionalParticipants: number
  minParticipants: number
  recommendedParticipants: number
  protocolTimeoutSecs: number
  authenticationMethod: 'user' | 'application'
  unpairAck: 'required' | 'not_required'
  autoAcceptUnpairRequests: boolean
}

export interface ContactMessageDto {
  channel_id: string
  nonce: string
  transport_protocol: { uri: string; protocol: string }
  mlkem_encapsulation_key: string
  ecies_public_key: string
}

export async function apiCreateActorContact(
  sessionId: string,
  actorId: string,
): Promise<ContactMessageDto> {
  const res = await fetch(`${API_BASE}/sessions/${sessionId}/actors/${actorId}/contact`, {
    method: 'POST',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `create actor contact failed: ${res.status}`)
  }
  return res.json() as Promise<ContactMessageDto>
}

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

export async function apiCreateSession(params: CreateSessionParams): Promise<CreateSessionResponse> {
  const res = await fetch(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: params.ownerName,
      additional_participants: params.additionalParticipants,
      min_participants: params.minParticipants,
      recommended_participants: params.recommendedParticipants,
      protocol_timeout_secs: params.protocolTimeoutSecs,
      authentication_method: params.authenticationMethod,
      unpair_ack: params.unpairAck,
      auto_accept_unpair_requests: params.autoAcceptUnpairRequests,
    }),
  })

  if (!res.ok) {
    throw new Error(`Failed to create session: ${res.status} ${res.statusText}`)
  }

  return res.json() as Promise<CreateSessionResponse>
}

export async function apiJoinSession(
  sessionId: string,
  name: string,
  prePairedCount?: number,
  /** When set, claim this existing owner actor instead of creating a new one
   *  (recovery-join flow). The backend rebinds the actor's mailbox to a fresh
   *  receiver bound to *this* tab — any previous tab silently stops getting
   *  messages. Unauthenticated in this reference app by design. */
  claimActorId?: string,
): Promise<JoinSessionResponse> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      pre_paired_count: prePairedCount,
      claim_actor_id: claimActorId,
    }),
  })
  if (res.status === 404) {
    const body = await res.json().catch(() => ({}))
    throw new Error(
      (body as { error?: string }).error
        ?? 'Session not found. It may have expired or the server may have restarted.',
    )
  }
  if (!res.ok) {
    throw new Error(`Failed to join session: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<JoinSessionResponse>
}

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

export async function apiStartActorPairing(
  sessionId: string,
  actorId: string,
  contact: ContactMessageDto,
): Promise<{ channel_id: string }> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/actors/${encodeURIComponent(actorId)}/start-pairing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(contact),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `start-pairing failed: ${res.status}`)
  }
  return res.json() as Promise<{ channel_id: string }>
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
