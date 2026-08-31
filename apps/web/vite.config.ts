/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
