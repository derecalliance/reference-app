// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useEffect, useState } from 'react'

import { splitPairedChannels } from '../ownerPairing'
import type { PairedParticipant } from '../types'
import { buildLinkGroups, type LinkGroup } from './linkGroups'

/** The slice of the channel store this needs: the link closure of one channel. */
export interface LinkClosureSource {
  linkedChannels: (secretId: string, channelId: string) => Promise<string[]>
}

export interface UseLinkGroupsOptions {
  participants: PairedParticipant[]
  mainChannels: readonly string[] | undefined
  /** Bumped after a link so the closure is re-read. */
  linkVersion: number
  /**
   * Read when the effect runs, not during render — the protocol instance is
   * built in an effect of its own, so at first render there is nothing to read
   * and a value captured then would be null for the life of the closure.
   */
  getChannelStore: () => LinkClosureSource | null
  getSecretId: () => string
}

/**
 * Linked-channel groups for the Channels tab.
 *
 * The link graph lives in the channel store rather than in React state, so this
 * has to go and read it; that is what makes it an effect and not a `useMemo`.
 * Recomputed when the participants change, when a link is made, or when the
 * main-channel hint moves.
 */
export function useLinkGroups({
  participants,
  mainChannels,
  linkVersion,
  getChannelStore,
  getSecretId,
}: UseLinkGroupsOptions): LinkGroup[] {
  const [groups, setGroups] = useState<LinkGroup[]>([])

  useEffect(() => {
    let cancelled = false
    const channelStore = getChannelStore()
    // Participant channels only. A replica is listed in the Replicas tab and
    // nowhere else, so it never enters the grouping that feeds this list —
    // which also means it can never be swallowed into a linked group by a stale
    // link record and drawn with participant markup.
    const paired = splitPairedChannels(participants).participants

    async function compute() {
      const closures = new Map<string, string[]>()
      for (const p of paired) {
        let closure = [p.channelId]
        if (channelStore) {
          try {
            closure = await channelStore.linkedChannels(getSecretId(), p.channelId)
          } catch {
            // A channel the store has no record of links only to itself.
            closure = [p.channelId]
          }
        }
        closures.set(p.channelId, closure)
      }

      if (!cancelled) setGroups(buildLinkGroups(paired, closures, mainChannels ?? []))
    }

    void compute()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants, mainChannels, linkVersion])

  return groups
}
