// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { ModalFrame } from '../ModalFrame'
import { TransportBlock } from './TransportTag'
import { useEffect, useRef, useState } from 'react'
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
  const [step, setStep] = useState<ShareContactStep>({ kind: 'loading' })
  const [contact, setContact] = useState<ContactMessage | null>(null)
  const [mode, setMode] = useState<ContactModeKey>(DEFAULT_CONTACT_MODE)
  const [refreshing, setRefreshing] = useState(false)
  /**
   * The mode a contact has already been requested for.
   *
   * `StrictMode` runs effects twice in development, and this effect's side
   * effect is a *remote* one: it asks the peer to mint a contact, which creates
   * a real pending channel on the server. The cleanup flag stops the second
   * result being applied, but cannot un-send the request — so without this the
   * modal mints two channels every time it opens, and two concurrent
   * `create_contact` messages to the same actor can make one of them fail.
   */
  const requestedModeRef = useRef<ContactModeKey | null>(null)
  /**
   * The mode currently selected, readable from inside an in-flight request.
   *
   * Written during render rather than from an effect so it is already correct
   * when the effect below compares against it. This is what decides whether a
   * resolved request is still wanted — a per-run `cancelled` flag cannot,
   * because `StrictMode`'s immediate cleanup would mark the *first* run
   * cancelled and the second run skips as a duplicate, leaving nothing to
   * apply and no contact ever appearing.
   */
  const latestModeRef = useRef<ContactModeKey>(mode)
  latestModeRef.current = mode

  // Re-mints the contact whenever the mode changes: the mode is baked into the
  // contact at creation, so it cannot be applied to one already generated. The
  // abandoned contact is a `Pending` channel and gets swept by the tick.
  //
  // Deliberately does *not* drop back to the loading step. On the first open
  // there is nothing on screen to keep, but on a mode change there is — and
  // unmounting the QR, the copy row and the transport block collapses the modal
  // to its header and springs it back a moment later, which reads as a flicker.
  // The layout stays put and is marked stale instead.
  useEffect(() => {
    if (requestedModeRef.current === mode) return
    requestedModeRef.current = mode

    setRefreshing(true)

    createContact(mode)
      .then(c => {
        // Superseded only by a newer *mode*, not by a re-run of this effect.
        if (latestModeRef.current !== mode) return
        setContact(c)
        onPairingCreated?.(BigInt(c.channel_id))
        log({
          role: 'owner',
          flow: 'pairing',
          step: 'create_contact',
          description: `Contact created for ${transport.uri} (${mode})`,
          payload: {
            channelId: c.channel_id.toString(),
            transportUri: transport.uri,
            contactMode: mode,
          },
        })
      })
      .catch((err: unknown) => {
        if (latestModeRef.current !== mode) return
        setStep({ kind: 'error', message: errorText(err) })
      })
      .finally(() => {
        // A superseded run must not clear the flag out from under the newer one.
        if (latestModeRef.current === mode) setRefreshing(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  useEffect(() => {
    if (!contact) return
    setStep({
      kind: 'ready',
      channelId: BigInt(contact.channel_id),
      qrPayload: serializeContact(contact),
      rawHex: contact.channel_id.toString(),
    })
  }, [contact])

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
          onChange={setMode}
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
