import { useState, useEffect, useRef } from 'react'
import { DeRecProtocol, SenderKind, type ContactMessage } from '@derec-alliance/web'
import type { ParticipantSession } from './types'
import { useConsole } from './ConsoleContext'
import { sendMessage, pollMailbox, toBase64Url, fromBase64Url } from './derecApi'
import { makeChannelStore, makeSecretStore, makeShareStore, makeTransport } from './stores'
import { apiPostBrowserContact, type ContactMessageDto } from './api'
import './ParticipantSessionPage.css'

// ── Contact serialization ────────────────────────────────────────────────────

function contactMessageToDto(c: ContactMessage): ContactMessageDto {
  return {
    channel_id: c.channel_id,
    nonce: c.nonce,
    transport_protocol: c.transport_protocol,
    mlkem_encapsulation_key: toBase64Url(c.mlkem_encapsulation_key),
    ecies_public_key: toBase64Url(c.ecies_public_key),
  }
}

// ── Component ────────────────────────────────────────────────────────────────

interface Props {
  session: ParticipantSession
  onUpdate: (session: ParticipantSession) => void
}

export default function ParticipantSessionPage({ session, onUpdate }: Props) {
  const { log } = useConsole()
  const protocolRef = useRef<DeRecProtocol | null>(null)
  const sessionRef = useRef(session)
  const onUpdateRef = useRef(onUpdate)

  useEffect(() => { sessionRef.current = session }, [session])
  useEffect(() => { onUpdateRef.current = onUpdate }, [onUpdate])

  const [eventLog, setEventLog] = useState<Array<{ time: string; type: string; detail?: string }>>([])

  function addEvent(type: string, detail?: string) {
    const time = new Date().toLocaleTimeString()
    setEventLog(prev => [{ time, type, detail }, ...prev].slice(0, 50))
  }

  // ── Initialize WASM protocol and post contact ─────────────────────────────

  useEffect(() => {
    const { sessionId, participantId, transport } = session

    // Participants don't initiate sharing, so threshold and keep_versions_count
    // are set to sensible defaults. The secretId is a fresh random value (unused
    // in practice — participants only store incoming shares).
    const secretId = crypto.getRandomValues(new Uint8Array(16))
    const protocol = new DeRecProtocol(
      makeChannelStore(`participant:${participantId}`),
      makeShareStore(`participant:${participantId}`),
      makeSecretStore(`participant:${participantId}`),
      makeTransport(sendMessage),
      transport.uri,
      'https',
      2,          // threshold (unused by participant)
      3,          // keep_versions_count
      secretId,
      { name: session.participantName },  // communication_info
    )
    protocolRef.current = protocol

    log({
      role: 'participant',
      flow: 'session',
      step: 'protocol_init',
      description: `Participant protocol initialized for session ${sessionId}`,
      payload: { sessionId, participantId },
    })

    // Create a contact message and post it to the signaling endpoint so the
    // owner can discover and initiate pairing.
    async function postContact() {
      try {
        const contact: ContactMessage = await protocol.createContact(null)
        const dto = contactMessageToDto(contact)
        await apiPostBrowserContact(sessionId, participantId, JSON.stringify(dto))
        addEvent('ContactPosted', 'Contact published for owner discovery')
        log({
          role: 'participant',
          flow: 'pairing',
          step: 'contact_posted',
          description: 'Browser contact posted for owner discovery',
          payload: { channelId: dto.channel_id },
        })
      } catch (err) {
        console.error('[participant] failed to post contact:', err)
        addEvent('Error', `Failed to post contact: ${err}`)
      }
    }
    postContact()

    return () => { protocolRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId, session.participantId])

  // ── Mailbox polling ───────────────────────────────────────────────────────

  useEffect(() => {
    let running = false
    const id = setInterval(async () => {
      if (running) return
      running = true
      try {
        const { sessionId, participantId } = sessionRef.current
        const protocol = protocolRef.current
        if (!protocol) return

        let messages
        try {
          messages = await pollMailbox(sessionId, 'participants', participantId)
        } catch (err) {
          console.error('[participant-poll] failed to fetch messages:', err)
          return
        }

        if (messages.length === 0) return

        let updated = sessionRef.current

        for (const { bytes } of messages) {
          let events: Array<{ type: string; channel_id?: string; [k: string]: unknown }>
          try {
            events = Array.from(await protocol.process(bytes)) as typeof events
          } catch (err) {
            console.error('[participant-poll] process() failed:', err)
            continue
          }

          for (const event of events) {
            console.log('[participant-poll] event:', event.type, event)
            addEvent(event.type, event.channel_id ? `channel=${event.channel_id}` : undefined)

            if (event.type === 'PairingCompleted' && event.channel_id) {
              updated = {
                ...updated,
                channelId: String(event.channel_id),
                connectionStatus: 'paired',
              }

              log({
                role: 'participant',
                flow: 'pairing',
                step: 'pairing_complete',
                description: `Paired with owner on channel ${event.channel_id}`,
                payload: { channelId: String(event.channel_id) },
              })
            }
          }
        }

        if (updated !== sessionRef.current) {
          onUpdateRef.current(updated)
        }
      } finally {
        running = false
      }
    }, 1000)

    return () => clearInterval(id)
  }, [session.sessionId, session.participantId])

  const isPaired = session.connectionStatus === 'paired'

  return (
    <div className="participant-session-page">
      <div className="participant-session-header">
        <div className="participant-session-identity">
          <h1 className="participant-session-name">{session.participantName}</h1>
          <span className="participant-session-role">Participant</span>
        </div>
        <div className="participant-session-meta">
          <div className="meta-row">
            <span className="meta-label">Session</span>
            <code className="meta-value">{session.sessionId}</code>
          </div>
          <div className="meta-row">
            <span className="meta-label">Owner</span>
            <span className="meta-value">{session.ownerName}</span>
          </div>
          <div className="meta-row">
            <span className="meta-label">Status</span>
            <span className={`status-tag ${isPaired ? 'paired' : 'available'}`}>
              {isPaired ? 'Paired' : 'Waiting for owner to pair'}
            </span>
          </div>
          {isPaired && (
            <div className="meta-row">
              <span className="meta-label">Channel</span>
              <code className="meta-value">{session.channelId}</code>
            </div>
          )}
        </div>
      </div>

      {session.actors && session.actors.length > 0 && (
        <div className="participant-actors-list">
          <h3 className="panel-heading">Session Participants</h3>
          <ul className="actors-list">
            {session.actors.map(a => (
              <li key={a.id} className="actor-item">
                <span className="actor-name">{a.name}</span>
                <span className={`actor-role ${a.role}`}>{a.role}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="participant-event-log">
        <h3 className="panel-heading">Protocol Events</h3>
        {eventLog.length === 0 ? (
          <p className="empty-hint">No events yet. Waiting for owner interaction.</p>
        ) : (
          <ul className="event-log-list">
            {eventLog.map((e, i) => (
              <li key={i} className="event-log-item">
                <span className="event-log-time">{e.time}</span>
                <span className="event-log-type">{e.type}</span>
                {e.detail && <span className="event-log-detail">{e.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
