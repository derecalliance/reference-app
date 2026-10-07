// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { defineConfig } from '@playwright/test'

/**
 * End-to-end harness for the reference app.
 *
 * Both halves of the stack are started here: the Rust backend (actor registry
 * and message relay) and the Vite dev server. A test that only exercises UI
 * still needs the backend, because the setup wizard provisions actors against
 * it before it will hand back an owner.
 */

/**
 * Ports of the suite's own, deliberately not the app's defaults.
 *
 * `reuseExistingServer` is on locally, so a backend already listening on the
 * default 5000 is adopted instead of started — which meant a run silently
 * executed against a developer's live node and wrote fifty fixture helpers
 * into its persistent database, while the in-memory setting below was ignored.
 * Its own port is what makes the harness hermetic.
 *
 * The web server needs the same treatment, for a reason that runs the other
 * way. On the dev server's 5173 the suite shares an origin — and so
 * `localStorage` — with any app tab the developer has open: when a run stopped
 * and replaced their dev server, that tab reconnected to the suite's Vite,
 * reloaded against the throwaway backend, and wrote its fixture helpers into
 * the developer's own vaults, where they outlived the run as "actor not found"
 * rows. A port nobody browses keeps the run out of their storage, and never
 * adopting an existing server keeps their dev server — pointed at 5000 — out
 * of the run.
 */
const BACKEND_PORT = 5100
const BACKEND_GRPC_PORT = 50151
const WEB_PORT = 5180

/** Vite serves under `base: '/reference-app/'`, so the app is not at the root. */
const APP_URL = `http://localhost:${WEB_PORT}/reference-app/`

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  // DeRec flows are polling-based: a pairing round trip waits on a mailbox
  // poll on each side, so the default 30s is too tight for anything real.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // The backend holds one shared actor registry and one participant pool, so
  // parallel workers would provision into each other's fixtures.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: APP_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
  },

  projects: [
    {
      name: 'chrome',
      use: {
        // Google Chrome itself, not Playwright's bundled Chromium and not
        // whatever other Chromium build is installed. `channel` is what picks
        // the binary — a `devices` entry only sets a matching user agent.
        //
        // Deliberately *not* spread from `devices['Desktop Chrome']`: that
        // pins a hardcoded (and, on this machine, Windows) user-agent string
        // over the real browser's own. For an app whose whole purpose is
        // interoperability testing, the UA should be the one Chrome actually
        // sends.
        channel: 'chrome',
        viewport: { width: 1280, height: 900 },
        // A synthetic camera, so the QR scanner's camera lifecycle is
        // exercisable on a machine with no webcam and without a permission
        // prompt blocking the run. The fake device emits a rolling pattern
        // rather than a QR, so tests that need a *decode* stub the detector —
        // what is being tested there is this app's loop and teardown, not
        // Chromium's decoder.
        permissions: ['camera'],
        launchOptions: {
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        },
      },
    },
  ],

  webServer: [
    {
      command: 'cargo run',
      cwd: '../backend',
      // `/health` rather than an API route: it is the unversioned liveness
      // probe, so the harness does not move when the API's prefix does.
      url: `http://localhost:${BACKEND_PORT}/health`,
      // Never adopted, always started: the whole point of the throwaway
      // database below is that no run inherits another's rows, and reusing a
      // process this config did not start inherits whatever it was given.
      reuseExistingServer: false,
      env: {
        DEREC_PORT: String(BACKEND_PORT),
        DEREC_GRPC_PORT: String(BACKEND_GRPC_PORT),
        // A throwaway database per run. The backend now persists to
        // `derec.db` by default, which would carry one run's rows into the
        // next — these specs all assume a node that has never been set up.
        // It also avoids a stale file blocking boot after a migration edit.
        //
        // Restart survival is proven in `tests/persistence.rs`, over a real
        // file; nothing here needs state to outlive the process.
        DEREC_DATABASE_URL: 'sqlite::memory:',
      },
      // Cold `cargo run` on a clean target/ is slow; a warm one is instant.
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `npm run dev -- --port ${WEB_PORT} --strictPort`,
      url: APP_URL,
      // Never adopted, as with the backend: see `WEB_PORT`.
      reuseExistingServer: false,
      env: {
        // The app otherwise calls port 5000 of whatever host served it — see
        // `apiBase` — which is the default node, not this run's.
        VITE_API_URL: `http://localhost:${BACKEND_PORT}`,
      },
      timeout: 120_000,
    },
  ],
})
