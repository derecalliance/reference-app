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
  /** This actor's own secret_id (u64 decimal string) — the secret it protects
   *  as Owner. Peers helping it must bind their helper-role protocol instance
   *  to this value. */
  secret_id: string
}

export interface CreateSessionResponse {
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

/**
 * Role a party declares when it *initiates* a pairing; the responder takes the
 * complement.
 *
 * A ContactMessage carries no role — only the initiator's declaration reaches
 * the wire — so this is chosen by whoever scans a contact and starts the
 * handshake, never by whoever published it.
 */
export type PairingRole = 'owner' | 'helper'

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

/** JSON form of a protocol ContactMessage. `u64` fields travel as decimal
 *  strings and binary fields base64url-encoded. Key material is optional: it
 *  is inlined only under ContactMode.InlineKeys — HashedKeys carries a binding
 *  hash instead, NoKeys carries neither. */
export interface ContactMessageDto {
  channel_id: string
  nonce: string
  transport_protocol: { uri: string; protocol: string }
  /** ContactMode numeric value: 0 = InlineKeys, 1 = HashedKeys, 2 = NoKeys. */
  contact_mode: number
  mlkem_encapsulation_key?: string
  ecies_public_key?: string
  contact_binding_hash?: string
}

export async function apiCreateActorContact(
  sessionId: string,
  actorId: string,
): Promise<ContactMessageDto> {
  const res = await fetch(
    `${API_BASE}/sessions/${sessionId}/actors/${actorId}/contact`,
    { method: 'POST' },
  )
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

/** Publish this node's contact so peers can pair against it. */
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

/** Drive a backend-managed actor into pairing against `contact`.
 *
 *  Pairing is bi-directional: `role` is the role the *backend actor* takes,
 *  and the responder gets the complement. Defaults to `helper`. The returned
 *  channel_id is the transient pairing id — the handshake rotates to a
 *  long-term id that surfaces on PairingCompleted. */
export async function apiStartActorPairing(
  sessionId: string,
  actorId: string,
  contact: ContactMessageDto,
  role: PairingRole = 'helper',
): Promise<{ channel_id: string }> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/actors/${encodeURIComponent(actorId)}/start-pairing?role=${role}`, {
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

/** Fetch a peer's published contact. */
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

// ── Operator-driven channel linking (provisioned helpers) ────────────────────
//
// A helper deciding that a newly-paired channel belongs to an owner it already
// helps is an authentication step, not something the protocol can infer — no
// field on the wire carries a trustworthy identity. Browser helpers do this
// through the pairing prompt or the channel list; provisioned helpers have no
// UI of their own, so an operator drives it through these endpoints.

/** One channel a provisioned helper holds. */
export interface ProvisionedChannel {
  channel_id: string
  /** Peer's display name. Informational only — never an identity to act on. */
  peer_name: string
  /** The provisioned actor's role on this channel. */
  role: 'owner' | 'helper'
  /** Channels already linked to this one. */
  linked_channel_ids: string[]
}

export async function apiListParticipantChannels(
  sessionId: string,
  participantId: string,
): Promise<ProvisionedChannel[]> {
  const res = await fetch(
    `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(participantId)}/channels`,
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `list channels failed: ${res.status}`)
  }
  const body = (await res.json()) as { channels: ProvisionedChannel[] }
  return body.channels
}

/** Link `channelId` to `linkToChannelId` on the provisioned helper, declaring
 *  that both belong to the same owner. Undirected and idempotent. */
export async function apiLinkParticipantChannels(
  sessionId: string,
  participantId: string,
  channelId: string,
  linkToChannelId: string,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/participants/${encodeURIComponent(participantId)}/link`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId, link_to_channel_id: linkToChannelId }),
    },
  )
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `link failed: ${res.status}`)
  }
}
