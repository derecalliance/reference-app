import {
  toServerDefaults,
  type ServerDefaults,
  type ServerDefaultsDto,
  type UnpairAck,
} from './config'
import { DEFAULT_CONTACT_MODE, type ContactModeKey } from './contactModes'

import { API_BASE } from './apiBase'

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

export interface BEActorWithStatus extends BEActor {
  channel_id?: string
  shared_key?: string
  disabled?: boolean
  /** This actor's protocol instance runs in a browser, so it has no backend
   *  instance to drive: its contact comes from the signaling endpoint. Set for
   *  every browser actor whatever its role, including one mirroring another
   *  device — that registers as an ordinary `owner` actor. */
  browser_managed?: boolean
  /** `replica` actors only: the backend-run replica confirmed the peer's
   *  fingerprint. `replica` actors are backend-provisioned by definition, so
   *  this is never set for a second browser device mirroring an owner — that
   *  device is an `owner` actor and confirms in its own context, which the
   *  backend never observes. */
  replica_confirmed?: boolean
}

/** GET /actors — every actor on this server, enriched with pairing status. */
export interface ListActorsResponse {
  actors: BEActorWithStatus[]
}

/** POST /owners — the registered (or reclaimed) owner actor, flattened. */
export interface RegisterOwnerResponse extends BEActor {
  role: 'owner'
}

/** Protocol settings sent with each provisioning request.
 *
 *  Configuration is owned by the front end — there is no server-held policy for
 *  a provisioned actor to inherit — so the node doing the provisioning states
 *  what the new actor should run with. */
export interface ProvisioningSettings {
  protocolTimeoutSecs: number
  unpairAck: UnpairAck
}

function settingsBody(settings: ProvisioningSettings) {
  return {
    protocol_timeout_secs: settings.protocolTimeoutSecs,
    unpair_ack: settings.unpairAck,
  }
}

/**
 * Every call to the backend goes through here.
 *
 * `fetch` rejects with a bare `TypeError: Failed to fetch` when it cannot open
 * a connection — no status, no URL, nothing the reader can act on. Since a
 * stopped backend is the single most common reason this app fails, that gets
 * turned into a message naming the address, with the original kept as `cause`.
 */
async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_BASE}${path}`, init)
  } catch (cause) {
    throw new Error(
      `Cannot reach the DeRec server at ${API_BASE}. Is the backend running?`,
      { cause },
    )
  }
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}))
  return (body as { error?: string }).error ?? fallback
}

/** JSON body headers, repeated on almost every mutating call. */
const JSON_HEADERS = { 'Content-Type': 'application/json' }

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

// ── Server-supplied defaults ─────────────────────────────────────────────────

export interface ServerDefaultsResult {
  defaults: ServerDefaults
  /**
   * False only when the server could not be reached at all.
   *
   * Distinct from "answered with an error": a 500 from `/config` means the
   * backend is up but could not produce defaults, and telling the user it is
   * unreachable would send them hunting for a process that is running fine.
   */
  reachable: boolean
}

/**
 * Operator-supplied starting values for the setup wizard.
 *
 * Never throws — the wizard is perfectly usable on the built-in defaults, and
 * blocking setup because an optional convenience endpoint failed would be the
 * wrong trade. But it does report reachability, because this is the app's first
 * contact with the backend and so the earliest point at which "the server is
 * down" can be said out loud. Swallowing that let the user fill in the whole
 * wizard before finding out.
 */
export async function apiGetServerDefaults(): Promise<ServerDefaultsResult> {
  try {
    const res = await request(`/config`)
    if (!res.ok) return { defaults: toServerDefaults(null), reachable: true }
    const dto = (await res.json()) as Partial<ServerDefaultsDto>
    return { defaults: toServerDefaults(dto), reachable: true }
  } catch {
    return { defaults: toServerDefaults(null), reachable: false }
  }
}

// ── Owners ───────────────────────────────────────────────────────────────────

/**
 * Register this browser context as an owner actor and claim a mailbox for it.
 *
 * Every browser context that takes part does this once. A second tab is simply
 * a second owner on the same server — there is no wider container to join.
 *
 * When `claimActorId` is set the backend adopts that existing owner actor
 * instead of minting one (recovery flow), rebinding its mailbox to a receiver
 * bound to *this* tab — any previous tab silently stops getting messages.
 * Unauthenticated in this reference app by design.
 */
export async function apiRegisterOwner(
  name: string,
  claimActorId?: string,
): Promise<RegisterOwnerResponse> {
  const res = await request(`/owners`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, claim_actor_id: claimActorId }),
  })
  if (!res.ok) {
    throw new Error(await errorMessage(res, `register owner failed: ${res.status}`))
  }
  return res.json() as Promise<RegisterOwnerResponse>
}

// ── Actors ───────────────────────────────────────────────────────────────────

/** Every actor registered on this server, in registration order. */
export async function apiGetActors(): Promise<BEActorWithStatus[]> {
  const res = await request(`/actors`)
  if (!res.ok) {
    throw new Error(`Failed to fetch actors: ${res.status} ${res.statusText}`)
  }
  const body = (await res.json()) as ListActorsResponse
  return body.actors
}

/**
 * Have a backend-managed actor mint a contact.
 *
 * `contactMode` picks how it publishes its keys; `nonce` is only meaningful
 * for `no_keys`, where the caller supplies a short human-readable value
 * instead of letting the library mint a random `u64`.
 */
export async function apiCreateActorContact(
  actorId: string,
  contactMode: ContactModeKey = DEFAULT_CONTACT_MODE,
  nonce?: bigint,
): Promise<ContactMessageDto> {
  const params = new URLSearchParams({ contact_mode: contactMode })
  if (nonce !== undefined) params.set('nonce', nonce.toString())

  const res = await request(
    `/actors/${encodeURIComponent(actorId)}/contact?${params.toString()}`,
    { method: 'POST' },
  )
  if (!res.ok) {
    throw new Error(await errorMessage(res, `create actor contact failed: ${res.status}`))
  }
  return res.json() as Promise<ContactMessageDto>
}

/** Drive a backend-managed actor into pairing against `contact`.
 *
 *  Pairing is bi-directional: `role` is the role the *backend actor* takes,
 *  and the responder gets the complement. Defaults to `helper`. The returned
 *  channel_id is the transient pairing id — the handshake rotates to a
 *  long-term id that surfaces on PairingCompleted.
 *
 *  Backend-managed actors are participants and replicas only — the
 *  `start-pairing` route rejects anything but `owner`/`helper` — so this
 *  intentionally takes the narrower role type rather than the app-wide
 *  `PairingRole`. */
export async function apiStartActorPairing(
  actorId: string,
  contact: ContactMessageDto,
  role: 'owner' | 'helper' = 'helper',
): Promise<{ channel_id: string }> {
  const res = await request(
    `/actors/${encodeURIComponent(actorId)}/start-pairing?role=${role}`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(contact),
    },
  )
  if (!res.ok) {
    throw new Error(await errorMessage(res, `start-pairing failed: ${res.status}`))
  }
  return res.json() as Promise<{ channel_id: string }>
}

// ── Participants ─────────────────────────────────────────────────────────────

export interface AddParticipantResponse {
  id: string
  role: 'participant'
  name: string
  transport: BETransport
  secret_id: string
}

export interface EnsureParticipantsResult {
  /** The whole pool, including participants other owners provisioned. */
  participants: AddParticipantResponse[]
  /** How many of them this call had to create. */
  created: number
}

/**
 * Bring the shared participant pool up to `total`.
 *
 * Provisioned participants belong to the server, not to the owner who asked for
 * them — everyone pairs with the same fixtures. So this states how many should
 * exist, not how many to add: asking for 7 when 7 exist creates none, asking
 * for 9 creates 2, and asking for fewer than exist removes nothing.
 *
 * `names` are candidates for whatever ends up being created. The caller cannot
 * know that count in advance (it depends on what other owners have already
 * provisioned), so it offers a full set and the server takes what it needs.
 */
export async function apiEnsureParticipants(
  total: number,
  names: string[],
  settings: ProvisioningSettings,
): Promise<EnsureParticipantsResult> {
  const res = await request(`/participants/ensure`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ total, names, ...settingsBody(settings) }),
  })
  if (!res.ok) {
    throw new Error(await errorMessage(res, `ensure participants failed: ${res.status}`))
  }
  return res.json() as Promise<EnsureParticipantsResult>
}

export async function apiAddParticipant(
  name: string,
  settings: ProvisioningSettings,
): Promise<AddParticipantResponse> {
  const res = await request(`/participants`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, ...settingsBody(settings) }),
  })
  if (!res.ok) {
    throw new Error(await errorMessage(res, `add-participant failed: ${res.status}`))
  }
  return res.json() as Promise<AddParticipantResponse>
}

export async function apiToggleParticipantStatus(
  participantId: string,
  disabled?: boolean,
): Promise<{ disabled: boolean }> {
  const res = await request(
    `/participants/${encodeURIComponent(participantId)}/toggle-status`,
    {
      method: 'POST',
      ...(disabled !== undefined && {
        headers: JSON_HEADERS,
        body: JSON.stringify({ disabled }),
      }),
    },
  )
  if (!res.ok) {
    throw new Error(await errorMessage(res, `toggle-status failed: ${res.status}`))
  }
  return res.json() as Promise<{ disabled: boolean }>
}

/** Publish this node's contact so peers can pair against it. */
export async function apiPostBrowserContact(
  participantId: string,
  contactJson: string,
): Promise<void> {
  const res = await request(
    `/participants/${encodeURIComponent(participantId)}/browser-contact`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: contactJson,
    },
  )
  if (!res.ok) {
    throw new Error(`post browser-contact failed: ${res.status}`)
  }
}

/** Fetch a peer's published contact. */
export async function apiGetBrowserContact(
  participantId: string,
): Promise<ContactMessageDto | null> {
  const res = await request(
    `/participants/${encodeURIComponent(participantId)}/browser-contact`,
  )
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
  participantId: string,
): Promise<ProvisionedChannel[]> {
  const res = await request(
    `/participants/${encodeURIComponent(participantId)}/channels`,
  )
  if (!res.ok) {
    throw new Error(await errorMessage(res, `list channels failed: ${res.status}`))
  }
  const body = (await res.json()) as { channels: ProvisionedChannel[] }
  return body.channels
}

/** Link `channelId` to `linkToChannelId` on the provisioned helper, declaring
 *  that both belong to the same owner. Undirected and idempotent. */
export async function apiLinkParticipantChannels(
  participantId: string,
  channelId: string,
  linkToChannelId: string,
): Promise<void> {
  const res = await request(`/participants/${encodeURIComponent(participantId)}/link`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ channel_id: channelId, link_to_channel_id: linkToChannelId }),
  })
  if (!res.ok) {
    throw new Error(await errorMessage(res, `link failed: ${res.status}`))
  }
}

// ── Replicas ─────────────────────────────────────────────────────────────────
//
// A replica mirrors one specific owner's vault. Several independent `owner`
// actors may be registered at once — one per browser context — so "the owner"
// is not well defined and every replica names the owner it mirrors explicitly.

/** POST /replicas — the created replica actor (flattened). */
export interface AddReplicaResponse {
  id: string
  role: 'replica'
  name: string
  transport: BETransport
  /** The mirrored owner's `secret_id`, since a replica shares its vault. */
  secret_id: string
}

export async function apiAddReplica(
  name: string,
  /** The owner actor whose vault this replica mirrors. Required — see above. */
  ownerActorId: string,
  settings: ProvisioningSettings,
): Promise<AddReplicaResponse> {
  const res = await request(`/replicas`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      name,
      owner_actor_id: ownerActorId,
      ...settingsBody(settings),
    }),
  })
  if (!res.ok) {
    throw new Error(await errorMessage(res, `add-replica failed: ${res.status}`))
  }
  return res.json() as Promise<AddReplicaResponse>
}

/** A provisioned replica's own fingerprint, for out-of-band comparison.
 *
 *  Provisioned replicas only: the backend computes this inside its own protocol
 *  instance for a `replica` actor. A second browser device mirroring an owner is
 *  not one — it registers as an ordinary `owner` actor — so calling this with its
 *  id is rejected with 400 "actor is an owner, not a replica". Such a device
 *  derives the fingerprint from its own instance instead. */
export async function apiGetReplicaFingerprint(replicaId: string): Promise<string> {
  const res = await request(`/replicas/${encodeURIComponent(replicaId)}/fingerprint`)
  if (!res.ok) {
    throw new Error(await errorMessage(res, `replica fingerprint failed: ${res.status}`))
  }
  const body = (await res.json()) as { fingerprint: string }
  return body.fingerprint
}

/**
 * Have a provisioned replica verify our fingerprint, promoting its side of the
 * channel from `Pending` to `Paired`.
 *
 * A mismatch comes back as `400 {"error":"fingerprint mismatch"}` and is
 * surfaced as `false`, not thrown: comparing two codes out of band and getting
 * it wrong is an ordinary, retryable outcome, not a failure of the request.
 * Every other non-2xx still throws.
 */
export async function apiConfirmReplicaFingerprint(
  replicaId: string,
  channelId: string,
  fingerprint: string,
): Promise<boolean> {
  const res = await request(
    `/replicas/${encodeURIComponent(replicaId)}/confirm-fingerprint`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ channel_id: channelId, fingerprint }),
    },
  )
  if (res.ok) {
    const body = (await res.json()) as { confirmed: boolean }
    return body.confirmed
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (res.status === 400 && body.error === 'fingerprint mismatch') return false
  throw new Error(body.error ?? `confirm-fingerprint failed: ${res.status}`)
}

/**
 * A provisioned actor's own fingerprint for one of its channels.
 *
 * Actor-generic, unlike `apiGetReplicaFingerprint`, which infers the channel
 * from the replica's single pairing. A `NoKeys` pairing can land on any
 * provisioned actor and on any channel, so this names the channel explicitly.
 */
export async function apiGetActorFingerprint(
  actorId: string,
  channelId: string,
): Promise<string> {
  const params = new URLSearchParams({ channel_id: channelId })
  const res = await request(
    `/actors/${encodeURIComponent(actorId)}/fingerprint?${params.toString()}`,
  )
  if (!res.ok) {
    throw new Error(await errorMessage(res, `actor fingerprint failed: ${res.status}`))
  }
  const body = (await res.json()) as { fingerprint: string }
  return body.fingerprint
}

/**
 * Have a provisioned actor confirm our fingerprint, promoting its side of the
 * channel from `Pending` to `Paired`.
 *
 * Returns `false` on mismatch rather than throwing — see
 * `apiConfirmReplicaFingerprint`, except that here a mismatch is the
 * man-in-the-middle signal and callers must surface it, not silently retry.
 */
export async function apiConfirmActorFingerprint(
  actorId: string,
  channelId: string,
  fingerprint: string,
): Promise<boolean> {
  const res = await request(
    `/actors/${encodeURIComponent(actorId)}/confirm-fingerprint`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ channel_id: channelId, fingerprint }),
    },
  )
  if (res.ok) {
    const body = (await res.json()) as { confirmed: boolean }
    return body.confirmed
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (res.status === 400 && body.error === 'fingerprint mismatch') return false
  throw new Error(body.error ?? `confirm-fingerprint failed: ${res.status}`)
}

/** Simulate a replica going offline/online. Omit `disabled` to toggle. */
export async function apiToggleReplicaStatus(
  replicaId: string,
  disabled?: boolean,
): Promise<{ disabled: boolean }> {
  const res = await request(`/replicas/${encodeURIComponent(replicaId)}/toggle-status`, {
    method: 'POST',
    ...(disabled !== undefined && {
      headers: JSON_HEADERS,
      body: JSON.stringify({ disabled }),
    }),
  })
  if (!res.ok) {
    throw new Error(await errorMessage(res, `replica toggle-status failed: ${res.status}`))
  }
  return res.json() as Promise<{ disabled: boolean }>
}
