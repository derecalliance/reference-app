import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ThemeProvider, createTheme } from '@mui/material/styles'

/**
 * MUI theming that follows the app's own CSS custom properties.
 *
 * The app is styled by hand in `index.css` and adapts to the system scheme
 * through `@media (prefers-color-scheme: light)`, which reassigns the `--text`,
 * `--bg`, … variables on `:root`. MUI knows nothing about any of that, so
 * without this its surfaces render as default light against a dark app.
 *
 * The palette is dark-first, so dark is the default and light is the override —
 * matching `index.css` rather than MUI's own light default.
 *
 * Two concrete failures this exists to prevent:
 *
 *  - `index.css` sets `h1, h2 { color: var(--text-h) }` globally, and MUI's
 *    `DialogTitle` renders an `<h2>`. In dark mode `--text-h` is near-white, so
 *    a dialog title on MUI's default white paper is white on white. MUI emits
 *    class-based rules, which outrank a bare element selector, so restoring the
 *    theme colour on `MuiTypography` is what fixes it.
 *  - Paper/Dialog backgrounds would otherwise be white inside a dark page.
 *
 * Values are read from the live computed style rather than hardcoded, so the
 * palette cannot drift from `index.css`, and are re-read when the system scheme
 * changes.
 */

const LIGHT_QUERY = '(prefers-color-scheme: light)'

interface ThemeVars {
  text: string
  textHeading: string
  background: string
  surface: string
  border: string
  accent: string
  accentFill: string
  accentContrast: string
  danger: string
  sans: string
}

/** Fallbacks matching `index.css`'s dark `:root` — the default scheme — for
 *  when no stylesheet has been applied yet (initial paint, or a non-browser
 *  test environment). */
const FALLBACK_VARS: ThemeVars = {
  text: '#f4eddd',
  textHeading: '#f4eddd',
  background: '#0f1512',
  surface: '#141c17',
  border: '#26301f',
  accent: '#d2a94e',
  accentFill: '#d2a94e',
  accentContrast: '#0f1512',
  danger: '#e8776a',
  sans: 'system-ui, sans-serif',
}

function readThemeVars(): ThemeVars {
  if (typeof window === 'undefined') return FALLBACK_VARS
  const computed = window.getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): string => {
    const value = computed.getPropertyValue(name).trim()
    return value.length > 0 ? value : fallback
  }
  return {
    text: read('--text', FALLBACK_VARS.text),
    textHeading: read('--text-h', FALLBACK_VARS.textHeading),
    background: read('--bg', FALLBACK_VARS.background),
    surface: read('--surface', FALLBACK_VARS.surface),
    border: read('--border', FALLBACK_VARS.border),
    accent: read('--accent', FALLBACK_VARS.accent),
    accentFill: read('--accent-fill', FALLBACK_VARS.accentFill),
    accentContrast: read('--accent-contrast', FALLBACK_VARS.accentContrast),
    danger: read('--danger', FALLBACK_VARS.danger),
    sans: read('--sans', FALLBACK_VARS.sans),
  }
}

/** True only when the viewer has actively asked for light. Dark is the default,
 *  so "no preference" resolves to dark, exactly as `index.css` does. */
function usePrefersLight(): boolean {
  const [prefersLight, setPrefersLight] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(LIGHT_QUERY).matches,
  )

  useEffect(() => {
    const query = window.matchMedia(LIGHT_QUERY)
    const onChange = (e: MediaQueryListEvent) => setPrefersLight(e.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return prefersLight
}

export interface AppMuiThemeProps {
  children: ReactNode
}

export function AppMuiTheme({ children }: AppMuiThemeProps) {
  const prefersLight = usePrefersLight()

  const theme = useMemo(() => {
    // Re-read on every scheme change: the media query in `index.css` swaps the
    // custom properties, so the previous snapshot is stale.
    const vars = readThemeVars()

    return createTheme({
      palette: {
        mode: prefersLight ? 'light' : 'dark',
        // `main` is the text/border gold, which darkens on cream so links stay
        // legible. `contrastText` is stated rather than derived because MUI
        // would compute white on gold, which is 2.2:1.
        primary: { main: vars.accent, contrastText: vars.accentContrast },
        error: { main: vars.danger },
        background: { default: vars.background, paper: vars.surface },
        text: { primary: vars.textHeading, secondary: vars.text },
        divider: vars.border,
      },
      typography: { fontFamily: vars.sans },
      components: {
        MuiTypography: {
          styleOverrides: {
            // Beats `index.css`'s `h1, h2 { color: … }` element rule, so headings
            // inside MUI surfaces take the surface's colour. Explicit `color`
            // props still win — Typography folds them into `sx`, which is applied
            // after style overrides.
            root: { color: 'inherit' },
          },
        },
        // A contained button is the one place MUI *fills* with the accent, and
        // the text-safe gold is too dark on cream to carry dark text. The fill
        // token keeps the CTA bright in both schemes, as the palette specifies.
        MuiButton: {
          styleOverrides: {
            contained: {
              backgroundColor: vars.accentFill,
              color: vars.accentContrast,
            },
          },
        },
        MuiPaper: {
          styleOverrides: {
            root: ({ theme: t }) => ({ color: t.palette.text.primary }),
          },
        },
        MuiDialog: {
          styleOverrides: {
            paper: ({ theme: t }) => ({ color: t.palette.text.primary }),
          },
        },
      },
    })
  }, [prefersLight])

  return <ThemeProvider theme={theme}>{children}</ThemeProvider>
}
