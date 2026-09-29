import { useEffect } from 'react'

/**
 * Reject a pending confirmation that nobody answered in time.
 *
 * Three inbound flows — store-share, verify-share and unpair — each raise a
 * modal and then wait. A modal left open past the protocol timeout strands the
 * peer on the other end, which is the failure this guards: the peer gets an
 * explicit rejection instead of silence.
 *
 * `reject` is deliberately *not* a dependency. The timer is armed once when
 * `pending` appears and must call the handler as it stood in that render —
 * adding it would re-arm the timeout on every render that redefines the
 * handler, which is every render, and the rejection would never fire.
 */
export function useAutoReject(pending: unknown, reject: () => void, timeoutMs: number) {
  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => {
      reject()
    }, timeoutMs)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])
}
