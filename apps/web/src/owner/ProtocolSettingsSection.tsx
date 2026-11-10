// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { ReactNode } from 'react'

import { MAX_PROTOCOL_TIMEOUT_SECS, MIN_PROTOCOL_TIMEOUT_SECS, type AuthenticationMethod, type UnpairAck } from '../config'
import { SECRET_CONFIG_DEFAULTS } from '../protocolDefaults'
import type { SecretConfig } from '../types'
import type { SecretSettingsDraft, SecretSettingsProblems } from './secretSettingsDraft'

interface ProtocolSettingsSectionProps {
  draft: SecretSettingsDraft
  problems: SecretSettingsProblems
  onChange: (change: Partial<SecretSettingsDraft>) => void
}

type AutoAcceptKey = 'autoAcceptUnpairRequests' | 'autoAcceptStoreShareRequests' | 'autoAcceptVerifyShareRequests'

/** The incoming requests a secret can answer on its own, as the tab lists them. */
const AUTO_ACCEPT_FIELDS: readonly { key: AutoAcceptKey; id: string; label: string }[] = [
  { key: 'autoAcceptUnpairRequests', id: 'ss-auto-unpair', label: 'Incoming unpair requests' },
  { key: 'autoAcceptStoreShareRequests', id: 'ss-auto-store', label: 'Incoming share storage requests' },
  { key: 'autoAcceptVerifyShareRequests', id: 'ss-auto-verify', label: 'Incoming verification requests' },
]

/** An option's text, marked when it is the app's default for that setting. */
function optionText<K extends keyof SecretConfig>(key: K, value: SecretConfig[K], text: string): string {
  return SECRET_CONFIG_DEFAULTS[key] === value ? `${text} (default)` : text
}

/** A labelled control in the protocol grid, with its hint or error below. */
function Field({ id, label, hint, error, children }: {
  id: string
  label: string
  hint: string
  error?: string
  children: ReactNode
}) {
  return (
    <div className="form-field">
      <label className="form-label" htmlFor={id}>{label}</label>
      {children}
      {error ? <p className="field-error">{error}</p> : <p className="empty-hint">{hint}</p>}
    </div>
  )
}

/**
 * How this secret runs the protocol: its timeout, the unpair acknowledgement
 * policy, which incoming requests it answers without asking, and how it links
 * channels to one person. Each secret holds its own, starting from the app's
 * defaults; the default option of each is marked.
 */
export function ProtocolSettingsSection({ draft, problems, onChange }: ProtocolSettingsSectionProps) {
  const { protocol } = draft
  const setProtocol = (change: Partial<SecretConfig>) => onChange({ protocol: { ...protocol, ...change } })

  return (
    <div className="settings-grid">
      <Field
        id="ss-timeout"
        label="Protocol timeout (s)"
        hint={`How long a flow waits for a peer, and how old an inbound message may be. Default ${SECRET_CONFIG_DEFAULTS.protocolTimeoutSecs}s.`}
        error={problems.timeout}
      >
        <input
          id="ss-timeout"
          className="full-input settings-number-input"
          type="number"
          inputMode="numeric"
          min={MIN_PROTOCOL_TIMEOUT_SECS}
          max={MAX_PROTOCOL_TIMEOUT_SECS}
          step={1}
          value={draft.timeoutText}
          onChange={e => onChange({ timeoutText: e.target.value })}
          aria-invalid={problems.timeout !== undefined}
        />
      </Field>

      <Field
        id="ss-unpair-ack"
        label="Unpair acknowledgement"
        hint="Whether an unpair this secret starts waits for the peer’s answer before it is done."
      >
        <select
          id="ss-unpair-ack"
          className="full-input settings-select"
          value={protocol.unpairAck}
          onChange={e => setProtocol({ unpairAck: e.target.value as UnpairAck })}
        >
          <option value="required">{optionText('unpairAck', 'required', 'Required')}</option>
          <option value="not_required">{optionText('unpairAck', 'not_required', 'Not required')}</option>
        </select>
      </Field>

      {AUTO_ACCEPT_FIELDS.map(({ key, id, label }) => (
        <Field key={key} id={id} label={label} hint="Answered at once, or shown to you to accept or refuse.">
          <select
            id={id}
            className="full-input settings-select"
            value={protocol[key] ? 'auto' : 'prompt'}
            onChange={e => setProtocol({ [key]: e.target.value === 'auto' })}
          >
            <option value="auto">{optionText(key, true, 'Accept automatically')}</option>
            <option value="prompt">{optionText(key, false, 'Ask me')}</option>
          </select>
        </Field>
      ))}

      <Field
        id="ss-auth-method"
        label="Authentication method"
        hint="How this secret decides that two channels belong to the same person."
      >
        <select
          id="ss-auth-method"
          className="full-input settings-select"
          value={protocol.authenticationMethod}
          onChange={e => setProtocol({ authenticationMethod: e.target.value as AuthenticationMethod })}
        >
          <option value="user">{optionText('authenticationMethod', 'user', 'You link them')}</option>
          <option value="application" disabled>
            By the application (not yet enabled)
          </option>
        </select>
      </Field>
    </div>
  )
}
