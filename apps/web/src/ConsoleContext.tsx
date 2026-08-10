import {
  createContext,
  useCallback,
  useContext,
  useReducer,
  type ReactNode,
} from 'react'


export type ConsoleRole = 'owner' | 'participant'
export type ConsoleFlow =
  | 'session'
  | 'pairing'
  | 'unpairing'
  | 'sharing'
  | 'verification'
  | 'discovery'
  | 'recovery'
  | 'replica'
  | 'protocol'

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
  log: (entry: Omit<ConsoleEntry, 'id' | 'timestamp'>) => void
  clear: () => void
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null)


export function ConsoleProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { entries: [] })

  const log = useCallback((entry: Omit<ConsoleEntry, 'id' | 'timestamp'>) => {
    dispatch({
      type: 'log',
      entry: { ...entry, id: crypto.randomUUID(), timestamp: new Date() },
    })
  }, [])

  const clear = useCallback(() => dispatch({ type: 'clear' }), [])

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
