/**
 * Camera QR scanning, built on the browser's own `BarcodeDetector`.
 *
 * No decoding library: Chromium ships a `BarcodeDetector` that already supports
 * `qr_code`, and this app pairs by showing a QR on one screen and reading it on
 * another — a job the platform does natively and well. Browsers without it
 * (Firefox, and Safari at time of writing) simply do not offer the scan
 * affordance, and the paste field that has always been there stays the way in.
 *
 * Everything here is capability detection and lifecycle. The React surface is
 * `QrScanner.tsx`.
 */

/** The subset of the `BarcodeDetector` API this app uses. */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike
  getSupportedFormats?: () => Promise<string[]>
}

function detectorConstructor(): BarcodeDetectorConstructor | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector
  return typeof ctor === 'function' ? ctor : null
}

/**
 * Why scanning is unavailable, when it is — so the UI can say something more
 * useful than hiding a button with no explanation.
 */
export type QrScanUnavailable =
  /** No `BarcodeDetector`, or it cannot do QR codes. */
  | 'unsupported-browser'
  /** `getUserMedia` needs a secure context; plain http on a LAN address is not one. */
  | 'insecure-context'
  /** The API exists but the machine has no camera attached. */
  | 'no-camera'

export type QrScanSupport = { supported: true } | { supported: false; reason: QrScanUnavailable }

/**
 * Whether this device can scan a QR code, and if not, why.
 *
 * Deliberately does **not** prompt for camera permission. `enumerateDevices`
 * reports device *kinds* without it (labels come back empty until permission is
 * granted), which is enough to know a camera exists — so the button can be
 * offered or withheld before the user has agreed to anything.
 */
export async function qrScanSupport(): Promise<QrScanSupport> {
  // Checked **first**, because an insecure origin withholds the very APIs the
  // other checks look for: over plain http on a LAN address Chrome exposes
  // neither `navigator.mediaDevices` nor `BarcodeDetector`. Probing for those
  // first would blame the browser for what is actually the origin — and send
  // someone looking for a different browser when what they need is https or a
  // loopback address.
  if (!globalThis.isSecureContext) return { supported: false, reason: 'insecure-context' }

  const ctor = detectorConstructor()
  if (!ctor) return { supported: false, reason: 'unsupported-browser' }

  // A `BarcodeDetector` is not obliged to do QR specifically.
  try {
    const formats = (await ctor.getSupportedFormats?.()) ?? []
    if (formats.length > 0 && !formats.includes('qr_code')) {
      return { supported: false, reason: 'unsupported-browser' }
    }
  } catch {
    return { supported: false, reason: 'unsupported-browser' }
  }

  if (!navigator.mediaDevices?.getUserMedia) return { supported: false, reason: 'no-camera' }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    if (!devices.some(d => d.kind === 'videoinput')) {
      return { supported: false, reason: 'no-camera' }
    }
  } catch {
    return { supported: false, reason: 'no-camera' }
  }

  return { supported: true }
}

/**
 * Human-readable explanation for a withheld scan affordance.
 *
 * The insecure-context case is the one worth spelling out. It is what a phone
 * hits when it opens this app at a LAN address, the browser withholds the
 * camera APIs entirely, and nothing on screen says why — so the message names
 * the origin and the setting that fixes it rather than stopping at "needs
 * https", which reads as "give up".
 */
export function describeQrScanUnavailable(reason: QrScanUnavailable): string {
  switch (reason) {
    case 'unsupported-browser':
      return 'This browser cannot decode QR codes. Paste the payload instead.'
    case 'insecure-context': {
      const origin = typeof window === 'undefined' ? 'this address' : window.location.origin
      return (
        `Browsers only allow camera access on a secure origin, and ${origin} is not one. ` +
        'On Android, add it under chrome://flags → "Insecure origins treated as secure", ' +
        'then relaunch Chrome. Otherwise paste the payload instead.'
      )
    }
    case 'no-camera':
      return 'No camera found on this device. Paste the payload instead.'
  }
}

/** Why a scan attempt ended without a code. */
export type QrScanFailure = 'permission-denied' | 'no-camera' | 'unavailable'

export function describeQrScanFailure(failure: QrScanFailure): string {
  switch (failure) {
    case 'permission-denied':
      return 'Camera permission was denied. Allow it in the browser, or paste the payload instead.'
    case 'no-camera':
      return 'No camera could be opened. Paste the payload instead.'
    case 'unavailable':
      return 'The camera could not be started. Paste the payload instead.'
  }
}

/** Map a `getUserMedia` rejection onto something the UI can explain. */
export function classifyCameraError(error: unknown): QrScanFailure {
  const name = (error as { name?: string } | null)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission-denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-camera'
  return 'unavailable'
}

export interface QrScanSession {
  /** Stop decoding and release the camera. Idempotent. */
  stop(): void
}

/**
 * Open the camera and call `onResult` with the first QR payload seen.
 *
 * The caller owns the `<video>`; this attaches a stream to it and drives a
 * decode loop until something is found or {@link QrScanSession.stop} is called.
 *
 * Releasing the camera matters more than usual here: a page that keeps the
 * stream open leaves the recording indicator lit, which for an app about
 * protecting secrets reads as something worse than a leak. `stop()` is
 * therefore safe to call repeatedly and is called on every exit path —
 * success, failure, and unmount.
 */
export async function startQrScan(
  video: HTMLVideoElement,
  onResult: (value: string) => void,
  onFailure: (failure: QrScanFailure) => void,
): Promise<QrScanSession> {
  const ctor = detectorConstructor()
  if (!ctor) {
    onFailure('unavailable')
    return { stop: () => {} }
  }

  let stream: MediaStream | null = null
  let frame = 0
  let stopped = false

  const stop = () => {
    if (stopped) return
    stopped = true
    if (frame) cancelAnimationFrame(frame)
    stream?.getTracks().forEach(track => track.stop())
    // Detach only if this session still owns the element. Two sessions can
    // briefly share one `<video>` — `StrictMode` runs the effect that starts
    // them twice — and blindly nulling `srcObject` would tear the stream out
    // from under the *newer* session, which then fails to play and reports the
    // camera as unstartable.
    if (stream && video.srcObject === stream) video.srcObject = null
    stream = null
  }

  try {
    // `environment` is a preference, not a requirement — a laptop only has a
    // front camera and must still work, so this must not be `exact`.
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    })
  } catch (error) {
    onFailure(classifyCameraError(error))
    return { stop }
  }

  if (stopped) {
    // Unmounted while the permission prompt was up.
    stream.getTracks().forEach(track => track.stop())
    return { stop }
  }

  // Set imperatively rather than relying on the JSX props: React applies
  // `muted` as an *attribute*, which Chrome's autoplay policy does not honour —
  // `play()` then rejects with `NotAllowedError` and the preview never starts.
  video.muted = true
  video.playsInline = true
  video.srcObject = stream

  try {
    await video.play()
  } catch {
    stop()
    onFailure('unavailable')
    return { stop }
  }

  const detector = new ctor({ formats: ['qr_code'] })

  const tick = async () => {
    if (stopped) return
    // A frame with no dimensions yet cannot be decoded, and passing one to
    // `detect` throws on some builds.
    if (video.readyState >= 2 && video.videoWidth > 0) {
      try {
        const found = await detector.detect(video)
        const value = found.find(f => f.rawValue)?.rawValue
        if (value) {
          stop()
          onResult(value)
          return
        }
      } catch {
        // A single undecodable frame is the normal case, not an error.
      }
    }
    if (!stopped) frame = requestAnimationFrame(() => void tick())
  }

  frame = requestAnimationFrame(() => void tick())
  return { stop }
}
