import { createContext, useContext, type ReactNode } from 'react'
import { DEFAULT_PROTOCOL_TIMEOUT_SECS } from './config'

// Protocol config exposed to the whole owner subtree, so deeply
// nested components (pairing-wait, verification round, …) read the configured
// timeout without prop-drilling.

const ProtocolTimeoutMsContext = createContext<number>(
  DEFAULT_PROTOCOL_TIMEOUT_SECS * 1000,
)

export function ProtocolConfigProvider({
  timeoutMs,
  children,
}: {
  timeoutMs: number
  children: ReactNode
}) {
  return (
    <ProtocolTimeoutMsContext.Provider value={timeoutMs}>
      {children}
    </ProtocolTimeoutMsContext.Provider>
  )
}

/** Active wall-clock protocol timeout in ms (falls back to the default). */
// eslint-disable-next-line react-refresh/only-export-components
export function useProtocolTimeoutMs(): number {
  return useContext(ProtocolTimeoutMsContext)
}
