/// <reference types="vitest/config" />
import { existsSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const projectRoot = dirname(fileURLToPath(import.meta.url))

/**
 * Directories Vite may serve from beyond the project root.
 *
 * `@derec-alliance/web` is a `file:` dependency on a sibling `lib-derec`
 * checkout until SDK 0.0.3 is published, and npm installs that as a symlink.
 * Vite resolves the symlink before serving, so the `.wasm` lands outside the
 * project root, the default `server.fs.allow` answers 403, and the app fails
 * to boot with "failed to fetch Wasm".
 *
 * Read off the installed package rather than hardcoded, so it holds wherever
 * the checkout lives and becomes a no-op the moment the dependency goes back
 * to a registry version.
 */
function linkedSdkDirs(): string[] {
  const installed = resolve(projectRoot, 'node_modules/@derec-alliance/web')
  if (!existsSync(installed)) return []
  const real = realpathSync(installed)
  return real === installed ? [] : [real]
}

// No SPA fallback middleware: the app has no client-side routes — every screen
// lives at the base path.
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/reference-app/',
  optimizeDeps: {
    exclude: ['@derec-alliance/web'],
  },
  resolve: {
    // `@derec-alliance/web` has no `exports` map — only `main` (raw
    // wasm-bindgen output) and `module` (the hand-written re-export surface
    // that includes SenderKind, ContactMode, etc). Vitest's SSR module
    // resolution prefers `main` by default, which silently drops those named
    // exports. This `resolve` block is app-wide (drives dev server and
    // production build too, not just tests), so keep Vite's default
    // `mainFields` ordering and only add `module` ahead of `main`.
    mainFields: ['browser', 'module', 'main'],
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
    fs: {
      allow: [projectRoot, ...linkedSdkDirs()],
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
