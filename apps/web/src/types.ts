import type { AuthenticationMethod, UnpairAck } from './config'

export type TransportProtocol = 'https'  // only HTTPS supported in v1

export interface Transport {
  protocol: TransportProtocol
  uri: string
}

/** A share this owner holds on behalf of another owner (helper role). */
export interface HeldShare {
  channelId: string
  secretId: string
  version: number
  description: string
}

export type ParticipantConnectionStatus = 'paired' | 'available'

export interface SecretShareRef {
  version: number
  /** Whether the participant has confirmed storage. 'pending' = sent, 'confirmed' = acknowledged, 'rejected' = counterparty refused. */
  status: 'pending' | 'confirmed' | 'rejected'
  /** Whether the share has passed an owner-initiated verification challenge. */
  verified: boolean
}

/** The role this node plays on a given channel. */
export type ChannelRole = 'owner' | 'helper'

export interface PairedParticipant {
  id: string
  /** Human-readable name given by the owner when pairing */
  name: string
  /** Unique identifier for the owner–participant channel (decimal string of u64) */
  channelId: string
  transport: Transport
  secretShares: SecretShareRef[]
  connectionStatus: ParticipantConnectionStatus
  /**
   * The **peer's** role on this channel, fixed at pairing time.
   *
   * Matches `Channel.peer_role` in the library: a channel row describes the
   * party on the other end, so a helper we protect a secret with is recorded
   * as `helper`. This node's own role is always the inverse.
   *
   * Pairing is bi-directional — either party may initiate in either role — so
   * this is derived from `PairingCompleted.kind`, which reports the *local*
   * party's role, and inverted.
   */
  peerRole?: ChannelRole
  /** When true, the backend silently drops all messages to/from this participant */
  offline?: boolean
  /** Whether discovery has been requested and completed for this participant */
  discoveryComplete?: boolean
  /** Secret versions this helper reported during discovery (populated after SecretsDiscovered) */
  discoveredVersions?: Array<{ secretId: string; version: number; description: string }>
  /** Shared symmetric key for the owner–participant channel (base64url-encoded) */
  sharedKey?: string
  /** True for participants running WASM in their browser (no backend protocol) */
  browserManaged?: boolean
}

/** A single user-facing secret within the bag. */
export interface UserSecret {
  /** Hex-encoded application-defined identifier */
  id: string
  /** Human-readable label */
  name: string
  /** The secret value (UTF-8 string) */
  data: string
}

/** One version of the secret bag as distributed to helpers. */
export interface BagVersion {
  version: number
  /** IDs of participants that confirmed storage of this version's share */
  participantIds: string[]
  /** IDs of participants whose share passed verification for this version */
  verifiedParticipantIds: string[]
  /** Participants that rejected or timed out for this version */
  failedParticipantIds: { id: string; status: number; memo: string }[]
  /** User secrets contained in this version */
  secrets: UserSecret[]
  /** Raw bag bytes (hex), for display */
  rawBytes: string
  /** Helper infos snapshot at this version */
  helpers: { id: string; name: string; channelId: string }[]
}

/** The single secret bag managed by the protocol. */
export interface SecretBag {
  /** Protocol-level secret identifier (u64 as decimal string) */
  secretId: string
  /** Current (latest) version */
  currentVersion: BagVersion
  /** Older retained versions (most recent first) */
  previousVersions: BagVersion[]
  /** Shamir threshold (from session config) */
  threshold: number
}

export interface PendingPairing {
  channelId: bigint
  /** Set when this pairing belongs to a specific provisioned participant */
  participantId?: string
  /**
   * Transport URI of the contact this pairing was started against. Set on the
   * initiating side only, and the exact identity of the peer — browser peers
   * are `owner`-role actors that never appear in the participant list, so this
   * is the only reliable way to tell which actor the new channel belongs to.
   */
  peerTransportUri?: string
}

export type ReplicaStatus = 'available' | 'paired' | 'confirmed'

export interface PairedReplica {
  id: string
  name: string
  /** Replica-side channel ID (from backend replica_channels) */
  channelId: string
  /** Owner-side channel ID (from PairingCompleted event on the owner WASM) */
  ownerChannelId?: string
  transport: Transport
  status: ReplicaStatus
  /** Whether this replica is simulating offline status */
  offline?: boolean
  /** Fingerprint string for the replica channel, fetched after pairing */
  replicaFingerprint?: string
  /** Timestamp (ms since epoch) when fingerprint confirmation window started */
  confirmationStartedAt?: number
}

/**
 * Persisted form of the roster snapshot carried by a `SecretRecovered` event.
 *
 * The library now decodes the two-stage `DeRecSecret` → `Secret` protobuf
 * itself and hands over a typed object, so there is no app-side bag decoding.
 * These types mirror that payload with binary fields base64url-encoded so the
 * snapshot survives localStorage; `protocol.restore` needs it re-hydrated.
 */
export interface RecoveredSecretHelper {
  /** u64 channel id as decimal string. */
  channelId: string
  transportUri: string
  /** App-level identity metadata; opaque to the protocol. */
  communicationInfo: Record<string, string>
  /** 32-byte channel key, base64url-encoded. */
  sharedKey: string
}

export interface RecoveredSecretReplica {
  channelId: string
  transportUri: string
  communicationInfo: Record<string, string>
  /** Hex-encoded u64, matching the wire `derec.replica_id` representation. */
  replicaId: string
  senderKind: number
}

export interface RecoveredSecretEntry {
  /** App-defined identifier, base64url-encoded. */
  id: string
  name: string
  /** Raw secret bytes, base64url-encoded (decoded to text only for display). */
  data: string
}

/** The roster + contents snapshot captured at distribution time. */
export interface RecoveredSecretSnapshot {
  helpers: RecoveredSecretHelper[]
  secrets: RecoveredSecretEntry[]
  /** Absent when this secret has no replica setup. */
  replicas?: {
    replicas: RecoveredSecretReplica[]
    /** 32-byte replica-group key, base64url-encoded. */
    sharedKey: string
  }
  /** Hex-encoded u64. */
  ownerReplicaId: string
}

/** A successfully recovered secret. */
export interface RecoveredSecret {
  secretId: string
  version: number
  label: string
  /** The snapshot the owner originally protected, as the library decoded it. */
  snapshot: RecoveredSecretSnapshot
  /** Whether `protocol.restore` has committed this snapshot into canonical
   *  state for its `secret_id`. */
  restored?: boolean
}

/** Tracks live progress of a recovery attempt. */
export interface RecoveryProgress {
  secretId: string
  version: number
  /** Number of share responses received so far */
  sharesReceived: number
  /** Total participants we requested shares from */
  totalRequested: number
  /** Non-null when recovery failed for a reason other than insufficient shares */
  error: string | null
}

/**
 * Record of a per-version recovery failure that should survive subsequent
 * Recover clicks on *other* versions. `recoveryProgress` is a singleton
 * tracking the in-flight attempt; once a new attempt starts, the old
 * progress is overwritten and its error vanishes. This list preserves the
 * outcome of past attempts so the version row keeps its "Incomplete" status
 * until the user retries that specific version (which clears its entry).
 */
export interface RecoveryFailure {
  secretId: string
  version: number
  error: string
}


export interface OwnerSession {
  sessionId: string
  /** Actor ID of the owner in the backend session — used for mailbox polling */
  ownerId: string
  ownerName: string
  /**
   * This node's own `secret_id` (u64 decimal string) — the secret it protects
   * as Owner, allocated by the backend and published on its actor record.
   *
   * The node runs a single protocol instance bound to this value. Helper-role
   * channels live in that same instance: shares are separated by channel and
   * each carries its own Owner's `secret_id` on the record.
   */
  ownSecretId: string
  /** The owner's own transport endpoint, shared with participants for contact */
  transport: Transport
  participants: PairedParticipant[]
  /** The single secret bag, null until the first protect_secret call */
  secretBag: SecretBag | null
  /** Pairing attempts in progress — drives mailbox polling */
  pendingPairings: PendingPairing[]
  /** Number of participants to auto-pair on session load (testing convenience). */
  prePairedCount?: number
  /** Minimum paired participants required before secret protection is allowed. */
  minParticipants: number
  /** Recommended paired participants for safe secret protection. */
  recommendedParticipants: number
  /** Successfully recovered secrets */
  recoveredSecrets: RecoveredSecret[]
  /** Live progress of the current recovery attempt (null when idle) */
  recoveryProgress: RecoveryProgress | null
  /**
   * Past per-version recovery failures whose visual state must persist
   * across Recover clicks on other versions. Cleared when the user retries
   * that specific version, or globally on entering/exiting recovery mode.
   */
  recoveryFailures: RecoveryFailure[]
  /** Paired replicas (second Owner devices) */
  replicas: PairedReplica[]
  /** Shares this owner holds on behalf of other owners (helper role) */
  heldShares: HeldShare[]
  /**
   * Presentation hint for linked-channel groups: channel IDs designated as the
   * "main" (name-bearing) channel of their link group. The channel-link graph
   * itself is undirected (in the channel store); this records which member
   * drives the group header per the UI's main-selection rule.
   */
  mainChannels: string[]
  /** Per-session protocol configuration chosen in the create-session wizard. */
  config: SessionConfig
}

/** User-tunable protocol configuration, fixed at session creation. */
export interface SessionConfig {
  /**
   * General protocol timeout in seconds. Drives both the library's passive
   * `process()` expiry (via the WASM constructor) and the app's active
   * wall-clock watchdog / auto-reject / pairing-wait timers.
   */
  protocolTimeoutSecs: number
  /**
   * How the app decides that two pairing channels belong to the same user.
   * App-level concern (not protocol). Drives the incoming-pairing modal: with
   * `user`, the helper can atomically "accept and link" against an existing
   * paired channel; `application` is reserved for a future identity-driven
   * mode and is not yet selectable in the wizard.
   */
  authenticationMethod: AuthenticationMethod
  /**
   * Protocol-level unpair acknowledgement policy. Threaded into the WASM
   * `DeRecProtocol` constructor and echoed by the backend so all participants
   * agree on the semantics.
   */
  unpairAck: UnpairAck
  /**
   * FE-only UI preference: when `true`, incoming Unpair requests from a peer
   * are auto-accepted; when `false`, the Owner sees a confirmation modal.
   * Purely a UI concern — not threaded into the protocol and not echoed by the
   * backend.
   */
  autoAcceptUnpairRequests: boolean
}
