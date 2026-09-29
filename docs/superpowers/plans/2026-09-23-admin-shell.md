# Admin Shell Implementation Plan (Step 1 of the owner/admin split)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a left navigation shell around the app with Owner, Participants, Settings and Inspect sections, reachable without an owner existing — and move `Inspect` out of the owner's tabs into it. Nothing else moves yet.

**Architecture:** A new `AppShell` owns the nav and which section is showing; `App` renders it instead of choosing between the setup wizard and the owner page. The shell is MUI (`Drawer`, `List`), permanent above the `md` breakpoint and a hamburger-triggered temporary drawer below it, which requires lifting `AppMuiTheme` from inside `OwnerPage` to the app root. Section state persists to `localStorage`. No client-side routing: the app deliberately has none, and the backend's `ServeDir` fallback has no SPA rewrite.

**Spec:** `docs/superpowers/specs/2026-09-23-admin-owner-split-design.md`

## Global Constraints

- **Baseline:** frontend `npx vitest run` = **412 passing**; `npm run typecheck` clean; Playwright e2e = **48 passed, 4 skipped, 0 failed**. Backend untouched by this plan and must stay at **18 suites / 211 tests**.
- **Step 1 only.** `OwnerPage.tsx` keeps its provisioned-participants `aside` and its pair buttons. Participants and Settings panes are placeholders in this step. If you are deleting the aside, you are in step 2.
- **No client-side routing.** No `react-router`, no URL changes. The shell swaps sections from state.
- **No authentication.** This separates activities, not permissions. Nothing gates a section.
- **MUI, used idiomatically** — `Drawer`, `List`, `ListItemButton`, `Box`, `Typography`, `sx` for styling. No new CSS file; no inline `style`.
- **Accessibility is not optional here:** the nav is the app's primary landmark. `<nav>` semantics, an accessible name, `aria-current` on the selected item, and the hamburger button labelled.
- **The user commits.** Do **not** run `git commit`, `git add` or `git stash`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/web/src/AppShell.tsx` | nav, section switching, persistence | **new** |
| `apps/web/src/adminSection.ts` | the section union + persistence helpers | **new** |
| `apps/web/src/AppShell.test.tsx` | shell behaviour | **new** |
| `apps/web/src/adminSection.test.ts` | persistence edge cases | **new** |
| `apps/web/src/admin/InspectTab.tsx` | moved from `src/InspectTab.tsx` | move |
| `apps/web/src/admin/ParticipantsPane.tsx` | placeholder until step 2 | **new** |
| `apps/web/src/admin/SettingsPane.tsx` | placeholder until step 3 | **new** |
| `apps/web/src/App.tsx` | renders the shell; theme moves to root | modify |
| `apps/web/src/OwnerPage.tsx` | drops the Inspect tab and its inner theme | modify |
| `apps/web/e2e/app.ts` | a nav helper for the specs that use Inspect | modify |

---

## Task 1: The section type and its persistence

Pure logic, no rendering — so it can be tested exhaustively and the shell stays about layout.

**Files:**
- Create: `apps/web/src/adminSection.ts`
- Create: `apps/web/src/adminSection.test.ts`

**Interfaces:**
- `export type AppSection = 'owner' | 'participants' | 'settings' | 'inspect'`
- `export const APP_SECTIONS: readonly AppSection[]`
- `export function loadSection(): AppSection`
- `export function persistSection(section: AppSection): void`

- [ ] **Step 1: Write the failing tests**

```ts
import { afterEach, describe, expect, it } from 'vitest'

import { APP_SECTIONS, loadSection, persistSection, type AppSection } from './adminSection'

/**
 * The selected section survives a reload, because an operator watching a node
 * reloads constantly and being thrown back to the owner page every time is the
 * kind of small friction that makes a tool annoying to live in.
 */
describe('adminSection', () => {
  afterEach(() => localStorage.clear())

  it('starts on owner when nothing is stored', () => {
    // Owner is the app's reason for existing; admin is where you go on purpose.
    expect(loadSection()).toBe('owner')
  })

  it('round-trips every section', () => {
    for (const section of APP_SECTIONS) {
      persistSection(section)
      expect(loadSection()).toBe(section)
    }
  })

  it('falls back to owner when the stored value is not a section', () => {
    // A stale value from an older build, or a hand-edited one. Rendering
    // nothing because a string did not match is worse than starting at home.
    localStorage.setItem('derec.section', 'nonsense')

    expect(loadSection()).toBe('owner')
  })

  it('survives localStorage being unavailable', () => {
    // Safari in private mode throws on setItem rather than no-opping. The app
    // must still run; only the persistence is lost.
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError')
    }

    expect(() => persistSection('inspect')).not.toThrow()

    Storage.prototype.setItem = original
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/adminSection.test.ts`
Expected: the module does not exist.

- [ ] **Step 3: Implement**

```ts
/**
 * Which section of the app is showing.
 *
 * Not a route. The app deliberately has no client-side routing — every screen
 * lives at the base path, which is why the backend's static fallback carries no
 * SPA rewrite — so this is state, persisted so a reload does not lose your
 * place.
 */
export type AppSection = 'owner' | 'participants' | 'settings' | 'inspect'

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

export function loadSection(): AppSection {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isSection(stored) ? stored : 'owner'
  } catch {
    // Storage can be unavailable entirely; the app still runs without it.
    return 'owner'
  }
}

export function persistSection(section: AppSection): void {
  try {
    localStorage.setItem(STORAGE_KEY, section)
  } catch {
    // Safari in private mode throws rather than no-opping. Losing the
    // persistence is acceptable; taking the app down over it is not.
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && npx vitest run src/adminSection.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Report, do not commit**

---

## Task 2: The shell

**Files:**
- Create: `apps/web/src/AppShell.tsx`
- Create: `apps/web/src/AppShell.test.tsx`
- Create: `apps/web/src/admin/ParticipantsPane.tsx`, `apps/web/src/admin/SettingsPane.tsx`
- Move: `apps/web/src/InspectTab.tsx` → `apps/web/src/admin/InspectTab.tsx`

**Interfaces:**
- `export function AppShell({ owner, children }: AppShellProps)` where `children` is what the Owner section renders — the shell does not know about owners, wizards or locks, and must not start.

- [ ] **Step 1: Write the failing tests**

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { AppShell } from './AppShell'

/**
 * The shell is the app's primary navigation, so what it owes is small and
 * strict: every section reachable, the current one announced, and the owner
 * content left alone.
 */
describe('AppShell', () => {
  afterEach(() => localStorage.clear())

  function renderShell() {
    return render(<AppShell>{<p>owner content</p>}</AppShell>)
  }

  it('starts on Owner and renders what it was given', () => {
    renderShell()

    expect(screen.getByText('owner content')).toBeInTheDocument()
  })

  it('marks the current section for assistive technology', () => {
    // Colour alone does not communicate state.
    renderShell()

    expect(screen.getByRole('button', { name: 'Owner' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('switches to a section and back', async () => {
    const user = userEvent.setup()
    renderShell()

    await user.click(screen.getByRole('button', { name: 'Participants' }))
    expect(screen.queryByText('owner content')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Owner' }))
    expect(screen.getByText('owner content')).toBeInTheDocument()
  })

  it('reaches admin with no owner present', () => {
    // The point of the split: an operator should not have to become an owner
    // to manage the node.
    render(<AppShell>{null}</AppShell>)

    expect(screen.getByRole('button', { name: 'Participants' })).toBeEnabled()
  })

  it('remembers the section across a remount', async () => {
    const user = userEvent.setup()
    const { unmount } = renderShell()

    await user.click(screen.getByRole('button', { name: 'Inspect' }))
    unmount()
    renderShell()

    expect(screen.getByRole('button', { name: 'Inspect' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('names the navigation landmark', () => {
    renderShell()

    expect(screen.getByRole('navigation', { name: /sections/i })).toBeInTheDocument()
  })
})
```

**This repo has no `@testing-library`** — checked. `ReplicaChannelRow.test.tsx`
drives components with raw `react-dom/client` `createRoot` plus React's `act`,
sets `IS_REACT_ACT_ENVIRONMENT`, and asserts against real DOM nodes. There is no
setup file and no jest-dom matchers.

Follow that idiom rather than adding three dev dependencies for one file:
CLAUDE.md is explicit about not introducing libraries without strong
justification, and one shell test is not that. The tests above are written in
testing-library style for readability; **translate them** — `host.querySelector`
and `textContent` in place of `screen`, a `click()` inside `act` in place of
`userEvent`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/AppShell.test.tsx`

- [ ] **Step 3: Implement the placeholders**

`admin/ParticipantsPane.tsx` and `admin/SettingsPane.tsx` are deliberately thin
in this step — the shell has to be reviewable before the panes are built:

```tsx
import { Box, Typography } from '@mui/material'

/**
 * The provisioned-participant pool. Filled in step 2 of the split, when the
 * `aside` in `OwnerPage` moves here.
 */
export function ParticipantsPane() {
  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h5" gutterBottom>
        Participants
      </Typography>
      <Typography color="text.secondary">
        The provisioned pool moves here next. For now it is still on the owner
        page.
      </Typography>
    </Box>
  )
}
```

Write `SettingsPane` the same way, naming node configuration and protocol
defaults as what is coming.

- [ ] **Step 4: Move `InspectTab`**

```bash
cd apps/web && mkdir -p src/admin && git mv src/InspectTab.tsx src/admin/InspectTab.tsx
```

Update the import in `OwnerPage.tsx` and **remove the Inspect tab button and its
`activeTab === 'inspect'` branch** — it lives in the shell now. Leave every other
tab alone.

- [ ] **Step 5: Implement the shell**

```tsx
import { useState } from 'react'
import MenuIcon from '@mui/icons-material/Menu'
import PersonIcon from '@mui/icons-material/Person'
import GroupsIcon from '@mui/icons-material/Groups'
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
  Toolbar,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import type { ReactNode } from 'react'

import { loadSection, persistSection, type AppSection } from './adminSection'
import { InspectTab } from './admin/InspectTab'
import { ParticipantsPane } from './admin/ParticipantsPane'
import { SettingsPane } from './admin/SettingsPane'

const DRAWER_WIDTH = 220

const NAV: ReadonlyArray<{
  section: AppSection
  label: string
  icon: typeof PersonIcon
}> = [
  { section: 'owner', label: 'Owner', icon: PersonIcon },
  { section: 'participants', label: 'Participants', icon: GroupsIcon },
  { section: 'settings', label: 'Settings', icon: SettingsIcon },
  { section: 'inspect', label: 'Inspect', icon: TroubleshootIcon },
]

export interface AppShellProps {
  /**
   * What the Owner section shows — the setup wizard or the owner page.
   *
   * Passed in rather than built here: the shell owns navigation, and owner
   * identity, locks and persistence are `App`'s to hold. Keeping them out is
   * what lets the admin sections work with no owner at all.
   */
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const [section, setSection] = useState<AppSection>(loadSection)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const theme = useTheme()
  const permanent = useMediaQuery(theme.breakpoints.up('md'))

  function select(next: AppSection) {
    setSection(next)
    persistSection(next)
    setDrawerOpen(false)
  }

  const nav = (
    <List component="nav" aria-label="App sections">
      {NAV.map(({ section: value, label, icon: Icon }) => (
        <ListItemButton
          key={value}
          selected={section === value}
          // Selection is state, not decoration: colour alone would leave it
          // unavailable to a screen reader.
          aria-current={section === value ? 'page' : undefined}
          onClick={() => select(value)}
        >
          <ListItemIcon>
            <Icon />
          </ListItemIcon>
          <ListItemText primary={label} />
        </ListItemButton>
      ))}
    </List>
  )

  return (
    <Box sx={{ display: 'flex', minHeight: '100%' }}>
      {permanent ? (
        <Drawer
          variant="permanent"
          sx={{
            width: DRAWER_WIDTH,
            flexShrink: 0,
            '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box' },
          }}
        >
          {nav}
        </Drawer>
      ) : (
        <>
          <Toolbar sx={{ position: 'absolute', top: 0, left: 0 }}>
            <IconButton
              aria-label="Open sections"
              onClick={() => setDrawerOpen(true)}
            >
              <MenuIcon />
            </IconButton>
          </Toolbar>
          <Drawer
            variant="temporary"
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            ModalProps={{ keepMounted: true }}
            sx={{ '& .MuiDrawer-paper': { width: DRAWER_WIDTH } }}
          >
            {nav}
          </Drawer>
        </>
      )}

      <Box component="main" sx={{ flexGrow: 1, minWidth: 0 }}>
        {section === 'owner' && children}
        {section === 'participants' && <ParticipantsPane />}
        {section === 'settings' && <SettingsPane />}
        {section === 'inspect' && <InspectTab />}
      </Box>
    </Box>
  )
}
```

**`useMediaQuery` under jsdom** returns `false` unless `matchMedia` is stubbed,
so the tests above exercise the temporary-drawer path by default. If a test needs
the permanent one, stub `window.matchMedia` in that test rather than changing the
component to suit the test.

- [ ] **Step 6: Run the tests**

Run: `cd apps/web && npx vitest run src/AppShell.test.tsx`
Expected: 6 passed.

- [ ] **Step 7: Report, do not commit**

---

## Task 3: Mount the shell and lift the theme

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/OwnerPage.tsx`

- [ ] **Step 1: Lift `AppMuiTheme` to the root**

It currently wraps only the owner page's own subtree (`OwnerPage.tsx:7828`), so
MUI components rendered by the shell would be unthemed. In `App.tsx`:

```tsx
export default function App() {
  return (
    <AppMuiTheme>
      <ToastProvider>
        <ConsoleProvider>
          <AppContent />
        </ConsoleProvider>
      </ToastProvider>
    </AppMuiTheme>
  )
}
```

Then **remove the inner `<AppMuiTheme>` from `OwnerPage.tsx`** rather than
leaving both: two providers with the same theme is a no-op that reads like a
disagreement, and the next person has to check.

- [ ] **Step 2: Render the shell**

Replace the wizard-or-owner ternary in `AppContent` with the shell wrapping it:

```tsx
<AppShell>
  {owner === null
    ? <SetupWizard onReady={adoptOwner} />
    : <OwnerPage owner={owner} onUpdate={handleOwnerUpdate} />}
</AppShell>
```

The `hydrated ? null : …` guard around it stays exactly as it is — the shell
must not flash a section before the owner lock is resolved.

`ConsolePanel` stays where it is, outside the shell.

- [ ] **Step 3: Typecheck and unit tests**

Run: `cd apps/web && npm run typecheck`
Expected: clean.

Run: `cd apps/web && npx vitest run`
Expected: **≥ 422 passing** (412 baseline plus the 10 new), 0 failures.

- [ ] **Step 4: Look at it**

```bash
cd apps/web && npm run dev
```

Open the app. Check, as a user would:

- the nav is there with no owner set up, and Participants/Settings/Inspect open;
- Owner still offers the setup wizard, and completing it still works;
- the owner page no longer has an Inspect tab;
- narrowing the window past `md` collapses the nav to a hamburger that opens a drawer;
- reloading keeps the section you were on.

If any of it looks wrong, fix it now — this is the step where the shape is cheap
to change.

- [ ] **Step 5: Report, do not commit**

---

## Task 4: Keep the end-to-end suite green

Forty-eight Playwright tests drive this UI. They are the suite that caught every
defect in the backend work, and the shell changes what the app renders first.

**Files:**
- Modify: `apps/web/e2e/app.ts`

- [ ] **Step 1: Find what the specs assume**

Run: `cd apps/web && rg -n "Inspect|inspect" e2e/`

The Inspect tab moved out of the owner page. Any spec reaching it needs a nav
click instead of a tab click. Add **one helper** in `e2e/app.ts`:

```ts
/** Open a top-level section from the left nav. */
export async function gotoSection(page: Page, label: string) {
  // The nav is permanent at desktop widths, which is what Playwright runs at,
  // so there is no hamburger to open first.
  await page.getByRole('button', { name: label, exact: true }).click()
}
```

and use it from the specs that need Inspect. **Do not** rewrite selectors that
still work — the aside and the pair buttons are untouched in this step.

- [ ] **Step 2: Run the suite**

Run: `cd apps/web && npm run test:e2e`
Expected: **48 passed, 4 skipped, 0 failed**.

A failure that is not about Inspect means the shell changed something it should
not have. Read `test-results/**/error-context.md` before forming a hypothesis —
that is what identified the recovery bug in the backend work after a wrong guess
had already cost a full run.

- [ ] **Step 3: Report, do not commit**

---

## Definition of Done

- [ ] `npx vitest run`: **≥ 422 passing**, 0 failures
- [ ] `npm run typecheck`: clean
- [ ] `npm run test:e2e`: **48 passed, 4 skipped, 0 failed**
- [ ] The nav is reachable with no owner, and Participants/Settings/Inspect open
- [ ] The owner page has no Inspect tab and still has every other tab
- [ ] The section survives a reload
- [ ] Below `md` the nav is a hamburger drawer
- [ ] `AppMuiTheme` wraps the app once, at the root
- [ ] No routing library was added; no CSS file was added
- [ ] Every file left **unstaged**

## Notes for the next step

- **Step 2 (the split)** moves the `aside` at `OwnerPage.tsx:3219` into
  `ParticipantsPane` and leaves the owner a lean pair-picker. That is the step
  where `e2e/app.ts`'s `participantRow` and `.side-panel-section` helpers change,
  and where the suite is most likely to object — budget for it.
- **Step 3 (Settings)** renders `GET /debug/config` read-only with provenance,
  and lifts the protocol defaults out of `SetupWizard` so the wizard and the pane
  read one source.
- `OwnerPage.tsx` is 327KB and still holds every owner tab inline. Splitting it
  is worth doing on its own terms, with the e2e suite as the guard — but not as a
  side effect of this work.
