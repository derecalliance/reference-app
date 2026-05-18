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

export interface PairedParticipant {
  id: string
  /** Human-readable name given by the owner when pairing */
  name: string
  /** Unique identifier for the owner–participant channel (decimal string of u64) */
  channelId: string
  transport: Transport
  secretShares: SecretShareRef[]
  connectionStatus: ParticipantConnectionStatus
  /** When true, the backend silently drops all messages to/from this participant */
  offline?: boolean
  /** Whether this participant was paired in recovery mode */
  recoveryPaired?: boolean
  /**
   * When the peer re-pairs in recovery mode, this holds the new (recovery)
   * channel ID. The original `channelId` is kept so shares can still be
   * served on the original channel.
   */
  recoveryChannelId?: string
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
  /** Hex-encoded secret container ID */
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

/** A successfully recovered secret. */
export interface RecoveredSecret {
  secretId: string
  version: number
  label: string
  /** UTF-8 decoded secret data */
  secretData: string
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

export interface ParticipantSession {
  sessionId: string
  /** This participant's actor ID — used for mailbox polling */
  participantId: string
  participantName: string
  /** This participant's transport endpoint */
  transport: Transport
  /** The owner's name */
  ownerName: string
  /** The owner's actor ID */
  ownerId: string
  /** The owner's transport endpoint — needed for addressing messages */
  ownerTransport: Transport
  /** Channel ID once paired with the owner */
  channelId: string
  /** Pairing status */
  connectionStatus: ParticipantConnectionStatus
  /** Snapshot of session actors at join time (for display) */
  actors?: Array<{ id: string; name: string; role: string }>
}

export interface OwnerSession {
  sessionId: string
  /** Actor ID of the owner in the backend session — used for mailbox polling */
  ownerId: string
  ownerName: string
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
  /** Paired replicas (second Owner devices) */
  replicas: PairedReplica[]
  /** Shares this owner holds on behalf of other owners (helper role) */
  heldShares: HeldShare[]
  /**
   * Links established during recovery pairings: maps a new (recovery) channel ID
   * to the old channel ID whose shares should be served. Populated when Alice
   * accepts a recovery pairing and manually links new Bob to old Bob.
   */
  recoveryChannelLinks: RecoveryChannelLink[]
}

/** Maps a new recovery channel to the original channel whose shares it inherits. */
export interface RecoveryChannelLink {
  /** The channel ID established during the recovery pairing (new Bob). */
  newChannelId: string
  /** The original channel ID whose shares are served to the recovering peer. */
  oldChannelId: string
}
