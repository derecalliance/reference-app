import { useState } from 'react'
import './App.css'
import NewSessionWizard from './NewSessionWizard'
import OwnerSessionPage from './OwnerSessionPage'
import type { OwnerSession } from './types'
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

function App() {
  const [session, setSession] = useState<OwnerSession | null>(null)

  return (
    <>
      <header>
        <img src="/logo-color.svg" alt="DeRec" height="32" />
      </header>

      <main className={session ? 'session-mode' : undefined}>
        {session
          ? <OwnerSessionPage session={session} onUpdate={setSession} />
          : <NewSessionWizard onCreated={setSession} />
        }
      </main>

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

export default App
