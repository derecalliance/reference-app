// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { init } from '@derec-alliance/web'
import './index.css'
import App from './App'
import { installWasmBorrowGuard } from './wasmBorrowGuard'

async function bootstrap() {
  await init()
  // Before anything can call into the SDK: an overlapping call on one instance
  // hangs silently otherwise — see the guard for why.
  installWasmBorrowGuard()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

bootstrap()
