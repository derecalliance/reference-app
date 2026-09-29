import { useState, type ComponentType, type ReactNode } from 'react'
import GroupsIcon from '@mui/icons-material/Groups'
import MenuIcon from '@mui/icons-material/Menu'
import PersonIcon from '@mui/icons-material/Person'
import SettingsIcon from '@mui/icons-material/Settings'
import TroubleshootIcon from '@mui/icons-material/Troubleshoot'
import {
  Box,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  useMediaQuery,
  useTheme,
} from '@mui/material'

import { loadSection, persistSection, type AppSection } from './adminSection'
import { InspectTab } from './admin/InspectTab'
import { ParticipantsPane } from './admin/ParticipantsPane'
import { SettingsPane } from './admin/SettingsPane'

const DRAWER_WIDTH = 216

const NAV: ReadonlyArray<{
  section: AppSection
  label: string
  icon: ComponentType
}> = [
  { section: 'owner', label: 'Owner', icon: PersonIcon },
  { section: 'participants', label: 'Participants', icon: GroupsIcon },
  { section: 'settings', label: 'Settings', icon: SettingsIcon },
  { section: 'inspect', label: 'Inspect', icon: TroubleshootIcon },
]

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
 * Sections are state rather than routes. The app has no client-side routing,
 * which is why the backend's static fallback carries no SPA rewrite; adding a
 * URL here would mean changing the server to serve it.
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

  function select(next: AppSection) {
    setSection(next)
    persistSection(next)
    setDrawerOpen(false)
  }

  const nav = (
    <List component="nav" aria-label="App sections" sx={{ pt: { xs: 1, lg: 2 } }}>
      {NAV.map(({ section: value, label, icon: Icon }) => {
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
      })}
    </List>
  )

  // Admin sections get a common frame. They were written for — or in
  // `InspectTab`'s case, moved out of — the owner page's tab panel, which
  // supplied padding and overrode the `text-align: center` that `#root` sets
  // globally. Without it they inherit centered prose and run to the window edge.
  const adminFrame = (pane: ReactNode) => (
    <Box sx={{ textAlign: 'left', p: { xs: 2, lg: 3 }, width: '100%', minWidth: 0 }}>
      {pane}
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
              borderBottom: 1,
              borderColor: 'divider',
            }}
          >
            <IconButton
              aria-label="Open sections"
              onClick={() => setDrawerOpen(true)}
              sx={{ m: 0.5 }}
            >
              <MenuIcon />
            </IconButton>
          </Box>
          <Drawer
            variant="temporary"
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            // Kept mounted so the nav is in the DOM for assistive technology
            // and for tests, rather than appearing only once opened.
            ModalProps={{ keepMounted: true }}
            sx={{ '& .MuiDrawer-paper': { width: DRAWER_WIDTH } }}
          >
            {nav}
          </Drawer>
        </>
      )}

      {/* The scroll container for whatever section is showing; `main` no longer
          scrolls, so this does. */}
      <Box sx={{ flexGrow: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'auto' }}>
        {/* The owner's content is passed through untouched — it brings its own
            layout, and the wizard still wants the centering it always had. */}
        {section === 'owner' && children}
        {section === 'participants' && adminFrame(<ParticipantsPane />)}
        {section === 'settings' && adminFrame(<SettingsPane />)}
        {section === 'inspect' && adminFrame(<InspectTab />)}
      </Box>
    </Box>
  )
}
