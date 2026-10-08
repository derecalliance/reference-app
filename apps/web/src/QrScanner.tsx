// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

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

    // The session is stoppable from the moment it is created, before the
    // camera opens — see `startQrScan` for why that matters under StrictMode.
    const session = startQrScan(
      video,
      value => onScanRef.current(value),
      reason => setFailure(reason),
    )
    sessionRef.current = session

    return () => {
      session.stop()
      if (sessionRef.current === session) sessionRef.current = null
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
