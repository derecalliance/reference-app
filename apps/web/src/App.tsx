import { useState, useEffect } from 'react'
import './App.css'
import NewSessionWizard from './NewSessionWizard'
import OwnerSessionPage, { JoinQrModal, SessionIdBadge } from './OwnerSessionPage'
import ConsolePanel from './ConsolePanel'
import { ConsoleProvider } from './ConsoleContext'
import type { OwnerSession, ParticipantSession } from './types'
import { persistSession, persistParticipantSession } from './sessionPersistence'
import ParticipantSessionPage from './ParticipantSessionPage'
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
  | { type: 'participant'; session: ParticipantSession }

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

  function handleJoined(session: ParticipantSession) {
    persistParticipantSession(session)
    setActiveSession({ type: 'participant', session })
  }

  function handleParticipantUpdate(updated: ParticipantSession) {
    persistParticipantSession(updated)
    setActiveSession({ type: 'participant', session: updated })
  }

  const [inviteOpen, setInviteOpen] = useState(false)

  function handleLeave() {
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
          <button className="secondary leave-btn" onClick={handleLeave} title="Return to session list">
            Leave
          </button>
        )}
      </header>

      {inviteOpen && activeSession?.type === 'owner' && (
        <JoinQrModal sessionId={activeSession.session.sessionId} onClose={() => setInviteOpen(false)} />
      )}

      <main className={activeSession ? 'session-mode' : undefined}>
        {activeSession === null
          ? <NewSessionWizard onCreated={handleCreated} initialSessionId={urlSessionInfo?.sessionId} initialIntent={urlSessionInfo?.intent} />
          : activeSession.type === 'owner'
            ? <OwnerSessionPage session={activeSession.session} onUpdate={handleOwnerUpdate} />
            : <ParticipantSessionPage session={activeSession.session} onUpdate={handleParticipantUpdate} />
        }
      </main>

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
    <ConsoleProvider>
      <AppContent />
    </ConsoleProvider>
  )
}
