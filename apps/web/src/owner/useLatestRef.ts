import { useEffect, useRef } from 'react'

/**
 * A ref that always holds the latest value of `value`.
 *
 * The owner page runs several long-lived loops — mailbox polling, the protocol
 * tick, roster reconciliation — that are started once and then read state for
 * as long as they live. Reading it from a closure would pin them to the render
 * that created them, so they read it through a ref instead.
 *
 * The write stays in an effect rather than happening during render, which is
 * what the hand-written versions of this did: a ref mutated during render is
 * visible to other components before this one has committed, and under
 * concurrent rendering may reflect a render that is later thrown away. The
 * loops here only ever read after commit, so committing the write is both
 * correct and the cheaper guarantee to reason about.
 */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  }, [value])
  return ref
}
