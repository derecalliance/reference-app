import { useState, useEffect } from 'react'
import './App.css'
import NewSessionWizard from './NewSessionWizard'
import OwnerSessionPage from './OwnerSessionPage'
import ConsolePanel from './ConsolePanel'
import { ConsoleProvider } from './ConsoleContext'
import type { OwnerSession } from './types'
import { persistSession } from './sessionPersistence'
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

function getSessionIdFromUrl(): string | null {
  // Direct path: /reference-app/session/{id}
  const path = window.location.pathname
  const prefix = `${BASE_PATH}/session/`
  if (path.startsWith(prefix)) {
    const id = path.slice(prefix.length).replace(/\/$/, '')
    return id || null
  }

  // GitHub Pages SPA fallback: 404.html redirects to /?p=/session/{id}
  const redirectedPath = new URLSearchParams(window.location.search).get('p')
  if (redirectedPath?.startsWith('/session/')) {
    const id = redirectedPath.slice('/session/'.length).replace(/\/$/, '')
    return id || null
  }

  return null
}

function setSessionIdInUrl(sessionId: string | null) {
  const target = sessionId ? `${BASE_PATH}/session/${sessionId}` : `${BASE_PATH}/`
  if (window.location.pathname !== target) {
    window.history.replaceState(null, '', target)
  }
}

function AppContent() {
  const [session, setSession] = useState<OwnerSession | null>(null)

  // Read session ID from URL on mount — passed to the wizard for auto-resume flow.
  const [urlSessionId] = useState(getSessionIdFromUrl)

  // Keep the URL in sync with the active session.
  useEffect(() => {
    setSessionIdInUrl(session?.sessionId ?? null)
  }, [session?.sessionId])

  function handleUpdate(updated: OwnerSession) {
    persistSession(updated)
    setSession(updated)
  }

  function handleCreated(created: OwnerSession) {
    persistSession(created)
    setSession(created)
  }

  function handleLeave() {
    // Keep stored data so "Continue Session" can restore it.
    setSession(null)
  }

  return (
    <>
      <header>
        <img src="/logo-color.svg" alt="DeRec" height="32" />
      </header>

      <main className={session ? 'session-mode' : undefined}>
        {session
          ? <OwnerSessionPage session={session} onUpdate={handleUpdate} onLeave={handleLeave} />
          : <NewSessionWizard onCreated={handleCreated} initialSessionId={urlSessionId} />
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
