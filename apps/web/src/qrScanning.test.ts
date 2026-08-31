import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyCameraError, qrScanSupport } from './qrScanning'

/**
 * Capability detection decides whether the scan affordance is offered at all,
 * so getting it wrong either hides a working camera or offers a button that
 * fails on click. Each branch is asserted against the environment that produces
 * it.
 */

const originalDetector = (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector
const originalSecure = globalThis.isSecureContext

function setDetector(value: unknown) {
  Object.defineProperty(globalThis, 'BarcodeDetector', {
    value,
    configurable: true,
    writable: true,
  })
}

function setSecureContext(value: boolean) {
  Object.defineProperty(globalThis, 'isSecureContext', { value, configurable: true })
}

function setMediaDevices(value: unknown) {
  Object.defineProperty(navigator, 'mediaDevices', { value, configurable: true })
}

/** A `BarcodeDetector` stand-in advertising the given formats. */
function detectorSupporting(formats: string[]) {
  const ctor = function () {} as unknown as { getSupportedFormats: () => Promise<string[]> }
  ctor.getSupportedFormats = () => Promise.resolve(formats)
  return ctor
}

function camerasPresent(present: boolean) {
  return {
    getUserMedia: vi.fn(),
    enumerateDevices: () =>
      Promise.resolve(present ? [{ kind: 'videoinput' } as MediaDeviceInfo] : []),
  }
}

afterEach(() => {
  setDetector(originalDetector)
  setSecureContext(originalSecure)
})

describe('qrScanSupport', () => {
  it('is supported with a QR-capable detector, a secure context and a camera', async () => {
    setDetector(detectorSupporting(['qr_code', 'ean_13']))
    setSecureContext(true)
    setMediaDevices(camerasPresent(true))

    expect(await qrScanSupport()).toEqual({ supported: true })
  })

  it('blames the origin, not the browser, on an insecure context', async () => {
    // Over plain http a browser withholds `BarcodeDetector` *and*
    // `mediaDevices`, so a naive probe order reports "unsupported browser" and
    // sends the user hunting for a different one. This is the case a phone on
    // a LAN address actually hits.
    setDetector(undefined)
    setSecureContext(false)
    setMediaDevices(undefined)

    expect(await qrScanSupport()).toEqual({ supported: false, reason: 'insecure-context' })
  })

  it('is unsupported without a BarcodeDetector', async () => {
    setDetector(undefined)
    setSecureContext(true)
    setMediaDevices(camerasPresent(true))

    expect(await qrScanSupport()).toEqual({
      supported: false,
      reason: 'unsupported-browser',
    })
  })

  it('is unsupported when the detector cannot do QR codes', async () => {
    // A `BarcodeDetector` is not obliged to support every format — offering the
    // button on one that only reads barcodes would fail at decode time.
    setDetector(detectorSupporting(['ean_13', 'code_128']))
    setSecureContext(true)
    setMediaDevices(camerasPresent(true))

    expect(await qrScanSupport()).toEqual({
      supported: false,
      reason: 'unsupported-browser',
    })
  })

  it('reports an insecure context distinctly from a missing camera', async () => {
    // Plain http on a LAN address: the API exists, the camera exists, and
    // `getUserMedia` will still refuse. Naming it lets the UI say why.
    setDetector(detectorSupporting(['qr_code']))
    setSecureContext(false)
    setMediaDevices(camerasPresent(true))

    expect(await qrScanSupport()).toEqual({
      supported: false,
      reason: 'insecure-context',
    })
  })

  it('is unsupported when the device has no camera', async () => {
    setDetector(detectorSupporting(['qr_code']))
    setSecureContext(true)
    setMediaDevices(camerasPresent(false))

    expect(await qrScanSupport()).toEqual({ supported: false, reason: 'no-camera' })
  })

  it('treats a detector that cannot report formats as unusable', async () => {
    const ctor = function () {} as unknown as { getSupportedFormats: () => Promise<string[]> }
    ctor.getSupportedFormats = () => Promise.reject(new Error('nope'))
    setDetector(ctor)
    setSecureContext(true)
    setMediaDevices(camerasPresent(true))

    expect(await qrScanSupport()).toEqual({
      supported: false,
      reason: 'unsupported-browser',
    })
  })
})

describe('classifyCameraError', () => {
  it('separates a declined prompt from an absent camera', () => {
    // These need different wording: one is fixed in browser settings, the other
    // cannot be fixed at all on that device.
    expect(classifyCameraError({ name: 'NotAllowedError' })).toBe('permission-denied')
    expect(classifyCameraError({ name: 'SecurityError' })).toBe('permission-denied')
    expect(classifyCameraError({ name: 'NotFoundError' })).toBe('no-camera')
    expect(classifyCameraError({ name: 'OverconstrainedError' })).toBe('no-camera')
  })

  it('falls back to a generic failure for anything else', () => {
    expect(classifyCameraError({ name: 'AbortError' })).toBe('unavailable')
    expect(classifyCameraError(null)).toBe('unavailable')
    expect(classifyCameraError(new Error('boom'))).toBe('unavailable')
  })
})
