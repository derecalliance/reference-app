// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { init } from '@derec-alliance/web'
import './index.css'
import App from './App'
import { migrateLegacyStorageKeys } from './secretStorage'

async function bootstrap() {
  // Before anything reads storage: data an older build saved under
  // `derec:vault:` moves to `derec:secret:` — see `secretStorage.ts`.
  migrateLegacyStorageKeys()
  await init()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

bootstrap()
