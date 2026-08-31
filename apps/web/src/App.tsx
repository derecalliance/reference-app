import { useState, useEffect, useRef, useId, type ReactNode } from 'react'
import './App.css'
import SetupWizard from './SetupWizard'
import OwnerPage from './OwnerPage'
import ConsolePanel from './ConsolePanel'
import { ConsoleProvider } from './ConsoleContext'
import { ToastProvider } from './Toast'
import type { Owner } from './types'
import {
  persistOwner,
  deleteOwner,
  loadActiveOwner,
  clearActiveOwner,
} from './ownerPersistence'
import { acquireOwnerLock, type OwnerLock } from './ownerLock'
import { clearAllLocalData, countLocalDataEntries } from './localData'
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

const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, '') // e.g. "/reference-app"

interface AppDialogProps {
  title: string
  body: ReactNode
  /** Action buttons, rendered right-aligned in the dialog footer. */
  children: ReactNode
}

function AppDialog({ title, body, children }: AppDialogProps) {
  const titleId = useId()
  return (
    <div className="app-dialog-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="app-dialog">
        <h2 id={titleId} className="app-dialog-title">{title}</h2>
        <div className="app-dialog-body">{body}</div>
        <div className="app-dialog-actions">{children}</div>
      </div>
    </div>
  )
}

const APP_TITLE = 'DeRec Reference App'

function AppContent() {
  const [owner, setOwner] = useState<Owner | null>(null)
  // Held for as long as this tab drives `owner`, so no second tab can pick the
  // same one. Released on leave; the browser releases it on close or crash.
  const lockRef = useRef<OwnerLock | null>(null)
  // The owner this tab was driving before a reload, read once at mount.
  const [pendingResume] = useState<Owner | null>(loadActiveOwner)
  // Blocks the first render only while a resume is actually in flight, so a
  // reload does not flash the picker on its way back to the owner it had — and
  // a fresh tab, which has nothing to resume, renders the picker immediately.
  const [resuming, setResuming] = useState(pendingResume !== null)

  /**
   * Take ownership of `next` in this tab.
   *
   * Returns `false` when another tab already holds it — the caller surfaces
   * that; this is the single point where the one-tab-per-owner rule is decided,
   * so every path in (picker, fresh setup, claim, resume) is covered by it.
   */
  async function adoptOwner(next: Owner): Promise<boolean> {
    if (lockRef.current?.ownerId === next.ownerId) {
      persistOwner(next)
      setOwner(next)
      return true
    }

    const lock = await acquireOwnerLock(next.ownerId)
    if (!lock) return false

    await lockRef.current?.release()
    lockRef.current = lock
    persistOwner(next)
    setOwner(next)
    return true
  }

  // Resume whatever this tab was driving before a reload. A *new* tab has no
  // pointer and falls through to the picker, which is the whole point of
  // keeping it in sessionStorage.
  useEffect(() => {
    if (!pendingResume) return
    let cancelled = false

    void acquireOwnerLock(pendingResume.ownerId).then(lock => {
      if (cancelled) {
        void lock?.release()
        return
      }
      if (lock) {
        lockRef.current = lock
        setOwner(pendingResume)
      } else {
        // A duplicated tab copies sessionStorage, so this pointer can name an
        // owner the original still holds. Drop it and let the picker explain.
        clearActiveOwner()
      }
      setResuming(false)
    })

    return () => {
      cancelled = true
    }
  }, [pendingResume])

  // Release on unload as well as on unmount: the browser frees Web Locks when
  // the tab dies, but an explicit release makes the owner selectable again in
  // an already-open picker without waiting on that.
  useEffect(() => {
    const release = () => void lockRef.current?.release()
    window.addEventListener('pagehide', release)
    return () => {
      window.removeEventListener('pagehide', release)
      release()
    }
  }, [])

  // Name the tab, so two tabs are tellable apart in the tab bar.
  useEffect(() => {
    document.title = owner ? `${owner.ownerName} · DeRec` : APP_TITLE
  }, [owner])

  function handleOwnerUpdate(updated: Owner) {
    persistOwner(updated)
    setOwner(updated)
  }

  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false)
  // Entry count is snapshotted when the dialog opens so the confirmation text
  // reflects what is actually about to be deleted.
  const [resetEntryCount, setResetEntryCount] = useState<number | null>(null)

  function handleResetLocalData() {
    clearAllLocalData()
    // Protocol instances and wizard state live outside localStorage, so a
    // reload is what actually guarantees a clean slate.
    window.location.replace(`${BASE_PATH}/`)
  }

  /**
   * Give up this tab's owner, freeing it for another tab to pick up.
   *
   * Awaits the release so the picker this returns to already sees the owner as
   * free — otherwise the row the user just left would render as busy.
   */
  async function releaseOwner() {
    const lock = lockRef.current
    lockRef.current = null
    clearActiveOwner()
    await lock?.release()
    setOwner(null)
  }

  function handleLeaveOnly() {
    setLeaveDialogOpen(false)
    void releaseOwner()
  }

  function handleRemoveFromBrowser() {
    setLeaveDialogOpen(false)
    if (owner) {
      try {
        deleteOwner(owner.ownerId)
      } catch {
        // Storage errors are non-fatal — proceed with leaving.
      }
    }
    void releaseOwner()
  }

  return (
    <>
      <header>
        <img src={`${BASE_PATH}/logo-color.svg`} alt="DeRec Alliance" height="32" />
        <div className="header-spacer" />
        {owner && (
          <button
            className="secondary leave-btn"
            onClick={() => setLeaveDialogOpen(true)}
            title="Return to the start screen"
          >
            Leave
          </button>
        )}
        <button
          className="secondary reset-btn"
          onClick={() => setResetEntryCount(countLocalDataEntries())}
          title="Erase all DeRec data stored in this browser and start fresh"
        >
          Reset browser data
        </button>
      </header>

      <main className={owner ? 'owner-mode' : undefined}>
        {resuming
          ? null
          : owner === null
            ? <SetupWizard onReady={adoptOwner} />
            : <OwnerPage owner={owner} onUpdate={handleOwnerUpdate} />
        }
      </main>

      {leaveDialogOpen && (
        <AppDialog
          title="Leave?"
          body="Do you want to leave, or also remove this owner from the browser?"
        >
          <button className="secondary" onClick={() => setLeaveDialogOpen(false)}>
            Cancel
          </button>
          <button className="secondary" onClick={handleLeaveOnly}>
            Leave
          </button>
          <button onClick={handleRemoveFromBrowser}>
            Remove from browser
          </button>
        </AppDialog>
      )}

      {resetEntryCount !== null && (
        <AppDialog
          title="Reset browser data?"
          body={
            <>
              <p>
                This erases every DeRec owner, pairing and protocol key stored in this
                browser ({resetEntryCount} {resetEntryCount === 1 ? 'entry' : 'entries'}),
                then reloads the app so you start from scratch.
              </p>
              <p className="app-dialog-note">
                Other tabs are erased too — this clears storage the whole
                browser shares. Actors on the server are not affected. This
                cannot be undone.
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

      <ConsolePanel />

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

export default function App() {
  return (
    <ToastProvider>
      <ConsoleProvider>
        <AppContent />
      </ConsoleProvider>
    </ToastProvider>
  )
}
