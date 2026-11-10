// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/** Channel id → the send time of the newest update accepted on it, in Unix seconds. */
type UpdateLog = Record<string, number>

/**
 * The newest `UpdateChannelInfo` this device accepted on each channel.
 *
 * A peer's contact update replaces the endpoints and details stored for it,
 * so an older one applied after a newer one moves the channel back to where
 * the peer no longer is. The replay guard catches a second delivery of the
 * same message, but not one held back and delivered late — that is a first
 * delivery. SDK 0.0.11 leaves the rest to the application: reject a contact
 * update older than the last one accepted on the channel.
 *
 * Kept in localStorage, beside the stores of the instance it belongs to.
 */
export class ChannelUpdateClock {
  private readonly storageKey: string

  constructor(namespace: string, secretId: string) {
    this.storageKey = `${namespace}:${secretId}:channel-update-at`
  }

  /** Whether an update sent at `sentAt` is older than one already accepted on `channelId`. */
  isOlderThanAccepted(channelId: string, sentAt: number): boolean {
    const accepted = this.load()[channelId]
    return accepted !== undefined && sentAt < accepted
  }

  /** Record that an update sent at `sentAt` was accepted on `channelId`. */
  recordAccepted(channelId: string, sentAt: number): void {
    const log = this.load()
    log[channelId] = Math.max(log[channelId] ?? 0, sentAt)
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(log))
    } catch {
      // A full storage only loses this guard, as before it existed.
    }
  }

  private load(): UpdateLog {
    try {
      const raw = localStorage.getItem(this.storageKey)
      const parsed: unknown = raw ? JSON.parse(raw) : {}
      return parsed && typeof parsed === 'object' ? (parsed as UpdateLog) : {}
    } catch {
      return {}
    }
  }
}
