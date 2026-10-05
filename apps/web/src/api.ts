// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import {
  toServerDefaults,
  type ServerDefaults,
  type ServerDefaultsDto,
  type UnpairAck,
} from './config'
import { DEFAULT_CONTACT_MODE, type ContactModeKey } from './contactModes'
import type { TransportMix } from './transportMix'

import { API_BASE } from './apiBase'
import { responseError } from './httpError'

/** One endpoint an actor advertises, in the actor's own preference order. */
export interface TransportDto {
  protocol: 'https' | 'grpc'
  uri: string
}

interface BEActor {
  id: string
  role: 'owner' | 'helper'
  name: string
  /**
   * `Actor.transport` on the wire is the first entry of `transports` — for a
   * `grpc` or `both` helper that is a `grpc` endpoint, not `https`, so this
   * carries the real protocol rather than asserting one.
   */
  transport: TransportDto
  /** Every endpoint this actor advertises, in preference order. */
  transports: TransportDto[]
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
  /**
   * When this actor's mailbox was last drained (RFC 3339), for a
   * browser-managed owner — `null` when never, absent on a node that predates
   * the field. The only signal a claim has that another browser is still
   * driving the actor.
   */
  last_polled_at?: string | null
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

/** JSON body headers, repeated on almost every mutating call. */
const JSON_HEADERS = { 'Content-Type': 'application/json' }

/** JSON form of a protocol ContactMessage. `u64` fields travel as decimal
 *  strings and binary fields base64url-encoded. Key material is optional: it
 *  is inlined only under ContactMode.InlineKeys — HashedKeys carries a binding
 *  hash instead, NoKeys carries neither. */
export interface TransportProtocolDto {
  uri: string
  /** Lowercase `Protocol` discriminant name: `"https"` or `"grpc"`. */
  protocol: string
}

export interface ContactMessageDto {
  channel_id: string
  nonce: string
  /**
   * The singular endpoint, removed from the protocol at SDK 0.0.6. Never
   * written any more; read only as a fallback, so a payload copied from an
   * older build of this app still pairs.
   */
  transport_protocol?: TransportProtocolDto
  /** Every endpoint the initiator serves, in its own preference order. */
  supported_transports?: TransportProtocolDto[]
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
    throw await responseError(res, 'Could not register the owner')
  }
  return res.json() as Promise<RegisterOwnerResponse>
}

// ── Actors ───────────────────────────────────────────────────────────────────

/** Every actor registered on this server, in registration order. */
// ── Debug surface ────────────────────────────────────────────────────────────
//
// The same payloads `AGENTS.md` points a script at. The Inspect tab renders
// these rather than assembling its own view, so what a human reads on screen
// and what an agent reads over HTTP cannot drift apart.

/** One route the gRPC ingress can resolve, and which tier holds it. */
export interface DebugRoute {
  /** Decimal string — a `u64` exceeds JavaScript's exact integer range. */
  channel_id: string
  actor_id: string
  /** `bound` — the pairing completed. `pinned` — minted but never completed. */
  tier: 'bound' | 'pinned'
}

export interface DebugActor {
  id: string
  role: 'owner' | 'helper'
  name: string
  transports: TransportDto[]
  /** Derived from `transports`, so it cannot disagree with them. */
  transport_mode: 'http' | 'grpc' | 'both'
  secret_id: string
  browser_managed: boolean
  /** Simulating offline: inbound messages are discarded, not queued. */
  disabled: boolean
  channels: string[]
  /** One per protocol instance — its own, plus one per owner it mirrors. */
  instance_secret_ids: string[]
}

export interface DebugState {
  base_url: string
  grpc: {
    enabled: boolean
    port: number
    authority: string
    relay_enabled: boolean
  }
  actors: DebugActor[]
  routes: DebugRoute[]
  events_dropped: number
  latest_event_seq: number
}

/** What actually carried a message — not what the peer advertises. */
export type DebugCarrier = 'http' | 'grpc' | 'grpc_via_relay'

export interface DebugEvent {
  seq: number
  at_ms: number
  direction: 'inbound' | 'outbound'
  carrier: DebugCarrier
  outcome: 'delivered' | 'dropped' | 'refused'
  /** Absent when the message could not be routed — the interesting case. */
  actor_id?: string
  channel_id?: string
  bytes: number
  detail: string
}

export interface DebugEvents {
  events: DebugEvent[]
  /** Non-zero means the oldest entries are gone — truncation, not silence. */
  dropped: number
  /** Pass back as `after` to poll for what comes next. */
  latest_seq: number
}

/** GET /debug/state — everything the server currently knows. */
export async function apiGetDebugState(): Promise<DebugState> {
  const res = await request(`/debug/state`)
  if (!res.ok) {
    throw await responseError(res, 'Could not read the server state')
  }
  return res.json() as Promise<DebugState>
}

/** One setting's value and where it came from, from `GET /debug/config`. */
export interface ConfigOrigin {
  /** Dotted path into the settings tree, e.g. `defaults.participant_count`. */
  path: string
  source: 'default' | 'file' | 'env'
  /** The variable that supplied it. Present only when `source` is `env`. */
  variable?: string
}

/**
 * `GET /debug/config` — what the node is running with, and where each value
 * came from.
 *
 * The same data the backend prints as its boot banner. `settings` is the
 * resolved tree; `origins` explains each leaf. Read-only by nature: the node
 * resolves this once at boot from its config file and `DEREC_*` variables, and
 * has no endpoint to change it.
 */
export interface DebugConfig {
  settings: {
    server: Record<string, unknown>
    defaults: Record<string, unknown>
  }
  origins: ConfigOrigin[]
  /** Whether a config file was found at the configured path. */
  file_found: boolean
  /** `DEREC_*` variables that matched no setting. Warned about, not fatal. */
  unknown_env: string[]
}

export async function apiGetDebugConfig(): Promise<DebugConfig> {
  const res = await request(`/debug/config`)
  if (!res.ok) {
    throw await responseError(res, 'Could not read the server configuration')
  }
  return res.json() as Promise<DebugConfig>
}

/** GET /debug/events — what the server did, in order, after `after`. */
export async function apiGetDebugEvents(after: number): Promise<DebugEvents> {
  const res = await request(`/debug/events?after=${after}`)
  if (!res.ok) {
    throw await responseError(res, 'Could not read the server events')
  }
  return res.json() as Promise<DebugEvents>
}

export async function apiGetActors(): Promise<BEActorWithStatus[]> {
  const res = await request(`/actors`)
  if (!res.ok) {
    throw await responseError(res, 'Could not list the actors on the node')
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
    throw await responseError(res, 'Could not create a contact for that participant')
  }
  return res.json() as Promise<ContactMessageDto>
}

/**
 * Mint a contact from a helper's instance for *this owner's* vault, so pairing
 * against it produces a replica rather than a helper relationship.
 *
 * A replica is a pairing mode, not a kind of actor. The counterparty is an
 * ordinary helper; what makes the handshake a replica handshake is which of its
 * protocol instances the contact came from. The backend creates that instance
 * on demand and the call is idempotent, so a helper already mirroring this
 * owner keeps the shares it holds rather than starting over.
 *
 * `ownerSecretId` is the owner's own `secret_id` as published on its actor
 * record, carried as a decimal string because a `u64` exceeds JavaScript's
 * exact integer range.
 */
export async function apiCreateReplicaContact(
  helperId: string,
  ownerSecretId: string,
  contactMode: ContactModeKey = DEFAULT_CONTACT_MODE,
  nonce?: bigint,
): Promise<ContactMessageDto> {
  const params = new URLSearchParams({
    contact_mode: contactMode,
    replica_for_owner_secret: ownerSecretId,
  })
  if (nonce !== undefined) params.set('nonce', nonce.toString())

  const res = await request(
    `/actors/${encodeURIComponent(helperId)}/contact?${params.toString()}`,
    { method: 'POST' },
  )
  if (!res.ok) {
    throw await responseError(res, 'Could not create a replica contact')
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
 *  Backend-managed actors only ever take these two roles — the `start-pairing`
 *  route rejects anything but `owner`/`helper` — so this intentionally takes
 *  the narrower role type rather than the app-wide `PairingRole`. */
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
    throw await responseError(res, 'Could not start pairing')
  }
  return res.json() as Promise<{ channel_id: string }>
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export interface AddHelperResponse {
  id: string
  role: 'helper'
  name: string
  transport: TransportDto
  secret_id: string
}

export interface EnsureHelpersResult {
  /** The whole pool, including helpers other owners provisioned. */
  helpers: AddHelperResponse[]
  /** How many of them this call had to create. */
  created: number
}

/**
 * Bring the shared helper pool up to `total`.
 *
 * Provisioned helpers belong to the server, not to the owner who asked for
 * them — everyone pairs with the same fixtures. So this states how many should
 * exist, not how many to add: asking for 7 when 7 exist creates none, asking
 * for 9 creates 2, and asking for fewer than exist removes nothing.
 *
 * `names` are candidates for whatever ends up being created. The caller cannot
 * know that count in advance (it depends on what other owners have already
 * provisioned), so it offers a full set and the server takes what it needs.
 *
 * `transports` is the target composition of the pool by mode; it must sum to
 * `total` and the server rejects a mismatch, along with a request for
 * gRPC/Both helpers while its gRPC listener is disabled.
 */
export async function apiEnsureHelpers(
  total: number,
  names: string[],
  transports: TransportMix,
  settings: ProvisioningSettings,
): Promise<EnsureHelpersResult> {
  const res = await request(`/helpers/ensure`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ total, names, transports, ...settingsBody(settings) }),
  })
  if (!res.ok) {
    throw await responseError(res, 'Could not provision the participant pool')
  }
  return res.json() as Promise<EnsureHelpersResult>
}

export async function apiAddHelper(
  name: string,
  settings: ProvisioningSettings,
): Promise<AddHelperResponse> {
  const res = await request(`/helpers`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, ...settingsBody(settings) }),
  })
  if (!res.ok) {
    throw await responseError(res, 'Could not provision the participant')
  }
  return res.json() as Promise<AddHelperResponse>
}

export async function apiToggleParticipantStatus(
  participantId: string,
  disabled?: boolean,
): Promise<{ disabled: boolean }> {
  const res = await request(
    `/helpers/${encodeURIComponent(participantId)}/toggle-status`,
    {
      method: 'POST',
      ...(disabled !== undefined && {
        headers: JSON_HEADERS,
        body: JSON.stringify({ disabled }),
      }),
    },
  )
  if (!res.ok) {
    throw await responseError(res, 'Could not change the participant’s status')
  }
  return res.json() as Promise<{ disabled: boolean }>
}

/**
 * Erase a provisioned participant: its actor, its stores and its registry entry.
 *
 * The pool is server-wide, so this removes it for every owner on this node, not
 * just this browser. An owner already paired with it keeps its channel — the
 * backend cannot reach into another browser's storage — and from there the
 * participant simply stops answering, like one that has gone offline. Unpairing
 * is how that channel is cleared.
 */
export async function apiDeleteParticipant(participantId: string): Promise<void> {
  const res = await request(`/helpers/${encodeURIComponent(participantId)}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    throw await responseError(res, 'Could not delete the participant')
  }
}

/** What renaming an owner on the node came to. */
export type RenameOwnerResult =
  | { kind: 'renamed'; name: string }
  /**
   * The node predates `PATCH /owners/{id}` (404 / 405). Not a failure of the
   * rename — the vault's own name changed and peers were told — only of keeping
   * the node's roster label in step.
   */
  | { kind: 'unsupported' }

/**
 * PATCH /owners/{id} — change the name the node lists this owner under.
 *
 * A browser vault's name lives in two places: its own record and protocol
 * instance, which `updateIdentity` changes and announces, and the node's
 * roster, which every other browser context reads names from. Without this the
 * roster kept the name the vault registered with forever.
 */
export async function apiRenameOwner(ownerId: string, name: string): Promise<RenameOwnerResult> {
  const res = await request(`/owners/${encodeURIComponent(ownerId)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  })
  if (res.status === 404 || res.status === 405) return { kind: 'unsupported' }
  if (!res.ok) {
    throw await responseError(res, 'Could not rename the vault on the node')
  }
  const body = (await res.json()) as { name?: unknown }
  return { kind: 'renamed', name: typeof body.name === 'string' ? body.name : name }
}

/** Publish this node's contact so peers can pair against it. */
export async function apiPostBrowserContact(
  participantId: string,
  contactJson: string,
): Promise<void> {
  const res = await request(
    `/helpers/${encodeURIComponent(participantId)}/browser-contact`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: contactJson,
    },
  )
  if (!res.ok) {
    throw await responseError(res, 'Could not publish the contact')
  }
}

/** Fetch a peer's published contact. */
export async function apiGetBrowserContact(
  participantId: string,
): Promise<ContactMessageDto | null> {
  const res = await request(
    `/helpers/${encodeURIComponent(participantId)}/browser-contact`,
  )
  if (res.status === 404) return null
  if (!res.ok) {
    throw await responseError(res, 'Could not fetch the peer’s contact')
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
    `/helpers/${encodeURIComponent(participantId)}/channels`,
  )
  if (!res.ok) {
    throw await responseError(res, 'Could not list the participant’s channels')
  }
  const body = (await res.json()) as { channels: ProvisionedChannel[] }
  return body.channels
}

/** Link `channelId` to `linkToChannelId` on the provisioned helper, declaring
 *  that both belong to the same owner. Undirected and idempotent. */
export async function apiLinkHelperChannels(
  helperId: string,
  channelId: string,
  linkToChannelId: string,
): Promise<void> {
  const res = await request(`/helpers/${encodeURIComponent(helperId)}/link`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ channel_id: channelId, link_to_channel_id: linkToChannelId }),
  })
  if (!res.ok) {
    throw await responseError(res, 'Could not link the channels')
  }
}

// ── Fingerprint confirmation ─────────────────────────────────────────────────

/**
 * A provisioned actor's own fingerprint for one of its channels.
 *
 * The channel is named explicitly rather than inferred from the actor: a
 * `NoKeys` pairing — and every replica-mode pairing — can land on any
 * provisioned actor, and one actor may hold several such channels at once. The
 * backend resolves the channel to the protocol instance that holds it, so a
 * replica-mode channel — which lives on the mirrored owner's instance rather
 * than the actor's own — is served the same as any other.
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
    throw await responseError(res, 'Could not read the participant’s fingerprint')
  }
  const body = (await res.json()) as { fingerprint: string }
  return body.fingerprint
}

/**
 * Have a provisioned actor confirm our fingerprint, promoting its side of the
 * channel from `Pending` to `Paired`.
 *
 * Returns `false` on mismatch rather than throwing: comparing two codes out of
 * band and getting it wrong is an ordinary outcome, not a failure of the
 * request. It is also the man-in-the-middle signal, so callers must surface it
 * rather than silently retry. Every other non-2xx still throws.
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
  // Read from a clone so the error path below still has an unread body.
  const body = (await res.clone().json().catch(() => ({}))) as { error?: string }
  if (res.status === 400 && body.error === 'fingerprint mismatch') return false
  throw await responseError(res, 'Could not confirm the fingerprint')
}

