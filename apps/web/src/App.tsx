import { useState, useEffect, useId, type ReactNode } from 'react'
import './App.css'
import NewSessionWizard from './NewSessionWizard'
import OwnerSessionPage, { JoinQrModal, SessionIdBadge } from './OwnerSessionPage'
import ConsolePanel from './ConsolePanel'
import { ConsoleProvider } from './ConsoleContext'
import { ToastProvider } from './Toast'
import type { OwnerSession } from './types'
import { persistSession, deleteSession } from './sessionPersistence'
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

interface UrlSessionInfo {
  sessionId: string
  intent: 'continue' | 'join'
}

function getSessionInfoFromUrl(): UrlSessionInfo | null {
  const path = window.location.pathname
  const prefix = `${BASE_PATH}/session/`

  // Try direct path first: /reference-app/session/{id} or /reference-app/session/{id}/join
  if (path.startsWith(prefix)) {
    const rest = path.slice(prefix.length).replace(/\/$/, '')
    if (rest.endsWith('/join')) {
      const id = rest.slice(0, -'/join'.length)
      return id ? { sessionId: id, intent: 'join' } : null
    }
    return rest ? { sessionId: rest, intent: 'continue' } : null
  }

  // GitHub Pages SPA fallback: 404.html redirects to /?p=/session/{id}[/join]
  const redirectedPath = new URLSearchParams(window.location.search).get('p')
  if (redirectedPath?.startsWith('/session/')) {
    const rest = redirectedPath.slice('/session/'.length).replace(/\/$/, '')
    if (rest.endsWith('/join')) {
      const id = rest.slice(0, -'/join'.length)
      return id ? { sessionId: id, intent: 'join' } : null
    }
    return rest ? { sessionId: rest, intent: 'continue' } : null
  }

  return null
}

function setSessionIdInUrl(sessionId: string | null) {
  const target = sessionId ? `${BASE_PATH}/session/${sessionId}` : `${BASE_PATH}/`
  if (window.location.pathname !== target) {
    window.history.replaceState(null, '', target)
  }
}

type ActiveSession =
  | { type: 'owner'; session: OwnerSession }

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

function AppContent() {
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null)

  // Read session info from URL on mount — passed to the wizard for auto-resume or join flow.
  const [urlSessionInfo] = useState(getSessionInfoFromUrl)

  const sessionId = activeSession?.session.sessionId ?? null

  // Keep the URL in sync with the active session (always use /session/{id}, not /join).
  useEffect(() => {
    setSessionIdInUrl(sessionId)
  }, [sessionId])

  function handleOwnerUpdate(updated: OwnerSession) {
    persistSession(updated)
    setActiveSession({ type: 'owner', session: updated })
  }

  function handleCreated(created: OwnerSession) {
    persistSession(created)
    setActiveSession({ type: 'owner', session: created })
  }

  const [inviteOpen, setInviteOpen] = useState(false)
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false)
  // Entry count is snapshotted when the dialog opens so the confirmation text
  // reflects what is actually about to be deleted.
  const [resetEntryCount, setResetEntryCount] = useState<number | null>(null)

  function handleResetLocalData() {
    clearAllLocalData()
    // Protocol instances, wizard state and the session id in the URL all live
    // outside localStorage, so a reload from the base path is what actually
    // guarantees a clean slate.
    window.location.replace(`${BASE_PATH}/`)
  }

  function handleLeaveOnly() {
    setLeaveDialogOpen(false)
    setActiveSession(null)
  }

  function handleRemoveFromBrowser() {
    setLeaveDialogOpen(false)
    if (activeSession) {
      try {
        deleteSession(activeSession.session.sessionId)
      } catch {
        // Storage errors are non-fatal — proceed with leaving.
      }
    }
    setActiveSession(null)
  }

  return (
    <>
      <header>
        <img src={`${BASE_PATH}/logo-color.svg`} alt="DeRec Alliance" height="32" />
        <div className="header-spacer" />
        {activeSession?.type === 'owner' && (
          <SessionIdBadge id={activeSession.session.sessionId} />
        )}
        {activeSession?.type === 'owner' && (
          <button className="secondary" onClick={() => setInviteOpen(true)} title="Show QR code so others can join this session">
            Invite
          </button>
        )}
        {activeSession && (
          <button className="secondary leave-btn" onClick={() => setLeaveDialogOpen(true)} title="Return to session list">
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

      {inviteOpen && activeSession?.type === 'owner' && (
        <JoinQrModal sessionId={activeSession.session.sessionId} onClose={() => setInviteOpen(false)} />
      )}

      <main className={activeSession ? 'session-mode' : undefined}>
        {activeSession === null
          ? <NewSessionWizard onCreated={handleCreated} initialSessionId={urlSessionInfo?.sessionId} initialIntent={urlSessionInfo?.intent} />
          : <OwnerSessionPage session={activeSession.session} onUpdate={handleOwnerUpdate} />
        }
      </main>

      {leaveDialogOpen && (
        <AppDialog
          title="Leave session?"
          body="Do you want to leave this session or also remove it from this browser?"
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
                This erases every DeRec session, pairing and protocol key stored in this
                browser ({resetEntryCount} {resetEntryCount === 1 ? 'entry' : 'entries'}),
                then reloads the app so you start from scratch.
              </p>
              <p className="app-dialog-note">
                Sessions on the server are not affected. This cannot be undone.
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
