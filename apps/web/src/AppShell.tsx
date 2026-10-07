// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import GroupsIcon from '@mui/icons-material/Groups'
import HelpOutlineIcon from '@mui/icons-material/HelpOutline'
import MenuIcon from '@mui/icons-material/Menu'
import PersonIcon from '@mui/icons-material/Person'
import SettingsIcon from '@mui/icons-material/Settings'
import TroubleshootIcon from '@mui/icons-material/Troubleshoot'
import {
  Box,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
  useMediaQuery,
  alpha,
  useTheme,
} from '@mui/material'

import { loadSection, persistSection, type AppSection } from './adminSection'
import { parseHash } from './routing'

// The operator sections load on first visit. Most sessions live in the Owner
// section, and these — with the tables and forms only they use — kept the
// first load a single oversized script.
const InspectTab = lazy(() => import('./admin/InspectTab').then(m => ({ default: m.InspectTab })))
const ParticipantsPane = lazy(() =>
  import('./admin/ParticipantsPane').then(m => ({ default: m.ParticipantsPane })),
)
const SettingsPane = lazy(() => import('./admin/SettingsPane').then(m => ({ default: m.SettingsPane })))
// Help carries its Markdown renderer and every topic's text; none of it is
// needed until the section is first opened.
const HelpPane = lazy(() => import('./help/HelpPane').then(m => ({ default: m.HelpPane })))

const DRAWER_WIDTH = 216

/** The width at which the stylesheets switch to the phone layout. */
const PHONE_QUERY = '@media (max-width: 640px)'

interface NavItem {
  section: AppSection
  label: string
  icon: ComponentType
}

const NAV: readonly NavItem[] = [
  { section: 'owner', label: 'Owner', icon: PersonIcon },
  { section: 'participants', label: 'Participants', icon: GroupsIcon },
  { section: 'settings', label: 'Settings', icon: SettingsIcon },
  { section: 'inspect', label: 'Inspect', icon: TroubleshootIcon },
]

/** Pinned to the foot of the rail, apart from the sections it explains. */
const HELP_ITEM: NavItem = { section: 'help', label: 'Help', icon: HelpOutlineIcon }

export interface AppShellProps {
  /**
   * What the Owner section shows — the setup wizard, or the owner page.
   *
   * Passed in rather than built here. The shell owns navigation; owner
   * identity, the browser lock and persistence stay with `App`. Keeping them
   * out is what lets the admin sections work with no owner at all, which is the
   * reason this shell exists.
   */
  children: ReactNode
}

/**
 * The app's top-level navigation: one owner surface and three operator ones.
 *
 * Those are two different jobs against two different scopes — an owner is per
 * browser context, while the operator surface is about the node — and they used
 * to be nested, with the participant pool living inside the owner page.
 *
 * Sections are state rather than routes. Only the Owner section's own screens
 * — the vault list, the wizard, one vault — are addressed, by hash routes (see
 * `routing.ts`), which need no server-side rewrite.
 */
export function AppShell({ children }: AppShellProps) {
  const [section, setSection] = useState<AppSection>(loadSection)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const theme = useTheme()
  // Permanent from `lg`, not `md`. The owner page is a two-column layout of its
  // own — channel list plus the participants panel — and below about 1200px the
  // rail's 216px squeezes it enough to truncate its tab bar. Collapsing to a
  // hamburger gives that page the full width it had before the shell existed.
  const permanent = useMediaQuery(theme.breakpoints.up('lg'))
  const currentLabel =
    [...NAV, HELP_ITEM].find(item => item.section === section)?.label ?? ''

  function select(next: AppSection) {
    setSection(next)
    persistSection(next)
    setDrawerOpen(false)
  }

  // A route to a vault or the wizard is an Owner-section route. Following one —
  // a banner click, a pasted link — from another section must bring the Owner
  // section up, or the vault would change with nothing on screen to show it.
  useEffect(() => {
    const onRoute = () => {
      if (parseHash(window.location.hash).kind !== 'list') {
        setSection('owner')
        persistSection('owner')
      }
    }
    window.addEventListener('hashchange', onRoute)
    return () => window.removeEventListener('hashchange', onRoute)
  }, [])

  const navButton = ({ section: value, label, icon: Icon }: NavItem) => {
    const current = section === value
    return (
      <ListItemButton
        key={value}
        selected={current}
        // Selection is state, not decoration: the highlight alone leaves it
        // unavailable to anyone not looking at the colour.
        aria-current={current ? 'page' : undefined}
        onClick={() => select(value)}
      >
        <ListItemIcon sx={{ minWidth: 40 }}>
          <Icon />
        </ListItemIcon>
        <ListItemText primary={label} />
      </ListItemButton>
    )
  }

  // One landmark holding both lists: the sections at the top, Help pinned to
  // the bottom. Help is set apart and tinted with the accent so a developer
  // who has not found their way yet notices it, without competing with the
  // selected section's own highlight.
  const helpCurrent = section === HELP_ITEM.section
  const nav = (
    <Box
      component="nav"
      aria-label="App sections"
      sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}
    >
      <List sx={{ pt: { xs: 1, lg: 2 } }}>{NAV.map(navButton)}</List>
      <Box sx={{ flexGrow: 1 }} />
      <Divider />
      <List sx={{ py: 1 }}>
        <ListItemButton
          selected={helpCurrent}
          aria-current={helpCurrent ? 'page' : undefined}
          onClick={() => select(HELP_ITEM.section)}
          sx={t => ({
            mx: 1,
            borderRadius: 1,
            border: 1,
            borderColor: alpha(t.palette.primary.main, 0.4),
            bgcolor: alpha(t.palette.primary.main, 0.08),
            '&:hover': { bgcolor: alpha(t.palette.primary.main, 0.16) },
            '&.Mui-selected, &.Mui-selected:hover': {
              bgcolor: alpha(t.palette.primary.main, 0.22),
            },
          })}
        >
          <ListItemIcon sx={{ minWidth: 40, color: 'primary.main' }}>
            <HELP_ITEM.icon />
          </ListItemIcon>
          <ListItemText primary={HELP_ITEM.label} />
        </ListItemButton>
      </List>
    </Box>
  )

  // Admin sections get a common frame. They were written for — or in
  // `InspectTab`'s case, moved out of — the owner page's tab panel, which
  // supplied padding and overrode the `text-align: center` that `#root` sets
  // globally. Without it they inherit centered prose and run to the window edge.
  const adminFrame = (pane: ReactNode) => (
    <Box sx={{ textAlign: 'left', p: { xs: 2, lg: 3 }, width: '100%', minWidth: 0 }}>
      <Suspense
        fallback={<CircularProgress size={24} aria-label="Loading section" />}
      >
        {pane}
      </Suspense>
    </Box>
  )

  return (
    // Fills the host element rather than sizing to its content: the rail is a
    // full-height edge of the page, not a floating card. Row where the rail sits
    // beside the content, column where the hamburger sits above it.
    <Box
      sx={{
        display: 'flex',
        flexDirection: permanent ? 'row' : 'column',
        flex: 1,
        minHeight: 0,
        width: '100%',
      }}
    >
      {permanent ? (
        <Drawer
          variant="permanent"
          sx={{
            width: DRAWER_WIDTH,
            flexShrink: 0,
            '& .MuiDrawer-paper': {
              width: DRAWER_WIDTH,
              boxSizing: 'border-box',
              // Sits inside the existing page chrome rather than over it: the
              // app already has a header and a footer of its own.
              position: 'static',
              height: '100%',
              borderRight: 1,
              borderColor: 'divider',
            },
          }}
        >
          {nav}
        </Drawer>
      ) : (
        <>
          {/* Its own row, so the control sits at the top of the page rather
              than floating against the middle of the content. */}
          <Box
            sx={{
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              borderBottom: 1,
              borderColor: 'divider',
            }}
          >
            <IconButton
              aria-label="Open sections"
              onClick={() => setDrawerOpen(true)}
              size="small"
              sx={{ m: 0.5 }}
            >
              <MenuIcon />
            </IconButton>
            {/* Says where the menu has taken you; without it the row is a lone
                icon and the section on screen is only guessable. */}
            <Typography variant="body2" color="text.secondary" component="span">
              {currentLabel}
            </Typography>
          </Box>
          <Drawer
            variant="temporary"
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            // Kept mounted so the nav is in the DOM for assistive technology
            // and for tests, rather than appearing only once opened.
            ModalProps={{ keepMounted: true }}
            sx={{ '& .MuiDrawer-paper': { width: DRAWER_WIDTH, height: '100%' } }}
          >
            {nav}
          </Drawer>
        </>
      )}

      {/* The scroll container for whatever section is showing; `main` no longer
          scrolls, so this does — except on a phone, where the whole document
          scrolls instead (see `#root` in index.css). */}
      <Box
        sx={{
          flexGrow: 1,
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          overflow: 'auto',
          [PHONE_QUERY]: { overflow: 'visible' },
        }}
      >
        {/* The owner's content is passed through untouched — it brings its own
            layout, and the wizard still wants the centering it always had. */}
        {section === 'owner' && children}
        {section === 'participants' && adminFrame(<ParticipantsPane />)}
        {section === 'settings' && adminFrame(<SettingsPane />)}
        {section === 'inspect' && adminFrame(<InspectTab />)}
        {section === 'help' && adminFrame(<HelpPane />)}
      </Box>
    </Box>
  )
}
