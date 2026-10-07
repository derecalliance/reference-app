// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { init } from '@derec-alliance/web'
import './index.css'
import App from './App'

async function bootstrap() {
  await init()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

bootstrap()
