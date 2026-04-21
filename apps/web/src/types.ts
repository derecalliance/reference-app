// ── Transport ─────────────────────────────────────────────────────────────────

export type TransportProtocol = 'https'  // only HTTPS supported in v1

export interface Transport {
  protocol: TransportProtocol
  uri: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export type HelperConnectionStatus = 'paired' | 'available' | 'offline'

export interface SecretShareRef {
  secretId: string
  version: number
  label: string
  /** Whether the helper has confirmed storage. 'pending' = sent, 'confirmed' = acknowledged. */
  status: 'pending' | 'confirmed'
  /** Whether the share has passed an owner-initiated verification challenge. */
  verified: boolean
}

export interface PairedHelper {
  id: string
  /** Human-readable name given by the owner when pairing */
  name: string
  /** Unique identifier for the owner–helper channel (decimal string of u64) */
  channelId: string
  transport: Transport
  secretShares: SecretShareRef[]
  connectionStatus: HelperConnectionStatus
  /** Whether this helper was paired in recovery mode */
  recoveryPaired?: boolean
  /** Whether discovery has been requested and completed for this helper */
  discoveryComplete?: boolean
  /** New channel ID from a recovery pairing, awaiting association */
  pendingRecoveryChannelId?: string
}

// ── Secrets ───────────────────────────────────────────────────────────────────

export interface ProtectedSecret {
  /** Hex-encoded bytes of the secret identifier passed to protect_secret() */
  secretId: string
  /** Current (latest) version number */
  version: number
  /** Human-readable label, e.g. "Google Password" */
  label: string
  /** The current version's secret value as entered by the owner */
  secretData: string
  /** IDs of paired helpers that confirmed storage of a share for the current version */
  helperIds: string[]
  /** IDs of helpers whose share has passed a verification challenge for the current version */
  verifiedHelperIds: string[]
  /** Minimum number of shares required to reconstruct the secret (Shamir T) */
  threshold: number
  /**
   * Older versions that helpers have been instructed to retain.
   * These versions have no local secret data — they exist only as helper shares
   * and can be recovered if needed.
   */
  previousVersions: PreviousVersion[]
}

export interface PreviousVersion {
  version: number
  /** IDs of helpers whose share for this old version has passed a verification challenge */
  verifiedHelperIds: string[]
}

// ── Pairing ───────────────────────────────────────────────────────────────────

export interface PendingPairing {
  channelId: bigint
  /** Set when this pairing belongs to a specific provisioned helper */
  helperId?: string
}

// ── Recovery ─────────────────────────────────────────────────────────────────

export interface DiscoverableSecretVersion {
  version: number
  description: string
}

/** Aggregated view of a secret reported by one or more recovery-paired helpers. */
export interface DiscoverableSecret {
  /** Hex-encoded secret_id */
  secretId: string
  /** Human-readable label parsed from description ("{label}-{version}") */
  label: string
  /** All versions reported across helpers */
  versions: DiscoverableSecretVersion[]
  /** Helper IDs that reported shares for this secret, keyed by version */
  helperSharesByVersion: Record<number, string[]>
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
  /** Total helpers we requested shares from */
  totalRequested: number
  /** Non-null when recovery failed for a reason other than insufficient shares */
  error: string | null
}

// ── Session ───────────────────────────────────────────────────────────────────

export interface OwnerSession {
  sessionId: string
  /** Actor ID of the owner in the backend session — used for mailbox polling */
  ownerId: string
  ownerName: string
  /** The owner's own transport endpoint, shared with helpers for contact */
  transport: Transport
  helpers: PairedHelper[]
  protectedSecrets: ProtectedSecret[]
  /** Pairing attempts in progress — drives mailbox polling */
  pendingPairings: PendingPairing[]
  /** Number of helpers to auto-pair on session load (testing convenience). */
  prePairedCount?: number
  /** Secrets discovered from recovery-paired helpers */
  discoverableSecrets: DiscoverableSecret[]
  /** Successfully recovered secrets */
  recoveredSecrets: RecoveredSecret[]
  /** Live progress of the current recovery attempt (null when idle) */
  recoveryProgress: RecoveryProgress | null
}
