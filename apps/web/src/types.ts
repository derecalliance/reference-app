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
}

export interface PairedHelper {
  id: string
  /** Human-readable name given by the owner when pairing */
  name: string
  /** Unique identifier for the owner–helper channel */
  channelId: string
  transport: Transport
  /** Symmetric key shared between owner and helper */
  sharedKey: string
  secretShares: SecretShareRef[]
  connectionStatus: HelperConnectionStatus
}

// ── Secrets ───────────────────────────────────────────────────────────────────

export interface ProtectedSecret {
  secretId: string
  version: number
  /** Human-readable label for this version, e.g. "Metamask Wallet V1" */
  label: string
  /** Names of paired helpers that hold a share for this secret+version */
  helperNames: string[]
}

// ── Session ───────────────────────────────────────────────────────────────────

export interface OwnerSession {
  sessionId: string
  ownerName: string
  /** The owner's own transport endpoint, shared with helpers for contact */
  transport: Transport
  helpers: PairedHelper[]
  protectedSecrets: ProtectedSecret[]
}
