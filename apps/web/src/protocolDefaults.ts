import type { ServerDefaults } from './config'
import { fitTransportsTo } from './transportMix'

/**
 * Browser-local overrides for the node's protocol defaults.
 *
 * The backend resolves its own set at boot — from its config file and `DEREC_*`
 * variables — and serves them from `GET /config`. It holds no policy about them
 * beyond that: the values a node actually runs with are whatever the front end
 * sends on each provisioning request. That is what makes these editable here
 * without an endpoint to write them.
 *
 * Stored as a *partial* rather than a full copy, deliberately. Freezing a whole
 * snapshot would mean a node reconfigured and restarted still handed a
 * developer the values it had when they last opened Settings, with nothing on
 * screen explaining why. An override names only what it changes; everything
 * else keeps following the server.
 */
export type DefaultOverrides = Partial<ServerDefaults>

const STORAGE_KEY = 'derec.protocolDefaults'

/** The overrides this browser has stored, or none. */
export function loadDefaultOverrides(): DefaultOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return {}

    const parsed: unknown = JSON.parse(raw)
    // A non-object here is a stale or hand-edited value. Spreading a string
    // would produce indexed character keys rather than failing, so the shape is
    // checked rather than trusted.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {}
    }
    return parsed as DefaultOverrides
  } catch {
    // Unparseable, or storage unavailable. This is a convenience layer; losing
    // it must not take a screen down.
    return {}
  }
}

export function persistDefaultOverrides(overrides: DefaultOverrides): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
  } catch {
    // Safari in private mode throws rather than no-opping.
  }
}

export function clearDefaultOverrides(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // As above.
  }
}

/**
 * What to actually provision with: the node's values, with any local overrides
 * on top.
 *
 * The single place that merge happens, so the setup wizard, the Participants
 * pane and the Settings pane cannot disagree about what a default is.
 */
export function effectiveDefaults(server: ServerDefaults): ServerDefaults {
  const merged = { ...server, ...loadDefaultOverrides() }

  // The count and the breakdown are configured separately, so a merge can
  // produce a pair that disagree — override the count alone and the breakdown
  // still carries the node's. The backend rejects that outright ("transports
  // must sum to total"), so reconciling here is what stops a perfectly
  // reasonable Settings edit from making provisioning fail.
  return {
    ...merged,
    helperTransports: fitTransportsTo(merged.helperTransports, merged.participantCount),
  }
}
