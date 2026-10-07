// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import {
  createContext,
  useCallback,
  useContext,
  useReducer,
  type ReactNode,
} from 'react'
import { useEffect, useRef } from 'react'
import { randomId } from './randomId'
import { apiGetDebugEvents, type DebugEvent } from './api'


/**
 * Who the entry is about.
 *
 * `server` entries come from the backend's own log rather than this page —
 * the half of the story the browser could never see, polled from
 * `/debug/events`. See AGENTS.md.
 */
export type ConsoleRole = 'owner' | 'participant' | 'server'
export type ConsoleFlow =
  | 'setup'
  | 'pairing'
  | 'unpairing'
  | 'sharing'
  | 'verification'
  | 'discovery'
  | 'recovery'
  | 'protocol'
  /** Message delivery, as the backend saw it. */
  | 'transport'

export interface ConsoleEntry {
  id: string
  timestamp: Date
  role: ConsoleRole
  flow: ConsoleFlow
  step: string
  description: string
  /** Inputs passed to the library function */
  payload?: unknown
  /** Outputs returned by the library function (wire bytes, keys, etc.) */
  response?: unknown
  /**
   * The vault this entry is about. `server` entries have none: backend events
   * are node-wide, and forcing a vault onto them would file them under an
   * arbitrary one.
   */
  vaultId?: string
}

/** What a caller supplies; the id and time are stamped on. */
export type ConsoleEntryInput = Omit<ConsoleEntry, 'id' | 'timestamp'>

/** Build an entry from what a caller supplies. */
// eslint-disable-next-line react-refresh/only-export-components
export function makeConsoleEntry(input: ConsoleEntryInput, at: Date = new Date()): ConsoleEntry {
  return { ...input, id: randomId(), timestamp: at }
}


interface State {
  entries: ConsoleEntry[]
}

type Action =
  | { type: 'log'; entry: ConsoleEntry }
  | { type: 'clear' }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'log':
      return { entries: [action.entry, ...state.entries] }
    case 'clear':
      return { entries: [] }
  }
}


interface ConsoleContextValue {
  entries: ConsoleEntry[]
  log: (entry: ConsoleEntryInput) => void
  clear: () => void
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null)


/** How a backend event reads as a console row. */
function toEntry(event: DebugEvent): ConsoleEntry {
  const arrow = event.direction === 'inbound' ? '←' : '→'
  const carrier =
    event.carrier === 'grpc_via_relay' ? 'gRPC (relayed)' : event.carrier.toUpperCase()

  return makeConsoleEntry({
    role: 'server',
    flow: 'transport',
    step: `${arrow} ${carrier}`,
    description: event.detail,
    // The whole event, so "copy entry" yields something worth pasting into a
    // bug report — and matches what `/debug/events` would have given.
    payload: event,
  }, new Date(event.at_ms))
}

export function ConsoleProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { entries: [] })

  const log = useCallback((entry: ConsoleEntryInput) => {
    dispatch({ type: 'log', entry: makeConsoleEntry(entry) })
  }, [])

  const clear = useCallback(() => dispatch({ type: 'clear' }), [])

  // Pull the backend's own log in beside this page's.
  //
  // Until this existed the console showed only what the browser drove, so a
  // message that never arrived left no trace anywhere a developer would look.
  // Polling from the provider rather than the panel means the history is
  // complete even while the panel is collapsed.
  const cursor = useRef(0)
  useEffect(() => {
    let cancelled = false

    const tick = async () => {
      try {
        const page = await apiGetDebugEvents(cursor.current)
        if (cancelled || page.events.length === 0) return
        cursor.current = page.latest_seq
        // Ascending, and `log` prepends, so the newest ends up on top —
        // interleaved with this page's entries by arrival, as a reader expects.
        for (const event of page.events) {
          dispatch({ type: 'log', entry: toEntry(event) })
        }
      } catch {
        // The backend is legitimately absent during setup, and a console that
        // shouted about it every two seconds would be worse than one that
        // quietly catches up when it returns.
      }
    }

    const first = setTimeout(() => void tick(), 0)
    const repeat = setInterval(() => void tick(), 2000)
    return () => {
      cancelled = true
      clearTimeout(first)
      clearInterval(repeat)
    }
  }, [])

  return (
    <ConsoleContext.Provider value={{ entries: state.entries, log, clear }}>
      {children}
    </ConsoleContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useConsole(): ConsoleContextValue {
  const ctx = useContext(ConsoleContext)
  if (!ctx) throw new Error('useConsole must be used within a ConsoleProvider')
  return ctx
}
