import { test as base, expect } from '@playwright/test'

/**
 * Browser-side errors are otherwise invisible in a headless run: a WASM load
 * failure or a thrown effect shows up only as a locator timeout twenty seconds
 * later. Every page in every test collects them, and anything captured is
 * attached to the report so a failure names its own cause.
 */
export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use, testInfo) => {
      const errors: string[] = []

      // The WASM bindings throw plain objects, which reach `pageerror` as an
      // Error with the message "Object" and no stack. Serialising the raw value
      // in the page is the only way to see what actually went wrong.
      await page.addInitScript(() => {
        const describe = (value: unknown): string => {
          if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
          try {
            return JSON.stringify(value, Object.getOwnPropertyNames(Object(value)))
          } catch {
            return String(value)
          }
        }
        window.addEventListener('error', event => {
          console.error('[uncaught]', describe(event.error ?? event.message))
        })
        window.addEventListener('unhandledrejection', event => {
          console.error('[unhandled rejection]', describe(event.reason))
        })
      })

      page.on('pageerror', error => {
        errors.push(`[pageerror] ${error.message}`)
      })
      page.on('console', message => {
        if (message.type() === 'error') errors.push(`[console.error] ${message.text()}`)
      })

      await use(errors)

      if (errors.length > 0) {
        await testInfo.attach('browser-errors', {
          body: errors.join('\n'),
          contentType: 'text/plain',
        })
      }
    },
    { auto: true },
  ],
})

export { expect }
