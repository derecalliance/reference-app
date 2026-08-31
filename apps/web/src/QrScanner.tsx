import { useEffect, useRef, useState } from 'react'
import {
  describeQrScanFailure,
  startQrScan,
  type QrScanFailure,
  type QrScanSession,
} from './qrScanning'

/**
 * Live camera view that reports the first QR payload it decodes.
 *
 * Mounted only once the caller has established that scanning is available (see
 * `qrScanSupport`), so this handles the runtime failures that capability
 * detection cannot predict — chiefly the user declining the permission prompt.
 */
export interface QrScannerProps {
  /** The decoded payload. Fires once; the camera is released first. */
  onScan: (value: string) => void
  /** The user gave up. The camera is already released. */
  onCancel: () => void
}

export function QrScanner({ onScan, onCancel }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const sessionRef = useRef<QrScanSession | null>(null)
  const [failure, setFailure] = useState<QrScanFailure | null>(null)

  // Callbacks are held in refs so the effect depends on nothing: re-running it
  // would mean releasing and re-acquiring the camera, which flashes the
  // recording indicator and re-prompts on some platforms.
  const onScanRef = useRef(onScan)
  const onCancelRef = useRef(onCancel)
  useEffect(() => { onScanRef.current = onScan }, [onScan])
  useEffect(() => { onCancelRef.current = onCancel }, [onCancel])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let disposed = false

    void startQrScan(
      video,
      value => { if (!disposed) onScanRef.current(value) },
      reason => { if (!disposed) setFailure(reason) },
    ).then(session => {
      sessionRef.current = session
      // `startQrScan` resolves after an await, so the component can already be
      // gone — and then nothing else would ever stop the camera.
      if (disposed) session.stop()
    })

    return () => {
      disposed = true
      sessionRef.current?.stop()
      sessionRef.current = null
    }
  }, [])

  function handleCancel() {
    sessionRef.current?.stop()
    onCancel()
  }

  return (
    <div className="qr-scanner">
      {failure ? (
        <p className="field-error">{describeQrScanFailure(failure)}</p>
      ) : (
        <>
          <div className="qr-scanner__viewport">
            <video
              ref={videoRef}
              className="qr-scanner__video"
              muted
              playsInline
              aria-label="Camera preview for scanning a contact QR code"
            />
          </div>
          <p className="modal-description">Point the camera at the other device's QR code.</p>
        </>
      )}

      <button type="button" className="secondary" onClick={handleCancel}>
        {failure ? 'Back to paste' : 'Cancel scan'}
      </button>
    </div>
  )
}

export default QrScanner
