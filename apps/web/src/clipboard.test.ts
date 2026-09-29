import { afterEach, describe, expect, it, vi } from 'vitest'

import { copyText } from './clipboard'

/**
 * Copying has to work on a plain-http LAN origin.
 *
 * That is not a hypothetical: the app is served that way so a phone can reach
 * it, and there `navigator.clipboard` is `undefined` entirely — secure-context
 * gated, exactly like the camera. Every copy button in the app threw on the
 * click and did nothing visible, which is how this reached a user.
 */
describe('copyText', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'clipboard', original)
    else Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'clipboard')
    vi.restoreAllMocks()
  })

  function setClipboard(value: unknown) {
    Object.defineProperty(navigator, 'clipboard', { value, configurable: true })
  }

  it('uses the clipboard API when it is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })

    await expect(copyText('payload')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('payload')
  })

  it('falls back when the clipboard API is absent, as on a LAN http origin', async () => {
    setClipboard(undefined)
    const exec = vi.fn().mockReturnValue(true)
    document.execCommand = exec as unknown as typeof document.execCommand

    await expect(copyText('payload')).resolves.toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
  })

  it('falls back when the clipboard API exists but rejects', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    const exec = vi.fn().mockReturnValue(true)
    document.execCommand = exec as unknown as typeof document.execCommand

    await expect(copyText('payload')).resolves.toBe(true)
    expect(exec).toHaveBeenCalled()
  })

  it('reports failure rather than pretending, when nothing can copy', async () => {
    // The caller renders this: a button that silently does nothing is what
    // made the original bug invisible.
    setClipboard(undefined)
    document.execCommand = vi.fn().mockReturnValue(false) as unknown as typeof document.execCommand

    await expect(copyText('payload')).resolves.toBe(false)
  })

  it('leaves no scratch node behind', async () => {
    setClipboard(undefined)
    document.execCommand = vi.fn().mockReturnValue(true) as unknown as typeof document.execCommand

    await copyText('payload')

    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('survives execCommand throwing', async () => {
    setClipboard(undefined)
    document.execCommand = vi.fn(() => {
      throw new Error('not allowed')
    }) as unknown as typeof document.execCommand

    await expect(copyText('payload')).resolves.toBe(false)
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })
})
