// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// No SPA fallback middleware: every screen lives at the base path, and the
// client-side routes that exist are hash routes (`#/vault/<id>`, see
// `src/routing.ts`), which never reach the server.
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/reference-app/',
  build: {
    rolldownOptions: {
      output: {
        // The app shipped as one 1.2 MB script. Libraries change far less often
        // than the app, so each heavy one gets a chunk of its own: a rebuilt
        // app re-downloads only its own code, and no single chunk trips the
        // size warning. The SDK's JS glue stays with the app — it resolves its
        // `.wasm` relative to its own URL, which every chunk shares (`assets/`).
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            { name: 'mui', test: /node_modules[\\/](@mui|@emotion|@popperjs|react-transition-group)[\\/]/, priority: 20 },
            // Only used for plausible participant names, but it carries a
            // whole locale.
            { name: 'faker', test: /node_modules[\\/]@faker-js[\\/]/, priority: 20 },
          ],
        },
      },
    },
  },
  server: {
    watch: {
      // Playwright writes screenshots, videos and traces into the project root
      // *while* a run is in progress, and adding a spec file changes this tree
      // too. Watching either makes the dev server reload the page mid-test —
      // which surfaces as a blank page and a run where every test fails at the
      // first assertion, looking nothing like the file change that caused it.
      ignored: ['**/test-results/**', '**/playwright-report/**', '**/e2e/**'],
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
