/**
 * Which top-level section of the app is showing.
 *
 * Not a route, deliberately. The app has no client-side routing — every screen
 * lives at the base path, which is why the backend's static fallback carries no
 * SPA rewrite — so this is state. It persists so a reload does not lose your
 * place, which matters most for the admin sections: an operator watching a node
 * reloads constantly.
 *
 * The cost of not being a route is real and worth knowing: no deep links, and
 * the back button does not move between sections.
 */
export type AppSection = 'owner' | 'participants' | 'settings' | 'inspect'

/** Every section, in nav order. */
export const APP_SECTIONS: readonly AppSection[] = [
  'owner',
  'participants',
  'settings',
  'inspect',
]

const STORAGE_KEY = 'derec.section'

function isSection(value: string | null): value is AppSection {
  return value !== null && (APP_SECTIONS as readonly string[]).includes(value)
}

/**
 * The section to open on load, defaulting to the owner.
 *
 * A stored value that is not a section — left by an older build, or edited by
 * hand — falls back rather than rendering nothing.
 */
export function loadSection(): AppSection {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isSection(stored) ? stored : 'owner'
  } catch {
    // Storage can be unavailable entirely. The app runs without it; only the
    // "where was I" convenience is lost.
    return 'owner'
  }
}

export function persistSection(section: AppSection): void {
  try {
    localStorage.setItem(STORAGE_KEY, section)
  } catch {
    // Safari in private mode throws here rather than no-opping. Losing the
    // persistence is acceptable; taking the app down over it is not.
  }
}
