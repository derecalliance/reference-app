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
import type { Vault } from './types'
import type { VaultRunState } from './vault/manager'
import { Alert, Button, Stack } from '@mui/material'
import { VaultManagerProvider, useVaultEntries, useVaultManager } from './vault/managerContext'
import { VaultList } from './VaultList'
import { AppHeader } from './AppHeader'
import { navigate } from './routing'
import { useHashRoute } from './useHashRoute'
import { vaultScreen } from './vaultScreen'
import { reportError, reportInfo } from './toastBus'
import { countLocalDataEntries } from './localData'
import { resetBrowserData } from './browserReset'
import { vaultLockMode } from './vaultLock'
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
 * Said on the vault list wherever Web Locks is missing — see `vaultLockMode`.
 * Read once: whether the page is a secure context cannot change while it runs.
 */
const LOCK_WARNING =
  vaultLockMode() === 'web-locks'
    ? null
    : 'This page is not a secure context (plain HTTP on a network address), so the browser’s ' +
      'Web Locks are unavailable and one-tab-per-vault is only enforced on a best-effort basis. ' +
      'Keep each vault open in a single tab — two tabs running one vault split its messages. ' +
      'Serve the app over https, or open it at localhost, for full protection.'

/**
 * States the switcher opens straight away, as the list's Open does. The rest go
 * to the vault's own screen, which says what is wrong and offers Retry or Claim.
 */
const OPEN_ON_SWITCH: ReadonlySet<VaultRunState> = new Set(['running', 'stopped', 'blocked'])

function AppContent() {
  const manager = useVaultManager()
  // Subscribed so the page re-renders as vaults start, stop and rename.
  const entries = useVaultEntries()
  const route = useHashRoute()

  // Every vault this tab holds runs regardless; the route only picks which one
  // is on screen.
  const vaultId = route.kind === 'vault' ? route.id : null
  const entry = vaultId ? entries.find(e => e.id === vaultId) ?? null : null
  const runtime = vaultId ? manager.runtime(vaultId) : null
  const screen = vaultId ? vaultScreen(entry, runtime !== null, manager.isBooted()) : null

  /**
   * Take on a vault the wizard just set up, then show it.
   *
   * `false` when another tab already holds it — the wizard says so. The
   * manager's lock is the single point where the one-tab-per-vault rule is
   * decided, so every way in is covered by it.
   */
  async function createVault(next: Vault): Promise<boolean> {
    if (!manager.runtime(next.id) && !(await manager.create(next))) return false
    navigate({ kind: 'vault', id: next.id })
    return true
  }

  /** The name to report a vault's failure under. */
  function nameOf(id: string): string {
    return entries.find(e => e.id === id)?.name ?? 'the vault'
  }

  /**
   * Run a manager action started by a click. Nothing awaits these, so a
   * failure is reported here or nowhere — it used to be nowhere.
   */
  function runAction(action: Promise<unknown>, failure: string): void {
    action.catch(err => reportError(failure, err))
  }

  /** Start a stopped vault, or claim one another tab let go, then show it. */
  async function openVault(id: string): Promise<void> {
    if (await manager.open(id)) {
      navigate({ kind: 'vault', id })
    } else {
      reportInfo('That vault is still open in another tab — close it there first, then claim it.')
    }
  }

  function handleOpen(id: string): void {
    runAction(openVault(id), `Could not open “${nameOf(id)}”`)
  }

  function handleRetry(id: string): void {
    runAction(manager.retry(id), `Could not start “${nameOf(id)}”`)
  }

  /** Go straight to a vault picked in the header. */
  function switchToVault(id: string): void {
    const target = entries.find(e => e.id === id)
    if (target && OPEN_ON_SWITCH.has(target.state)) {
      handleOpen(id)
    } else {
      navigate({ kind: 'vault', id })
    }
  }

  // Everything the other vaults say arrives as a banner naming them; the one on
  // screen speaks through its own page.
  const onScreenId = screen?.kind === 'page' ? vaultId : null
  useEffect(() => {
    manager.setOnScreen(onScreenId)
  }, [manager, onScreenId])

  // Decisions only badge in the list, so while a vault is on screen the header
  // says how many *other* vaults are waiting on the owner.
  const othersWaiting =
    screen?.kind === 'page' ? entries.filter(e => e.id !== vaultId && e.attention > 0).length : 0

  // Name the tab, so two tabs are tellable apart in the tab bar.
  const shownName = screen?.kind === 'page' ? entry?.name ?? null : null
  useEffect(() => {
    document.title = shownName ? `${shownName} · DeRec` : APP_TITLE
  }, [shownName])

  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false)
  // A vault with no page to leave from — failed or stopped — awaiting confirmation.
  const [removeTargetId, setRemoveTargetId] = useState<string | null>(null)
  const removeTarget = removeTargetId ? entries.find(e => e.id === removeTargetId) ?? null : null
  // Entry count is snapshotted when the dialog opens so the confirmation text
  // reflects what is actually about to be deleted.
  const [resetEntryCount, setResetEntryCount] = useState<number | null>(null)

  function handleResetLocalData() {
    setResetEntryCount(null)
    void resetBrowserData(manager)
  }

  /** Stop running the on-screen vault here and free it for another tab. */
  function handleLeaveOnly() {
    setLeaveDialogOpen(false)
    if (vaultId) runAction(manager.release(vaultId), `Could not stop “${nameOf(vaultId)}” cleanly`)
    navigate({ kind: 'list' })
  }

  /** Stop it, erase its stores and forget it. */
  function handleRemoveFromBrowser() {
    setLeaveDialogOpen(false)
    if (vaultId) removeVault(vaultId)
    navigate({ kind: 'list' })
  }

  /** Remove a vault that is not running here, once confirmed. */
  function handleConfirmRemove() {
    const id = removeTargetId
    setRemoveTargetId(null)
    if (!id) return
    removeVault(id)
    if (vaultId === id) navigate({ kind: 'list' })
  }

  function removeVault(id: string): void {
    runAction(manager.remove(id), `Could not remove “${nameOf(id)}” from this browser`)
  }

  const list = (notice: string | null) => (
    <VaultList
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
            onReady={createVault}
            onCancel={() => navigate({ kind: 'list' })}
            existingVaultNames={entries.map(e => e.name)}
          />
        </div>
      )
    }
    switch (screen?.kind) {
      case 'page':
        return runtime && vaultId ? <OwnerPage key={vaultId} runtime={runtime} /> : null
      case 'missing':
        return (
          <div className="shell-centered">
            {list('That vault is not saved in this browser — it may have been removed.')}
          </div>
        )
      case 'elsewhere':
        return (
          <VaultUnavailable
            message={`“${entry?.name}” is open in another tab. Two tabs cannot run one vault — they would split its mailbox. Close it there, then claim it here.`}
            action="Claim"
            onAction={() => handleOpen(route.id)}
          />
        )
      case 'failed':
        return (
          <VaultUnavailable
            message={`“${entry?.name}” failed to start${screen.failure ? `: ${screen.failure}` : '.'}`}
            action="Retry"
            onAction={() => handleRetry(route.id)}
            onRemove={() => setRemoveTargetId(route.id)}
          />
        )
      case 'stopped':
        return (
          <VaultUnavailable
            message={`“${entry?.name}” is not running in this tab.`}
            action="Open"
            onAction={() => handleOpen(route.id)}
            onRemove={() => setRemoveTargetId(route.id)}
          />
        )
      default:
        // Loading: the vault is being read or started.
        return null
    }
  }

  return (
    <>
      <AppHeader
        entries={entries}
        vaultId={vaultId}
        vaultPageShown={screen?.kind === 'page'}
        othersWaiting={othersWaiting}
        onShowAll={() => navigate({ kind: 'list' })}
        onSwitch={switchToVault}
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
                This erases every DeRec vault, pairing, protocol key and saved Settings
                default in this browser ({resetEntryCount}{' '}
                {resetEntryCount === 1 ? 'entry' : 'entries'}), then reloads the app so you
                start from scratch.
              </p>
              <p className="app-dialog-note">
                Other tabs of this app stop their vaults and reload too — this
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

      <ConsolePanel vaults={entries} />

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

interface VaultUnavailableProps {
  message: string
  action: string
  onAction: () => void
  /** Offered where nothing else can remove the vault: failed or stopped. */
  onRemove?: () => void
}

/** A vault route this tab cannot show yet: why, and the one thing to do about it. */
function VaultUnavailable({ message, action, onAction, onRemove }: VaultUnavailableProps) {
  return (
    <div className="shell-centered">
      <Stack spacing={2} sx={{ maxWidth: 560 }}>
        <Alert severity="info">{message}</Alert>
        <Stack direction="row" spacing={1.5}>
          <Button variant="contained" onClick={onAction}>
            {action}
          </Button>
          <Button onClick={() => navigate({ kind: 'list' })}>All vaults</Button>
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
          <VaultManagerProvider>
            <AppContent />
          </VaultManagerProvider>
        </ConsoleProvider>
      </ToastProvider>
    </AppMuiTheme>
  )
}
