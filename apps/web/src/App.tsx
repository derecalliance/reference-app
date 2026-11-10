// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useState, useEffect, useId, type ReactNode } from 'react'
import './App.css'
import SetupWizard from './SetupWizard'
import { AppShell } from './AppShell'
import { AppMuiTheme } from './AppMuiTheme'
import OwnerPage from './OwnerPage'
import ConsolePanel from './ConsolePanel'
import { ConsoleProvider } from './ConsoleContext'
import { ToastProvider } from './Toast'
import { ModalFrame } from './ModalFrame'
import type { Secret } from './types'
import type { SecretRunState } from './secret/manager'
import { Alert, Button, Stack } from '@mui/material'
import { SecretManagerProvider, useSecretEntries, useSecretManager } from './secret/managerContext'
import { SecretList } from './SecretList'
import { AppHeader } from './AppHeader'
import { navigate } from './routing'
import { useHashRoute } from './useHashRoute'
import { secretScreen } from './secretScreen'
import { reportError, reportInfo } from './toastBus'
import { countLocalDataEntries } from './localData'
import { resetBrowserData } from './browserReset'
import { secretLockMode } from './secretLock'
import GitHubIcon from '@mui/icons-material/GitHub';
import LinkedInIcon from '@mui/icons-material/LinkedIn';
import XIcon from '@mui/icons-material/X';
import YouTubeIcon from '@mui/icons-material/YouTube';
import DescriptionIcon from '@mui/icons-material/Description';


const socialLinks = [
  {
    label: 'GitHub',
    href: 'https://github.com/derecalliance',
    icon: GitHubIcon,
  },
  {
    label: 'LinkedIn',
    href: 'https://linkedin.com/company/derec-alliance',
    icon: LinkedInIcon,
  },
  {
    label: 'X (Twitter)',
    href: 'https://x.com/DeRecAlliance',
    icon: XIcon,
  },
  {
    label: 'YouTube',
    href: 'https://youtube.com/@DeRec-Alliance',
    icon: YouTubeIcon,
  },
  {
    label: 'Docs',
    href: 'https://derec-alliance.gitbook.io/docs',
    icon: DescriptionIcon,
  },
]

interface AppDialogProps {
  title: string
  body: ReactNode
  /** What Escape does — the same as the dialog's Cancel button. */
  onCancel: () => void
  /** Action buttons, rendered right-aligned in the dialog footer. */
  children: ReactNode
}

function AppDialog({ title, body, onCancel, children }: AppDialogProps) {
  const titleId = useId()
  return (
    <ModalFrame
      overlayClassName="app-dialog-overlay"
      className="app-dialog"
      labelledBy={titleId}
      onEscape={onCancel}
    >
      <h2 id={titleId} className="app-dialog-title">{title}</h2>
      <div className="app-dialog-body">{body}</div>
      <div className="app-dialog-actions">{children}</div>
    </ModalFrame>
  )
}

const APP_TITLE = 'DeRec Reference App'

/**
 * Said on the secret list wherever Web Locks is missing — see `secretLockMode`.
 * Read once: whether the page is a secure context cannot change while it runs.
 */
const LOCK_WARNING =
  secretLockMode() === 'web-locks'
    ? null
    : 'This page is not a secure context (plain HTTP on a network address), so the browser’s ' +
      'Web Locks are unavailable and one-tab-per-secret is only enforced on a best-effort basis. ' +
      'Keep each secret open in a single tab — two tabs running one secret split its messages. ' +
      'Serve the app over https, or open it at localhost, for full protection.'

/**
 * States the switcher opens straight away, as the list's Open does. The rest go
 * to the secret's own screen, which says what is wrong and offers Retry or Claim.
 */
const OPEN_ON_SWITCH: ReadonlySet<SecretRunState> = new Set(['running', 'stopped', 'blocked'])

function AppContent() {
  const manager = useSecretManager()
  // Subscribed so the page re-renders as secrets start, stop and rename.
  const entries = useSecretEntries()
  const route = useHashRoute()

  // Every secret this tab holds runs regardless; the route only picks which one
  // is on screen.
  const localSecretId = route.kind === 'secret' ? route.id : null
  const entry = localSecretId ? entries.find(e => e.id === localSecretId) ?? null : null
  const runtime = localSecretId ? manager.runtime(localSecretId) : null
  const screen = localSecretId ? secretScreen(entry, runtime !== null, manager.isBooted()) : null

  /**
   * Take on a secret the wizard just set up, then show it.
   *
   * `false` when another tab already holds it — the wizard says so. The
   * manager's lock is the single point where the one-tab-per-secret rule is
   * decided, so every way in is covered by it.
   */
  async function createSecret(next: Secret): Promise<boolean> {
    if (!manager.runtime(next.id) && !(await manager.create(next))) return false
    navigate({ kind: 'secret', id: next.id })
    return true
  }

  /** The name to report a secret's failure under. */
  function nameOf(id: string): string {
    return entries.find(e => e.id === id)?.name ?? 'the secret'
  }

  /**
   * Run a manager action started by a click. Nothing awaits these, so a
   * failure is reported here or nowhere — it used to be nowhere.
   */
  function runAction(action: Promise<unknown>, failure: string): void {
    action.catch(err => reportError(failure, err))
  }

  /** Start a stopped secret, or claim one another tab let go, then show it. */
  async function openSecret(id: string): Promise<void> {
    if (await manager.open(id)) {
      navigate({ kind: 'secret', id })
    } else {
      reportInfo('That secret is still open in another tab — close it there first, then claim it.')
    }
  }

  function handleOpen(id: string): void {
    runAction(openSecret(id), `Could not open “${nameOf(id)}”`)
  }

  function handleRetry(id: string): void {
    runAction(manager.retry(id), `Could not start “${nameOf(id)}”`)
  }

  /** Go straight to a secret picked in the header. */
  /**
   * The bell: open the secret's Notifications tab and mark the picked one read.
   * A secret another tab runs cannot be marked from here; its tab still opens
   * once this tab takes it over.
   */
  function openNotifications(id: string, notificationId: string | null): void {
    if (notificationId) manager.runtime(id)?.markNotificationsRead([notificationId])
    navigate({ kind: 'secret', id, tab: 'notifications' })
  }

  function switchToSecret(id: string): void {
    const target = entries.find(e => e.id === id)
    if (target && OPEN_ON_SWITCH.has(target.state)) {
      handleOpen(id)
    } else {
      navigate({ kind: 'secret', id })
    }
  }

  // Everything the other secrets say arrives as a banner naming them; the one on
  // screen speaks through its own page.
  const onScreenId = screen?.kind === 'page' ? localSecretId : null
  useEffect(() => {
    manager.setOnScreen(onScreenId)
  }, [manager, onScreenId])

  // Decisions only badge in the list, so while a secret is on screen the header
  // says how many *other* secrets are waiting on the owner.
  const othersWaiting =
    screen?.kind === 'page' ? entries.filter(e => e.id !== localSecretId && e.attention > 0).length : 0

  // Name the tab, so two tabs are tellable apart in the tab bar.
  const shownName = screen?.kind === 'page' ? entry?.name ?? null : null
  useEffect(() => {
    document.title = shownName ? `${shownName} · DeRec` : APP_TITLE
  }, [shownName])

  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false)
  // A secret with no page to leave from — failed or stopped — awaiting confirmation.
  const [removeTargetId, setRemoveTargetId] = useState<string | null>(null)
  const removeTarget = removeTargetId ? entries.find(e => e.id === removeTargetId) ?? null : null
  // Entry count is snapshotted when the dialog opens so the confirmation text
  // reflects what is actually about to be deleted.
  const [resetEntryCount, setResetEntryCount] = useState<number | null>(null)

  function handleResetLocalData() {
    setResetEntryCount(null)
    void resetBrowserData(manager)
  }

  /** Stop running the on-screen secret here and free it for another tab. */
  function handleLeaveOnly() {
    setLeaveDialogOpen(false)
    if (localSecretId) runAction(manager.release(localSecretId), `Could not stop “${nameOf(localSecretId)}” cleanly`)
    navigate({ kind: 'list' })
  }

  /** Stop it, erase its stores and forget it. */
  function handleRemoveFromBrowser() {
    setLeaveDialogOpen(false)
    if (localSecretId) removeSecret(localSecretId)
    navigate({ kind: 'list' })
  }

  /** Remove a secret that is not running here, once confirmed. */
  function handleConfirmRemove() {
    const id = removeTargetId
    setRemoveTargetId(null)
    if (!id) return
    removeSecret(id)
    if (localSecretId === id) navigate({ kind: 'list' })
  }

  function removeSecret(id: string): void {
    runAction(manager.remove(id), `Could not remove “${nameOf(id)}” from this browser`)
  }

  const list = (notice: string | null) => (
    <SecretList
      entries={entries}
      notice={notice}
      warning={LOCK_WARNING}
      onNew={flow => navigate({ kind: 'new', flow })}
      onOpen={handleOpen}
      onClaim={handleOpen}
      onRetry={handleRetry}
      onRemove={setRemoveTargetId}
    />
  )

  function body(): ReactNode {
    if (route.kind === 'list') return <div className="shell-centered">{list(null)}</div>
    if (route.kind === 'new') {
      return (
        // The wizard was centered by `main` before the shell existed; the
        // shell fills `main` now, so the centering moves in here.
        <div className="shell-centered">
          <SetupWizard
            key={route.flow}
            initialFlow={route.flow}
            onReady={createSecret}
            onCancel={() => navigate({ kind: 'list' })}
            existingSecretNames={entries.map(e => e.name)}
          />
        </div>
      )
    }
    switch (screen?.kind) {
      case 'page':
        return runtime && localSecretId ? (
          <OwnerPage key={localSecretId} runtime={runtime} requestedTab={route.kind === 'secret' ? route.tab : undefined} />
        ) : null
      case 'missing':
        return (
          <div className="shell-centered">
            {list('That secret is not saved in this browser — it may have been removed.')}
          </div>
        )
      case 'elsewhere':
        return (
          <SecretUnavailable
            message={`“${entry?.name}” is open in another tab. Two tabs cannot run one secret — they would split its mailbox. Close it there, then claim it here.`}
            action="Claim"
            onAction={() => handleOpen(route.id)}
          />
        )
      case 'failed':
        return (
          <SecretUnavailable
            message={`“${entry?.name}” failed to start${screen.failure ? `: ${screen.failure}` : '.'}`}
            action="Retry"
            onAction={() => handleRetry(route.id)}
            onRemove={() => setRemoveTargetId(route.id)}
          />
        )
      case 'stopped':
        return (
          <SecretUnavailable
            message={`“${entry?.name}” is not running in this tab.`}
            action="Open"
            onAction={() => handleOpen(route.id)}
            onRemove={() => setRemoveTargetId(route.id)}
          />
        )
      default:
        // Loading: the secret is being read or started.
        return null
    }
  }

  return (
    <>
      <AppHeader
        entries={entries}
        localSecretId={localSecretId}
        secretPageShown={screen?.kind === 'page'}
        othersWaiting={othersWaiting}
        onShowAll={() => navigate({ kind: 'list' })}
        onSwitch={switchToSecret}
        onOpenNotifications={openNotifications}
        onLeave={() => setLeaveDialogOpen(true)}
        onReset={() => setResetEntryCount(countLocalDataEntries())}
      />

      <main className="shell-host">
        <AppShell>{body()}</AppShell>
      </main>

      {leaveDialogOpen && (
        <AppDialog
          title="Leave?"
          onCancel={() => setLeaveDialogOpen(false)}
          body={
            <>
              <p>
                Stop running “{entry?.name}” in this tab — it stays saved and another tab
                can open it — or also remove it from this browser.
              </p>
              <p className="app-dialog-note">
                Removing erases its keys, channels and shares on this device. Its actor on
                the server is not affected. This cannot be undone.
              </p>
            </>
          }
        >
          <button className="secondary" onClick={() => setLeaveDialogOpen(false)}>
            Cancel
          </button>
          <button className="secondary" onClick={handleLeaveOnly}>
            Stop running here
          </button>
          <button onClick={handleRemoveFromBrowser}>
            Remove from browser
          </button>
        </AppDialog>
      )}

      {removeTarget && (
        <AppDialog
          title="Remove from browser?"
          onCancel={() => setRemoveTargetId(null)}
          body={
            <p className="app-dialog-note">
              This erases “{removeTarget.name}” — its keys, channels and shares — from this
              device. Its actor on the server is not affected. This cannot be undone.
            </p>
          }
        >
          <button className="secondary" onClick={() => setRemoveTargetId(null)}>
            Cancel
          </button>
          <button className="danger" onClick={handleConfirmRemove}>
            Remove from browser
          </button>
        </AppDialog>
      )}

      {resetEntryCount !== null && (
        <AppDialog
          title="Reset browser data?"
          onCancel={() => setResetEntryCount(null)}
          body={
            <>
              <p>
                This erases every DeRec secret, pairing, protocol key and saved Settings
                default in this browser ({resetEntryCount}{' '}
                {resetEntryCount === 1 ? 'entry' : 'entries'}), then reloads the app so you
                start from scratch.
              </p>
              <p className="app-dialog-note">
                Other tabs of this app stop their secrets and reload too — this
                clears storage the whole browser shares. Actors on the server are
                not affected. This cannot be undone.
              </p>
            </>
          }
        >
          <button className="secondary" onClick={() => setResetEntryCount(null)}>
            Cancel
          </button>
          <button className="danger" onClick={handleResetLocalData}>
            Erase and reload
          </button>
        </AppDialog>
      )}

      <ConsolePanel secrets={entries} />

      <footer>
        {socialLinks.map(({ label, href, icon: Icon }) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={label}
          >
            <Icon />
          </a>
        ))}
      </footer>
    </>
  )
}

interface SecretUnavailableProps {
  message: string
  action: string
  onAction: () => void
  /** Offered where nothing else can remove the secret: failed or stopped. */
  onRemove?: () => void
}

/** A secret route this tab cannot show yet: why, and the one thing to do about it. */
function SecretUnavailable({ message, action, onAction, onRemove }: SecretUnavailableProps) {
  return (
    <div className="shell-centered">
      <Stack spacing={2} sx={{ maxWidth: 560 }}>
        <Alert severity="info">{message}</Alert>
        <Stack direction="row" spacing={1.5}>
          <Button variant="contained" onClick={onAction}>
            {action}
          </Button>
          <Button onClick={() => navigate({ kind: 'list' })}>All secrets</Button>
          {onRemove && (
            <Button color="error" onClick={onRemove}>
              Remove
            </Button>
          )}
        </Stack>
      </Stack>
    </div>
  )
}

export default function App() {
  return (
    // Lifted to the root for the shell's own MUI components. `OwnerPage` still
    // wraps three dialogs in the same provider; nesting an identical theme is a
    // no-op, and unpicking them is cleanup for its own change rather than a
    // side effect of adding navigation.
    <AppMuiTheme>
      <ToastProvider>
        <ConsoleProvider>
          <SecretManagerProvider>
            <AppContent />
          </SecretManagerProvider>
        </ConsoleProvider>
      </ToastProvider>
    </AppMuiTheme>
  )
}
