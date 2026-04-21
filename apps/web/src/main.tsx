import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { init } from '@derec-alliance/web'
import './index.css'
import App from './App.tsx'

async function bootstrap() {
  await init()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

bootstrap()
