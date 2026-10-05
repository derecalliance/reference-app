// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { updateBagParticipant, updateBagVersion } from '../owner/bag'
import type {
  PairedParticipant,
  PendingProtectRound,
  PendingVerification,
  SecretBag,
  UserSecret,
} from '../types'
import type { PendingBag } from './types'

/** A dispatched verification challenge, awaiting its answer. */
export interface VerificationChallenge {
  protocolSecretId: string
  version: number
  /** Epoch ms after which no answer is expected. */
  deadline: number
}

/** A dispatched recovery request, so `SecretRecovered` can be matched to it. */
export interface RecoveryRequest {
  secretId: string
  version: number
  label: string
}

/** A participant that refused a share in the current round. */
export interface ShareFailure {
  id: string
  status: number
  memo: string
}

/** One open protect round: the bag it commits and who it still waits on. */
interface OpenRound {
  pending: PendingBag
  /** Participant channels the round sent a share to and has not heard a refusal from. */
  awaiting: Set<string>
  /** Channels among `awaiting` that have confirmed. */
  confirmed: Set<string>
}

/**
 * How many abandoned rounds are kept for a late completion. Rounds are rare
 * and the library resolves each within a minute or two, so a handful covers
 * every realistic overlap without growing for the life of the page.
 */
const ABANDONED_ROUNDS_KEPT = 8

/**
 * Which requests a vault has dispatched and is still waiting on.
 *
 * One home for this state, shared by the commands that start a round and the
 * event handlers that resolve it. Purposeful operations rather than accessors,
 * so neither side can keep its own copy: when the commands still lived in the
 * page, a second copy there meant the fold read a map the commands never wrote,
 * no share was ever marked confirmed, and it showed up only as end-to-end tests
 * timing out.
 *
 * Protect rounds are keyed by the version the library assigned, because
 * several run at once: adding a secret while the previous one is still waiting
 * on a slow helper, or the auto-publish a replica confirmation triggers. One
 * shared slot let the second round overwrite the first one's staged bag, and
 * the first round's `SharingComplete` then found nothing to commit — the secret
 * it carried was silently lost.
 *
 * Holds no timers and reports nothing — the runtime owns the watchdog and the
 * notifications. That keeps this a plain value that specs can drive directly.
 */
export class RoundTracker {
  /** Open protect rounds, keyed by version. */
  private readonly rounds = new Map<number, OpenRound>()
  /**
   * Rounds given up on, kept in case the library resolves them after all. The
   * watchdog abandons a round on the app's own deadline, but the library keeps
   * the round open on its own and can still report it met its threshold — at
   * which point the helpers hold *that* bag, not the old one.
   */
  private readonly abandoned = new Map<number, PendingBag>()
  /** In-flight verification challenges, keyed by participant channel id. */
  private readonly verifications = new Map<string, VerificationChallenge>()
  /** The in-flight recovery request. */
  private recovery: RecoveryRequest | null = null

  // ── Protect rounds ─────────────────────────────────────────────────────────

  /** Register a dispatched `ProtectSecret` round. */
  beginProtectRound(round: {
    bag: SecretBag
    version: number
    protocolSecretId: string
    /** Participant channels the round dispatched a share to. */
    channelIds: readonly string[]
  }): void {
    this.abandoned.delete(round.version)
    this.rounds.set(round.version, {
      pending: { bag: round.bag, version: round.version, protocolSecretId: round.protocolSecretId },
      awaiting: new Set(round.channelIds.filter(Boolean)),
      confirmed: new Set(),
    })
  }

  /** Every open round, oldest first. */
  get pendingRounds(): PendingBag[] {
    return [...this.rounds.values()]
      .map(r => r.pending)
      .sort((a, b) => a.version - b.version)
  }

  /** The open round at `version`, if any. */
  pendingRound(version: number): PendingBag | null {
    return this.rounds.get(version)?.pending ?? null
  }

  /**
   * The secrets a new round should publish: the newest bag this vault has
   * asked for, staged or committed.
   *
   * Reading only the committed bag dropped a secret whose round was still
   * open — S2 waiting on a slow helper, then adding S3 published [S1, S3], and
   * whichever round committed last decided whether S2 survived.
   */
  latestSecrets(committed: SecretBag | null): UserSecret[] {
    const committedVersion = committed?.currentVersion.version ?? 0
    const newest = this.pendingRounds.at(-1)
    if (newest && newest.version > committedVersion) return newest.bag.currentVersion.secrets
    return committed?.currentVersion.secrets ?? []
  }

  /** The open rounds as the vault record persists them — see `Vault.pendingProtectRounds`. */
  snapshotProtectRounds(): PendingProtectRound[] {
    return [...this.rounds.values()]
      .sort((a, b) => a.pending.version - b.pending.version)
      .map(({ pending, awaiting }) => ({
        version: pending.version,
        protocolSecretId: pending.protocolSecretId,
        bag: pending.bag,
        channelIds: [...awaiting],
      }))
  }

  /** Whether a round at this version is still awaiting its shares. */
  hasPendingRound(version: number): boolean {
    return this.rounds.has(version)
  }

  /** Whether any protect round is still open. */
  get hasAnyPendingRound(): boolean {
    return this.rounds.size > 0
  }

  /**
   * Whether round `version` sent a share on `channelId` that is not yet
   * answered. Without a version, whether any open round did.
   */
  isAwaitingShare(channelId: string, version?: number): boolean {
    if (version !== undefined) return this.rounds.get(version)?.awaiting.has(channelId) ?? false
    return [...this.rounds.values()].some(r => r.awaiting.has(channelId))
  }

  /** The participant on `channelId` stored its share of `version`. */
  recordShareConfirmed(version: number, participantId: string, channelId?: string): void {
    const round = this.rounds.get(version)
    if (!round) return
    if (channelId) round.confirmed.add(channelId)
    round.pending = {
      ...round.pending,
      bag: updateBagParticipant(round.pending.bag, version, participantId),
    }
  }

  /** How many participants have confirmed round `version` so far. */
  confirmedCount(version: number): number {
    return this.rounds.get(version)?.pending.bag.currentVersion.participantIds.length ?? 0
  }

  /**
   * Whether every participant round `version` sent a share to has answered —
   * confirmed or refused. What a round still waits on after that is its
   * replica leg alone, which is best-effort and never decides the outcome.
   */
  helpersAnswered(version: number): boolean {
    const round = this.rounds.get(version)
    if (!round) return false
    return [...round.awaiting].every(channelId => round.confirmed.has(channelId))
  }

  /** Stop waiting on the share round `version` sent over `channelId`. */
  dropShare(channelId: string, version: number): void {
    this.rounds.get(version)?.awaiting.delete(channelId)
  }

  /** A participant refused its share of `version`. */
  recordShareFailed(version: number, failure: ShareFailure): void {
    const round = this.rounds.get(version)
    if (!round) return
    round.pending = {
      ...round.pending,
      bag: updateBagVersion(round.pending.bag, version, v => ({
        ...v,
        failedParticipantIds: [...(v.failedParticipantIds ?? []), failure],
      })),
    }
  }

  /**
   * Consume the staged bag of round `version`.
   *
   * Only *that* round's completion may consume it: several rounds can be in
   * flight at once — the pair-completion hook and the promotion inside
   * `verifyFingerprint` both publish unasked — and letting any completion clear
   * it discards a bag still waiting for its own, so the secret is never
   * committed.
   */
  completeRound(version: number): PendingBag | null {
    const open = this.rounds.get(version)
    if (open) {
      this.rounds.delete(version)
      return open.pending
    }
    // Resolved after the watchdog gave up on it — see `abandoned`.
    const late = this.abandoned.get(version)
    if (late) {
      this.abandoned.delete(version)
      return late
    }
    return null
  }

  /**
   * Give up on round `version`. Returns whether it was still pending — a round
   * that already resolved is left alone.
   */
  abandonRound(version: number): boolean {
    const open = this.rounds.get(version)
    if (!open) return false
    this.rounds.delete(version)
    this.abandoned.set(version, open.pending)
    while (this.abandoned.size > ABANDONED_ROUNDS_KEPT) {
      const oldest = Math.min(...this.abandoned.keys())
      this.abandoned.delete(oldest)
    }
    return true
  }

  /** Forget every challenge still in flight — the watchdog gave up. */
  abandonAll(): void {
    this.verifications.clear()
  }

  // ── Verification ───────────────────────────────────────────────────────────

  beginVerification(channelId: string, challenge: VerificationChallenge): void {
    this.verifications.set(channelId, challenge)
  }

  /**
   * Whether a challenge on `channelId` — for `version`, when given — is still
   * awaiting its answer. A challenge past its deadline is not.
   */
  isAwaitingVerification(channelId: string, version?: number, now = Date.now()): boolean {
    const challenge = this.verifications.get(channelId)
    if (!challenge || challenge.deadline <= now) return false
    return version === undefined || challenge.version === version
  }

  /** The challenge on `channelId` was answered. */
  endVerification(channelId: string): void {
    this.verifications.delete(channelId)
  }

  /** The challenges still awaiting an answer, as the vault record persists them. */
  snapshotVerifications(now = Date.now()): PendingVerification[] {
    return [...this.verifications.entries()]
      .filter(([, challenge]) => challenge.deadline > now)
      .map(([channelId, challenge]) => ({ channelId, ...challenge }))
  }

  /** Pick persisted challenges back up after a reload. Expired ones are dropped. */
  resumeVerifications(pending: readonly PendingVerification[], now = Date.now()): void {
    for (const { channelId, protocolSecretId, version, deadline } of pending) {
      if (deadline > now && !this.verifications.has(channelId)) {
        this.verifications.set(channelId, { protocolSecretId, version, deadline })
      }
    }
  }

  // ── Recovery ───────────────────────────────────────────────────────────────

  beginRecovery(request: RecoveryRequest): void {
    this.recovery = request
  }

  /** The in-flight recovery request, which is then no longer in flight. */
  takeRecovery(): RecoveryRequest | null {
    const request = this.recovery
    this.recovery = null
    return request
  }
}

/**
 * Commit a completed round's version into the bag the vault holds.
 *
 * Only the round's own version is taken from its staged bag; everything else
 * comes from what is committed now. Rounds complete in any order, and taking
 * the staged bag wholesale let an older round finishing last roll the bag back
 * to its own version — or resurrect a round, staged in between, that failed.
 */
export function commitRoundVersion(committed: SecretBag | null, staged: SecretBag): SecretBag {
  const landed = staged.currentVersion
  if (!committed) return { ...staged, previousVersions: [] }

  const current = committed.currentVersion
  if (landed.version > current.version) {
    return {
      ...committed,
      currentVersion: landed,
      previousVersions: [current, ...committed.previousVersions].filter(
        v => v.version !== landed.version,
      ),
    }
  }
  if (landed.version === current.version) return { ...committed, currentVersion: landed }

  // An older round finishing after a newer one: history, not the current version.
  const previousVersions = [
    landed,
    ...committed.previousVersions.filter(v => v.version !== landed.version),
  ].sort((a, b) => b.version - a.version)
  return { ...committed, previousVersions }
}

/**
 * Close out the shares of round `version` that never got an answer, as
 * refused.
 *
 * The round is over — the library gave up on them, or the watchdog did — so a
 * row still "waiting" would wait forever. Refused is what they amount to: the
 * helper does not hold this version. Confirmed shares are left exactly as they
 * are, which is what keeps the progress view from going backwards.
 */
/** What a participant that never answered a closed round is recorded with. */
export const UNANSWERED_MEMO = 'No answer before the round closed'

export function settleUnansweredShares(
  participants: readonly PairedParticipant[],
  version: number,
): PairedParticipant[] {
  return participants.map(p =>
    p.secretShares.some(s => s.version === version && s.status === 'pending')
      ? {
          ...p,
          secretShares: p.secretShares.map(s =>
            s.version === version && s.status === 'pending'
              ? { ...s, status: 'rejected' as const, failure: { status: 0, memo: UNANSWERED_MEMO } }
              : s,
          ),
        }
      : p,
  )
}
