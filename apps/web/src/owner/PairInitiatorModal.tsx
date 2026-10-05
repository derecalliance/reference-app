// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { ModalFrame } from '../ModalFrame'
import { PairingRoleSelector } from './ShareContactModal'
import { useEffect, useRef, useState } from 'react'
import { useConsole } from '../ConsoleContext'
import { useProtocolTimeoutMs } from '../ProtocolConfig'
import { QrScanner } from '../QrScanner'
import { ReplicaPairingWarningDialog, useReplicaEraseConsent } from '../ReplicaPairingWarningDialog'
import { errorText } from '../errorText'
import { pairingErrorText } from '../pairingReach'
import { deserializeContact } from './contact'
import { ModalCloseButton } from './primitives'
import {
  type PairingRoleOption,
  pairingRoleLabel,
  pairingSuccessMessage,
} from '../pairingRoleOptions'
import { type PairingRole, complementRole } from '../pairingRoles'
import { type QrScanSupport, describeQrScanUnavailable, qrScanSupport } from '../qrScanning'
import { requestPairingConsent } from '../replicaPairingConsent'
import { advertisedEndpoints, type ContactMessage } from '@derec-alliance/web'

// Handles scanning/pasting a peer's contact QR. `startPairing` abstracts
// which protocol instance (owner or recovery) to route the request through.
type PairInitiatorStep =
  | { kind: 'input' }
  | { kind: 'sending' }
  | { kind: 'waiting'; channelId: bigint }
  | { kind: 'success'; channelId: bigint }
  | { kind: 'failed'; reason: string }

export function PairInitiatorModal<R extends PairingRole>({
  label,
  placeholder,
  participantId,
  pairedChannelIds,
  pairingRejectionCount,
  pairingCompletedSignal,
  onClose,
  onSuccess,
  onPairingRequestSent,
  resolveParticipantId,
  startPairing,
  roleOptions,
  fixedRole,
  defaultRole,
  initiatorLabel,
}: {
  label: string
  placeholder: string
  /** Known participant to associate with this pairing attempt, if applicable. */
  participantId?: string
  /** Set of channel IDs (decimal strings) that are currently paired — used to detect pairing completion. */
  pairedChannelIds: Set<string>
  /** Incremented when a pairing rejection is detected — signals the modal to exit waiting. */
  pairingRejectionCount: number
  /**
   * Incremented when any PairingCompleted event fires. Used as a fallback success signal
   * for recovery pairings where the established channel ID may differ from the one returned
   * by protocol.start() — making the pairedChannelIds set check unreliable.
   */
  pairingCompletedSignal: number
  onClose: () => void
  onSuccess: () => void
  onPairingRequestSent: (
    channelId: bigint,
    participantId?: string,
    peerTransportUri?: string,
  ) => void
  /**
   * Optional: given a contact, resolve which participant ID it belongs to.
   * Used to associate a PairingCompleted event with the correct provisioned
   * participant when the caller doesn't already know the participant ID.
   * Resolved by matching contact.transport_protocol.uri against participant.transport.uri.
   */
  resolveParticipantId?: (contact: ContactMessage) => string | undefined
  /** Called with the role the **initiator** declares on the wire. */
  startPairing: (contact: ContactMessage, role: R) => Promise<bigint>
  /**
   * Roles the initiator may declare, in the order they are offered.
   *
   * The browser path passes all four (`BROWSER_PAIRING_ROLE_OPTIONS`); the
   * provisioned path passes only Owner/Helper, because the backend's
   * `start-pairing` route accepts nothing else.
   */
  roleOptions: readonly PairingRoleOption<R>[]
  /** Role the initiator takes. Fixed for flows that only make sense one way;
   *  selectable otherwise. */
  fixedRole?: R
  /** Which role the selector starts on. Defaults to the first option. */
  defaultRole?: R
  /** Who is doing the pairing, for the selector's labels. Defaults to us. */
  initiatorLabel?: string
}) {
  const { log } = useConsole()
  const timeoutMs = useProtocolTimeoutMs()
  const [payload, setPayload] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<PairInitiatorStep>({ kind: 'input' })
  // The camera view replaces the textarea while open, rather than sitting
  // alongside it: the modal is already the tallest surface in the app, and both
  // fill the same field anyway.
  const [scanning, setScanning] = useState(false)
  // `null` until probed. Probing is async (it enumerates devices) and must not
  // prompt for permission, so the affordance appears a beat after the modal.
  const [scanSupport, setScanSupport] = useState<QrScanSupport | null>(null)

  useEffect(() => {
    let cancelled = false
    void qrScanSupport().then(support => { if (!cancelled) setScanSupport(support) })
    return () => { cancelled = true }
  }, [])
  // A contact carries no role, so nothing here is inferred from the payload:
  // the initiator picks its own side and the responder gets the complement.
  const [role, setRole] = useState<R>(fixedRole ?? defaultRole ?? roleOptions[0].role)
  // Consent for the one destructive choice on offer. Opening it starts nothing
  // and erases nothing; a denial aborts before `startPairing` is ever called.
  const eraseConsent = useReplicaEraseConsent()

  // Snapshotted when entering the waiting state so we only react to events after the request.
  const rejectionCountAtWaitRef = useRef(pairingRejectionCount)
  const completedSignalAtWaitRef = useRef(pairingCompletedSignal)

  // `pairedChannelIds` gains the new channel once PairingCompleted fires, so
  // success is detectable here. The signal fallback below covers the case
  // where the long-term id differs from the transient one we started with.
  useEffect(() => {
    if (step.kind !== 'waiting') return
    const channelIdStr = step.channelId.toString()
    const found = pairedChannelIds.has(channelIdStr)

    if (found) {

       
      setStep({ kind: 'success', channelId: step.channelId })
    }
  }, [step, pairedChannelIds])

  // Fallback for the rekey case (see comment above).
  // Only the 'waiting' variant carries a channel id; narrow it out here so the
  // dependency array does not reach for a field the other variants lack.
  const waitingChannelId = step.kind === 'waiting' ? step.channelId : null

  useEffect(() => {
    if (waitingChannelId === null) return
    if (pairingCompletedSignal > completedSignalAtWaitRef.current) {

       
      setStep({ kind: 'success', channelId: waitingChannelId })
    }
  }, [waitingChannelId, pairingCompletedSignal])

  useEffect(() => {
    if (step.kind !== 'waiting') return
    if (pairingRejectionCount > rejectionCountAtWaitRef.current) {
       
      setStep({ kind: 'failed', reason: 'The peer rejected the pairing request.' })
    }
  }, [step.kind, pairingRejectionCount])

  useEffect(() => {
    if (step.kind !== 'waiting') return
    const timer = setTimeout(() => {
      setStep({ kind: 'failed', reason: 'Pairing request timed out. The peer may not have responded.' })
    }, timeoutMs)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.kind])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    let contact: ContactMessage
    try {
      contact = deserializeContact(payload.trim())
    } catch (err) {
      setError(`Failed: ${errorText(err)}`)
      return
    }

    // Gate before anything is dispatched. A destructive role has to be consented
    // to first; cancelling leaves the form untouched and starts no pairing.
    const consent = await requestPairingConsent(role, eraseConsent.request)
    if (consent.kind === 'cancelled') return

    setStep({ kind: 'sending' })
    try {
      const channelId = await startPairing(contact, role)

      log({
        role: 'owner',
        flow: 'pairing',
        step: 'start_pairing',
        description: `Pairing request sent for channel ${channelId.toString()} as ${role}`,
        // `senderKind` is what actually reaches the wire — logged so a replica
        // pairing that silently degraded to a helper one would be visible here.
        payload: {
          channelId: channelId.toString(),
          role,
          peerRole: consent.pairing.peerRole,
          senderKind: consent.pairing.senderKind,
        },
      })

      // Resolve participant ID from the contact's transport URI when it wasn't
      // provided statically. This handles the case where a provisioned participant's
      // contact JSON is pasted into the generic Pair modal.
      const resolvedParticipantId = participantId ?? resolveParticipantId?.(contact)
      // Carry the contact's URI regardless: browser peers have no participant
      // row to resolve against, and it is what identifies them once the
      // pairing completes.
      onPairingRequestSent(channelId, resolvedParticipantId, advertisedEndpoints(contact)[0]?.uri)
      rejectionCountAtWaitRef.current = pairingRejectionCount
      completedSignalAtWaitRef.current = pairingCompletedSignal
      setStep({ kind: 'waiting', channelId })
    } catch (err) {
      // A failed send is a reachability problem, and says so.
      setError(`Failed: ${pairingErrorText(err)}`)
      setStep({ kind: 'input' })
    }
  }

  function handleClose() {
    if (step.kind === 'success') {
      onSuccess()
    }
    onClose()
  }

  return (
    <ModalFrame
      overlayClassName="modal-overlay"
      className="modal"
      labelledBy="pair-modal-title"
      onEscape={step.kind === 'waiting' ? undefined : handleClose}
    >
      <div className="modal-header">
        <h2 className="modal-title" id="pair-modal-title">
          {step.kind === 'success' ? 'Pairing Complete' : step.kind === 'failed' ? 'Pairing Failed' : 'Pair'}
        </h2>
        {step.kind !== 'waiting' && <ModalCloseButton onClose={handleClose} />}
      </div>

      {step.kind === 'waiting' ? (
        <div className="modal-body">
          <div className="pairing-waiting-indicator">
            <div className="spinner" />
            <p className="modal-description">Pairing request sent. Waiting for the peer to respond…</p>
          </div>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={handleClose}>Cancel</button>
          </div>
        </div>
      ) : step.kind === 'success' ? (
        <div className="modal-body">
          <p className="modal-description">{pairingSuccessMessage(role)}</p>
          <div className="modal-actions">
            <button className="primary" onClick={handleClose}>Done</button>
          </div>
        </div>
      ) : step.kind === 'failed' ? (
        <div className="modal-body">
          <p className="modal-description pairing-error-text">{step.reason}</p>
          <div className="modal-actions">
            <button className="primary" onClick={handleClose}>Close</button>
          </div>
        </div>
      ) : (
        <form className="modal-body" onSubmit={handleSubmit}>
          <div className="form-field">
            <div className="form-label-row">
              <label className="form-label" htmlFor="qr-payload">{label}</label>
              {/* Offered only where it can actually work — no camera, no
                  `BarcodeDetector`, or an insecure origin all leave paste as
                  the single path rather than a button that fails on click.
                  The reason is on the tooltip so a missing button is
                  explicable. */}
              {scanning ? null : scanSupport?.supported ? (
                <button
                  type="button"
                  className="secondary copy-field-btn"
                  onClick={() => { setScanning(true); setError(null) }}
                  disabled={step.kind === 'sending'}
                >
                  Scan QR
                </button>
              ) : scanSupport ? (
                <span
                  className="form-label-hint"
                  title={describeQrScanUnavailable(scanSupport.reason)}
                >
                  Scanning unavailable
                </span>
              ) : null}
            </div>

            {scanning ? (
              <QrScanner
                onScan={value => {
                  setScanning(false)
                  // Straight into the same field the paste path fills, so
                  // everything downstream — validation, role, submission — is
                  // one code path regardless of how the payload arrived.
                  setPayload(value)
                }}
                onCancel={() => setScanning(false)}
              />
            ) : (
              <textarea
                id="qr-payload"
                className="full-input mono-textarea"
                rows={4}
                placeholder={placeholder}
                value={payload}
                onChange={e => setPayload(e.target.value)}
                disabled={step.kind === 'sending'}
                autoFocus
                spellCheck={false}
              />
            )}
            {error && <p className="field-error">{error}</p>}
          </div>

          {!fixedRole && (
            <>
              <PairingRoleSelector
                value={role}
                onChange={setRole}
                options={roleOptions}
                disabled={step.kind === 'sending'}
                idPrefix="pair"
                legend={initiatorLabel ? `${initiatorLabel} role` : 'Your role'}
              />
              <p className="modal-description">
                The other side becomes <strong>{pairingRoleLabel(complementRole(role))}</strong> on
                this channel.
              </p>
            </>
          )}

          <div className="modal-actions">
            <button type="button" className="secondary" onClick={handleClose} disabled={step.kind === 'sending'}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={payload.trim().length === 0 || step.kind === 'sending'}>
              {step.kind === 'sending' ? 'Sending…' : `Pair as ${pairingRoleLabel(role)}`}
            </button>
          </div>
        </form>
      )}

    {/* Consent gate for `replica_destination`. Rendered here only; it decides
        whether `handleSubmit` proceeds and touches no storage either way. */}
    <ReplicaPairingWarningDialog {...eraseConsent.dialogProps} />
    </ModalFrame>
  )
}
