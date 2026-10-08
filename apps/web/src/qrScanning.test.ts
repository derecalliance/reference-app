// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyCameraError, qrScanSupport, startQrScan } from './qrScanning'

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

describe('startQrScan', () => {
  /** A camera whose `getUserMedia` answers only when the test says so. */
  function deferredCamera() {
    const opens: Array<{ track: { stop: ReturnType<typeof vi.fn> }; open: () => void }> = []
    setMediaDevices({
      getUserMedia: () =>
        new Promise(resolve => {
          const track = { stop: vi.fn() }
          opens.push({ track, open: () => resolve({ getTracks: () => [track] }) })
        }),
    })
    return opens
  }

  /** A `<video>` whose `play()` is interrupted when another stream is attached. */
  function sharedVideo() {
    let pending: { reject: (e: Error) => void } | null = null
    let srcObject: unknown = null
    const video = {
      muted: false,
      playsInline: false,
      readyState: 0,
      videoWidth: 0,
      get srcObject() {
        return srcObject
      },
      set srcObject(value: unknown) {
        pending?.reject(new Error('The play() request was interrupted by a new load request.'))
        pending = null
        srcObject = value
      },
      play: () => new Promise<void>((_resolve, reject) => (pending = { reject })),
    }
    return video as unknown as HTMLVideoElement
  }

  afterEach(() => {
    setDetector(originalDetector)
    setMediaDevices(undefined)
  })

  it('a session stopped before its camera opens never touches the shared video', async () => {
    setDetector(detectorSupporting(['qr_code']))
    const opens = deferredCamera()
    const video = sharedVideo()

    // StrictMode: mount, unmount, remount — two sessions on one element, the
    // first discarded before either camera has opened.
    const firstFailure = vi.fn()
    const first = startQrScan(video, vi.fn(), firstFailure)
    first.stop()
    const liveFailure = vi.fn()
    startQrScan(video, vi.fn(), liveFailure)
    await Promise.resolve()

    // Under load the discarded session's camera can open *after* the live one.
    opens[1].open()
    await vi.waitFor(() => expect(video.srcObject).not.toBeNull())
    const liveStream = video.srcObject
    opens[0].open()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(video.srcObject).toBe(liveStream)
    expect(opens[0].track.stop).toHaveBeenCalled()
    expect(liveFailure).not.toHaveBeenCalled()
    expect(firstFailure).not.toHaveBeenCalled()
  })

  it('reports nothing for a session stopped while its preview was starting', async () => {
    setDetector(detectorSupporting(['qr_code']))
    const opens = deferredCamera()
    const video = sharedVideo()
    const onFailure = vi.fn()

    const session = startQrScan(video, vi.fn(), onFailure)
    await Promise.resolve()
    opens[0].open()
    await vi.waitFor(() => expect(video.srcObject).not.toBeNull())
    session.stop()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(onFailure).not.toHaveBeenCalled()
    expect(video.srcObject).toBeNull()
    expect(opens[0].track.stop).toHaveBeenCalled()
  })
})
