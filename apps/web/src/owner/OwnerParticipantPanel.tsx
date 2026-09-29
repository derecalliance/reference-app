import { connectionStatusLabel } from './connectionStatus'
import { PairInitiatorModal } from './PairInitiatorModal'
import { ProvisionedLinkModal } from './ProvisionedLinkModal'
import { ContactModeSelector, ShareContactModal } from './ShareContactModal'
import { useState } from 'react'
import { type ProvisionedChannel } from '../api'
import { type ContactModeKey, DEFAULT_CONTACT_MODE } from '../contactModes'
import { errorText } from '../errorText'
import { ChevronIcon } from './icons'
import { ModalCloseButton, SharedKeyRow } from './primitives'
import { participantPairingRoleOptions } from '../pairingRoleOptions'
import type { PairingRole } from '../pairingRoles'
import type { PairedParticipant } from '../types'
import type { ContactMessage } from '@derec-alliance/web'
import { faker } from '@faker-js/faker'


function SidePanelParticipantItem({
  participant,
  onTogglePair,
  onPairingRequestSent,
  createParticipantContact,
  listChannels,
  linkChannels,
  startParticipantPairing,
  startPairingAsInitiator,
  pairedChannelIds,
  pairingRejectionCount,
  pairingCompletedSignal,
  unconfirmed,
  onConfirmFingerprint,
}: {
  participant: PairedParticipant
  onTogglePair: (id: string) => void
  onPairingRequestSent: (channelId: bigint, participantId: string) => void
  createParticipantContact: (mode: ContactModeKey) => Promise<ContactMessage>
  /** List the channels this provisioned helper holds, for the link picker. */
  listChannels: (participantId: string) => Promise<ProvisionedChannel[]>
  /** Declare that two of its channels belong to the same owner. */
  linkChannels: (participantId: string, channelId: string, linkTo: string) => Promise<void>
  startParticipantPairing: (contact: ContactMessage, role: PairingRole) => Promise<bigint>
  /**
   * When defined, the Pair button opens a modal for the user to paste the peer's
   * contact JSON. The backend actor then initiates pairing using that contact,
   * taking the complement of the role chosen here.
   *
   *  Drives a backend-managed (provisioned) actor via `apiStartActorPairing`,
   *  which only supports participant roles — narrower than `PairingRole`.
   */
  startPairingAsInitiator?: (ownerContact: ContactMessage, role: 'owner' | 'helper') => Promise<bigint>
  pairedChannelIds: Set<string>
  pairingRejectionCount: number
  pairingCompletedSignal: number
  /** The handshake completed but the library still holds the channel `Pending`. */
  unconfirmed: boolean
  onConfirmFingerprint: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [shareContactOpen, setShareContactOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [pairAsInitiatorOpen, setPairAsInitiatorOpen] = useState(false)
  const [isPairing, setIsPairing] = useState(false)
  const [pairError, setPairError] = useState<string | null>(null)
  const [contactMode, setContactMode] = useState<ContactModeKey>(DEFAULT_CONTACT_MODE)
  const isPaired = participant.connectionStatus === 'paired'
  const isOffline = !!participant.offline

  /**
   * Pair with this participant, this device initiating.
   *
   * The participant mints a contact in the selected mode and this device pairs
   * against it. That direction is the only one that can express a contact
   * mode at all — the mode is fixed when the contact is created, so whoever
   * creates it chooses. The other direction, where the actor initiates against
   * a contact pasted from this device, is behind "Let them initiate".
   */
  async function handlePair() {
    setIsPairing(true)
    setPairError(null)
    try {
      const contact = await createParticipantContact(contactMode)
      // The inline Pair button on a provisioned participant is the owner-side
      // shortcut: we protect, they help. Role selection lives in the Pair
      // modal for the cases where either direction makes sense.
      const channelId = await startParticipantPairing(contact, 'owner')
      onPairingRequestSent(channelId, participant.id)
    } catch (err) {
      setPairError(errorText(err))
    } finally {
      setIsPairing(false)
    }
  }

  return (
    <li className="side-participant-item">
      <button
        className="side-participant-header"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
      >
        <span className={`participant-dot ${isOffline ? 'offline' : participant.connectionStatus}`} aria-hidden="true" />
        <span className="side-participant-name">{participant.name}</span>
        {isOffline ? (
          <span className="status-tag offline">Offline</span>
        ) : unconfirmed ? (
          // Deliberately *not* "Paired": the handshake completed, but the
          // library holds the channel `Pending` — it takes no shares, is no
          // recovery source, and ignores anything sent on it. Showing "Paired"
          // here is how a NoKeys channel silently swallows a secret.
          <span className="status-tag available" title="Awaiting an out-of-band fingerprint confirmation">
            Unconfirmed
          </span>
        ) : (
          <span className={`status-tag ${participant.connectionStatus}`}>
            {connectionStatusLabel(participant.connectionStatus)}
          </span>
        )}
        <ChevronIcon expanded={expanded} />
      </button>

      {expanded && (
        <div className="side-participant-details">
          <div className="side-detail-row">
            <span className="side-detail-label">Channel ID</span>
            <span className="side-detail-value" title={participant.channelId}>{participant.channelId}</span>
          </div>
          {participant.sharedKey && (
            <SharedKeyRow value={participant.sharedKey} />
          )}
          <div className="side-detail-row">
            <span className="side-detail-label">Shares</span>
            <span className="side-detail-value">{participant.secretShares.length}</span>
          </div>
          {/* Mode is baked into the contact, so it has to be chosen before
              pairing starts — not after. Hidden once paired, when it no longer
              applies to anything. */}
          {!isPaired && !isOffline && (
            <ContactModeSelector
              value={contactMode}
              onChange={setContactMode}
              idPrefix={`participant-${participant.id}`}
              disabled={isPairing}
            />
          )}
          {pairError && <p className="field-error">{pairError}</p>}
          <div className="side-participant-actions">
            <button
              className="secondary side-action-btn"
              onClick={() => setShareContactOpen(true)}
            >
              Share Contact
            </button>
            {isPaired && !participant.browserManaged && participant.channelId && (
              <button
                className="pair-action-btn"
                onClick={() => setLinkOpen(true)}
                title={`Tell ${participant.name} that this channel belongs to an owner it already helps`}
              >
                Link
              </button>
            )}
            {/* A standing way back into the comparison after the modal has
                been dismissed — the channel is unusable until it is done. */}
            {unconfirmed && (
              <button className="pair-action-btn pair" onClick={onConfirmFingerprint}>
                Confirm fingerprint
              </button>
            )}
            {isPaired ? (
              <button className="pair-action-btn unpair" onClick={() => onTogglePair(participant.id)}>
                Unpair
              </button>
            ) : !isOffline ? (
              <>
                <button
                  className="pair-action-btn pair"
                  disabled={isPairing}
                  onClick={handlePair}
                >
                  {isPairing ? 'Pairing…' : 'Pair'}
                </button>
                {/* The other direction: the actor initiates against a contact
                    pasted from this device, so it declares its own role. Kept
                    separate because the contact — and therefore the mode — is
                    then this device's, not the participant's. */}
                {startPairingAsInitiator && (
                  <button
                    className="secondary side-action-btn"
                    disabled={isPairing}
                    onClick={() => setPairAsInitiatorOpen(true)}
                  >
                    Let them initiate
                  </button>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}

      {linkOpen && participant.channelId && (
        <ProvisionedLinkModal
          participantName={participant.name}
          myChannelId={participant.channelId}
          loadChannels={() => listChannels(participant.id)}
          onLink={linkTo => linkChannels(participant.id, participant.channelId, linkTo)}
          onClose={() => setLinkOpen(false)}
        />
      )}

      {shareContactOpen && (
        <ShareContactModal
          title={`Share ${participant.name} Contact`}
          transport={participant.transport}
          createContact={createParticipantContact}
          onClose={() => setShareContactOpen(false)}
        />
      )}

      {pairAsInitiatorOpen && startPairingAsInitiator && (
        <PairInitiatorModal
          label="Your Contact (QR Payload)"
          placeholder="Paste the JSON payload from your own Share Contact QR code"
          pairedChannelIds={pairedChannelIds}
          pairingRejectionCount={pairingRejectionCount}
          pairingCompletedSignal={pairingCompletedSignal}
          onClose={() => setPairAsInitiatorOpen(false)}
          onSuccess={() => setPairAsInitiatorOpen(false)}
          onPairingRequestSent={(channelId) => {
            setPairAsInitiatorOpen(false)
            onPairingRequestSent(channelId, participant.id)
          }}
          startPairing={startPairingAsInitiator}
          // The participant is the one scanning, so this picks *its* role;
          // we end up on the other side of the channel. Owner/Helper only —
          // this goes through the backend's `start-pairing` route.
          roleOptions={participantPairingRoleOptions(
            `${participant.name} protects a secret; you hold a share for them.`,
            `${participant.name} holds a share; you protect the secret.`,
          )}
          defaultRole="helper"
          initiatorLabel={`${participant.name}'s`}
        />
      )}
    </li>
  )
}

function AddParticipantModal({
  onAdd,
  onClose,
}: {
  onAdd: (name: string, autoPair: boolean) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(() => `${faker.person.firstName()} ${faker.person.lastName()}`)
  const [autoPair, setAutoPair] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await onAdd(name.trim(), autoPair)
    } catch (err) {
      setError(errorText(err))
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add participant">
      <div className="modal" style={{ maxWidth: 400 }}>
        <div className="modal-header">
          <h2 className="modal-title">Add Participant</h2>
          <ModalCloseButton onClose={onClose} />
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-field">
              <label className="form-label" htmlFor="add-participant-name">Name</label>
              <input
                id="add-participant-name"
                className="form-input"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                autoFocus
                disabled={submitting}
              />
            </div>
            <div className="form-field">
              <label className="participant-check-label">
                <input
                  type="checkbox"
                  className="participant-checkbox"
                  checked={autoPair}
                  onChange={e => setAutoPair(e.target.checked)}
                  disabled={submitting}
                />
                <span>Auto-pair after adding</span>
              </label>
            </div>
            {error && <p className="field-error">{error}</p>}
          </div>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" className="primary" disabled={!name.trim() || submitting}>
              {submitting ? 'Adding…' : 'Add Participant'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function OwnerParticipantPanel({
  participants,
  replicaSection,
  onTogglePair,
  onPairingRequestSent,
  listChannels,
  linkChannels,
  onAddParticipant,
  getParticipantFunctions,
  pairedChannelIds,
  pairingRejectionCount,
  pairingCompletedSignal,
  unconfirmedChannelIds,
  onConfirmFingerprint,
}: {
  participants: PairedParticipant[]
  /**
   * The provisioned-replica section, rendered directly below the participants.
   *
   * Injected rather than built here so this panel keeps knowing only about
   * participants, and the replica section keeps its own props typed on its own
   * terms.
   */
  replicaSection: React.ReactNode
  onTogglePair: (id: string) => void
  onPairingRequestSent: (channelId: bigint, actorId: string) => void
  onAddParticipant: (name: string, autoPair: boolean) => Promise<void>
  listChannels: (participantId: string) => Promise<ProvisionedChannel[]>
  linkChannels: (participantId: string, channelId: string, linkTo: string) => Promise<void>
  getParticipantFunctions: (participantId: string) => {
    createContact: (mode: ContactModeKey) => Promise<ContactMessage>
    startPairing: (contact: ContactMessage, role: PairingRole) => Promise<bigint>
    /** Participant-only — see the field of the same name above. */
    startPairingAsInitiator?: (ownerContact: ContactMessage, role: 'owner' | 'helper') => Promise<bigint>
  }
  pairedChannelIds: Set<string>
  pairingRejectionCount: number
  pairingCompletedSignal: number
  /**
   * Channels whose handshake completed but which the library still holds
   * `Pending`, awaiting an out-of-band fingerprint. Only `NoKeys` pairings
   * land here.
   */
  unconfirmedChannelIds: ReadonlySet<string>
  /** Reopen the fingerprint comparison for a channel. */
  onConfirmFingerprint: (channelId: string) => void
}) {
  const [addParticipantOpen, setAddParticipantOpen] = useState(false)

  return (
    <aside className="side-panel" aria-label="Actors">
      {/* ── Participants section ─────────────────────────────────────────── */}
      <div className="side-panel-section">
        <div className="panel-header-row">
          <div>
            <h3 className="panel-heading">Pair with a participant</h3>
            <p className="panel-subtitle">
              {participants.length} on this node — provision and manage them in
              Participants
            </p>
          </div>
        </div>
        <ul className="side-participant-list" role="list">
          {participants.map(h => {
            const { createContact, startPairing, startPairingAsInitiator } = getParticipantFunctions(h.id)
            return (
              <SidePanelParticipantItem
                key={h.id}
                participant={h}
                onTogglePair={onTogglePair}
                onPairingRequestSent={onPairingRequestSent}
                createParticipantContact={createContact}
                listChannels={listChannels}
                linkChannels={linkChannels}
                startParticipantPairing={startPairing}
                startPairingAsInitiator={startPairingAsInitiator}
                pairedChannelIds={pairedChannelIds}
                pairingRejectionCount={pairingRejectionCount}
                pairingCompletedSignal={pairingCompletedSignal}
                unconfirmed={!!h.channelId && unconfirmedChannelIds.has(h.channelId)}
                onConfirmFingerprint={() => h.channelId && onConfirmFingerprint(h.channelId)}
              />
            )
          })}
        </ul>
      </div>

      {/* ── Replicas section ──────────────────────────────────────────────── */}
      {replicaSection}

      {addParticipantOpen && (
        <AddParticipantModal
          onAdd={async (name, autoPair) => {
            await onAddParticipant(name, autoPair)
            setAddParticipantOpen(false)
          }}
          onClose={() => setAddParticipantOpen(false)}
        />
      )}
    </aside>
  )
}
