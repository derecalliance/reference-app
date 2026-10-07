// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { ModalFrame } from '../ModalFrame'
import { TransportBlock } from './TransportTag'
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useConsole } from '../ConsoleContext'
import { CONTACT_MODE_OPTIONS, type ContactModeKey, DEFAULT_CONTACT_MODE } from '../contactModes'
import { errorText } from '../errorText'
import { serializeContact } from './contact'
import { CopyButton, ModalCloseButton } from './primitives'
import type { PairingRoleOption } from '../pairingRoleOptions'
import type { PairingRole } from '../pairingRoles'
import type { Transport } from '../types'
import type { ContactMessage } from '@derec-alliance/web'
import { QRCodeSVG } from 'qrcode.react'

// Works for both directions: owner showing their QR (participant scans) and
// participant showing their QR (owner scans). `createContact` abstracts which
// protocol instance to call.
type ShareContactStep =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; channelId: bigint; qrPayload: string; rawHex: string }

/**
 * What the latest contact request left behind. The `ready` step is derived from
 * the contact rather than stored alongside it, so the two cannot disagree.
 */
type ContactOutcome =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; contact: ContactMessage }

/**
 * Role picker for a pairing.
 *
 * Pairing is unidirectional in every mode: whichever side initiates declares its
 * own role on the wire and the responder takes the complement. Which roles are
 * on offer depends on the surface — the browser path offers all four, including
 * the replica roles, while provisioned pairing offers only Owner/Helper — so the
 * option list is supplied by the caller and `R` narrows to whatever it holds.
 */
export function PairingRoleSelector<R extends PairingRole>({
  value,
  onChange,
  options,
  disabled,
  idPrefix,
  legend = 'Your role',
}: {
  value: R
  onChange: (role: R) => void
  options: readonly PairingRoleOption<R>[]
  disabled?: boolean
  idPrefix: string
  legend?: string
}) {
  return (
    <fieldset className="role-selector" disabled={disabled}>
      <legend className="sub-heading">{legend}</legend>
      <div className="role-selector__options">
        {options.map(({ role, label, hint }) => (
          <label
            key={role}
            className={`role-option${value === role ? ' role-option--selected' : ''}`}
            htmlFor={`${idPrefix}-role-${role}`}
          >
            <input
              type="radio"
              id={`${idPrefix}-role-${role}`}
              name={`${idPrefix}-role`}
              value={role}
              checked={value === role}
              onChange={() => onChange(role)}
            />
            <span className="role-option__label">{label}</span>
            <span className="role-option__hint">{hint}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/**
 * Picks how a contact publishes its keys.
 *
 * Mirrors `PairingRoleSelector` — same markup and classes — because both are
 * "choose one option before pairing" controls and the panel should not grow a
 * second visual language for the same job.
 */
export function ContactModeSelector({
  value,
  onChange,
  disabled,
  idPrefix,
  legend = 'Contact mode',
}: {
  value: ContactModeKey
  onChange: (mode: ContactModeKey) => void
  disabled?: boolean
  idPrefix: string
  legend?: string
}) {
  return (
    <fieldset className="role-selector" disabled={disabled}>
      <legend className="sub-heading">{legend}</legend>
      <div className="role-selector__options">
        {CONTACT_MODE_OPTIONS.map(({ key, label, hint }) => (
          // The hint is on hover rather than on its own line: three modes ×
          // a line of explanation is most of this control's height, and this
          // selector also renders inside the Share Contact modal, which has a
          // QR code to fit. `title` gives the pointer affordance; the
          // visually-hidden copy keeps it reachable by screen reader, which a
          // `title` alone is not.
          <label
            key={key}
            className={`role-option${value === key ? ' role-option--selected' : ''}`}
            htmlFor={`${idPrefix}-mode-${key}`}
            title={hint}
          >
            <input
              type="radio"
              id={`${idPrefix}-mode-${key}`}
              name={`${idPrefix}-mode`}
              value={key}
              checked={value === key}
              onChange={() => onChange(key)}
              aria-describedby={`${idPrefix}-mode-${key}-hint`}
            />
            <span className="role-option__label">{label}</span>
            <span id={`${idPrefix}-mode-${key}-hint`} className="visually-hidden">
              {hint}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function ShareContactModal({
  title,
  transport,
  createContact,
  onClose,
  onPairingCreated,
}: {
  title: string
  transport: Transport
  createContact: (mode: ContactModeKey) => Promise<ContactMessage>
  onClose: () => void
  onPairingCreated?: (channelId: bigint) => void
}) {
  const { log } = useConsole()
  const [outcome, setOutcome] = useState<ContactOutcome>({ kind: 'loading' })
  const [mode, setMode] = useState<ContactModeKey>(DEFAULT_CONTACT_MODE)
  // The first contact is requested on mount, so the modal opens refreshing.
  const [refreshing, setRefreshing] = useState(true)
  /**
   * The mode a contact was last requested for — which is always the mode
   * selected, because a request goes out exactly when the mode is set.
   *
   * It does two jobs. A resolved request is applied only while its mode is
   * still this one, so a result superseded by a newer *mode* is dropped. And it
   * keeps the mount request from going out twice: `StrictMode` runs effects
   * twice in development, and asking the peer to mint a contact creates a real
   * pending channel on the server — two concurrent `create_contact` messages to
   * the same actor can make one of them fail. A per-run `cancelled` flag could
   * not do either: `StrictMode`'s immediate cleanup would mark the only request
   * cancelled, leaving no contact ever appearing.
   */
  const requestedModeRef = useRef<ContactModeKey | null>(null)

  const step = useMemo<ShareContactStep>(
    () => (outcome.kind === 'ready' ? readyStep(outcome.contact) : outcome),
    [outcome],
  )

  /** Asks the peer to mint a contact in `next`, applying it only if still wanted. */
  function requestContact(next: ContactModeKey) {
    requestedModeRef.current = next
    createContact(next)
      .then(c => {
        if (requestedModeRef.current !== next) return
        setOutcome({ kind: 'ready', contact: c })
        onPairingCreated?.(BigInt(c.channel_id))
        log({
          role: 'owner',
          flow: 'pairing',
          step: 'create_contact',
          description: `Contact created for ${transport.uri} (${next})`,
          payload: {
            channelId: c.channel_id.toString(),
            transportUri: transport.uri,
            contactMode: next,
          },
        })
      })
      .catch((err: unknown) => {
        if (requestedModeRef.current !== next) return
        setOutcome({ kind: 'error', message: errorText(err) })
      })
      .finally(() => {
        // A superseded request must not clear the flag out from under the newer one.
        if (requestedModeRef.current === next) setRefreshing(false)
      })
  }

  const requestInitialContact = useEffectEvent(() => requestContact(mode))
  useEffect(() => {
    if (requestedModeRef.current !== null) return
    requestInitialContact()
  }, [])

  // Re-mints the contact whenever the mode changes: the mode is baked into the
  // contact at creation, so it cannot be applied to one already generated. The
  // abandoned contact is a `Pending` channel and gets swept by the tick.
  //
  // Deliberately does *not* drop back to the loading step. On the first open
  // there is nothing on screen to keep, but on a mode change there is — and
  // unmounting the QR, the copy row and the transport block collapses the modal
  // to its header and springs it back a moment later, which reads as a flicker.
  // The layout stays put and is marked stale instead.
  function handleModeChange(next: ContactModeKey) {
    setMode(next)
    if (requestedModeRef.current === next) return
    setRefreshing(true)
    requestContact(next)
  }

  return (
    <ModalFrame
      overlayClassName="modal-overlay"
      className="modal"
      labelledBy="share-contact-title"
      onEscape={onClose}
    >
      <div className="modal-header">
        <h2 className="modal-title" id="share-contact-title">{title}</h2>
        <ModalCloseButton onClose={onClose} />
      </div>

      <div className="modal-body">
        <ContactModeSelector
          value={mode}
          onChange={handleModeChange}
          idPrefix="share-contact"
        />

        {step.kind === 'loading' && (
          <p className="modal-description">Generating contact message…</p>
        )}

        {step.kind === 'error' && (
          <p className="field-error">{step.message}</p>
        )}

        {step.kind === 'ready' && (
          <>
            {/* Same box either way, so the modal keeps its height while a new
                contact is minted. The old QR is *replaced* rather than dimmed:
                it encodes a real, still-pending channel in the previous mode,
                and someone scanning it mid-swap would pair in a mode the user
                has just moved away from. */}
            <div className="qr-wrapper" aria-busy={refreshing || undefined}>
              {refreshing ? (
                <div className="qr-placeholder">Generating…</div>
              ) : (
                /* Deliberately does not follow the colour scheme: a QR needs
                   dark modules on a light field to scan. The wrapper supplies
                   the cream field, so the code itself draws transparent. */
                <QRCodeSVG
                  value={step.qrPayload}
                  size={200}
                  bgColor="transparent"
                  fgColor="#0f1512"
                />
              )}
            </div>

            <div className="modal-section">
              <h3 className="sub-heading">Copy</h3>
              <div className="copy-row">
                {/* Copying is disabled for the same reason the QR is hidden —
                    the payload on screen is about to be superseded. */}
                <CopyButton label="QR Payload" text={step.qrPayload} disabled={refreshing} />
                <CopyButton label="Raw Bytes (hex)" text={step.rawHex} disabled={refreshing} />
              </div>
            </div>

            <div className="modal-section">
              <h3 className="sub-heading">Transport</h3>
              <TransportBlock transport={transport} />
            </div>
          </>
        )}
      </div>
    </ModalFrame>
  )
}

function readyStep(contact: ContactMessage): ShareContactStep {
  return {
    kind: 'ready',
    channelId: BigInt(contact.channel_id),
    qrPayload: serializeContact(contact),
    rawHex: contact.channel_id.toString(),
  }
}
