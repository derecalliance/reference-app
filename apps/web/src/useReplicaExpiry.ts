import { useEffect, useState } from 'react'
import {
  replicaChannelExpiry,
  type ReplicaChannelTiming,
  type ReplicaExpiry,
} from './replicaFlows'

/**
 * The live clock behind the replica expiry notice.
 *
 * A channel the library still holds `Pending` is dropped once it has been
 * pending longer than the configured protocol timeout, and that clock runs from
 * the channel's creation rather than from the last thing the user did — so
 * someone comparing codes carefully can lose it mid-comparison. The rule itself
 * is [`replicaChannelExpiry`], which is pure and takes `now`; this only feeds it
 * a clock.
 */

const TICK_MS = 1000

/**
 * A live [`ReplicaExpiry`] for one channel, or `null` when nothing expires.
 *
 * The clock lives in whichever component calls this, so a ticking countdown
 * re-renders that component and nothing above it — the panel and its other rows
 * are untouched. The interval is cleared on unmount, whenever the channel being
 * counted changes, and as soon as the deadline passes, since an expired channel
 * has nothing left to count.
 */
export function useReplicaExpiry(
  channel: ReplicaChannelTiming,
  timeoutSecs: number,
): ReplicaExpiry | null {
  const { status, establishedAt } = channel
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // Re-read the clock whenever the channel being counted changes: `now` only
    // advances while a countdown is running, so a row that becomes pending
    // later would otherwise be measured against a clock frozen at mount and
    // read as long expired.
    const advance = (): ReplicaExpiry | null => {
      const at = Date.now()
      setNow(at)
      return replicaChannelExpiry({ status, establishedAt }, timeoutSecs, at)
    }

    const current = advance()
    if (current === null || current.state === 'expired') return

    const id = setInterval(() => {
      const next = advance()
      if (next === null || next.state === 'expired') clearInterval(id)
    }, TICK_MS)
    return () => clearInterval(id)
  }, [status, establishedAt, timeoutSecs])

  return replicaChannelExpiry({ status, establishedAt }, timeoutSecs, now)
}
