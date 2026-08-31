import { defineConfig } from '@playwright/test'

/**
 * End-to-end harness for the reference app.
 *
 * Both halves of the stack are started here: the Rust backend (actor registry
 * and message relay) and the Vite dev server. A test that only exercises UI
 * still needs the backend, because the setup wizard provisions actors against
 * it before it will hand back an owner.
 */

const BACKEND_PORT = 5000
const WEB_PORT = 5173

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
      url: `http://localhost:${BACKEND_PORT}/config`,
      reuseExistingServer: !process.env.CI,
      // Cold `cargo run` on a clean target/ is slow; a warm one is instant.
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `npm run dev -- --port ${WEB_PORT} --strictPort`,
      url: APP_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})
