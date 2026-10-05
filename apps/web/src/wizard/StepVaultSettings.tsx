// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { InfoTooltip } from '../InfoTooltip'
import {
  MIN_WIZARD_TIMEOUT_SECS,
  TIMEOUT_STEP_SECS,
  prePairTarget,
  type OwnerSettings,
} from './wizardForm'

/**
 * What the wizard knows about the node it is setting up against.
 *
 * `checking` until the probe lands. Nothing on this step is editable before
 * then: both values start from the node's defaults, and a stepper moved against
 * the built-in fallback — or a pre-pair ceiling of "unknown, so 0" — would show
 * one number while setup used another.
 */
export type NodeCheck =
  | { status: 'checking' }
  /** `online`: participants switched on, or `null` if the pool could not be read. */
  | { status: 'ready'; online: number | null }

export interface StepVaultSettingsProps {
  settings: OwnerSettings
  node: NodeCheck
  onChangeProtocolTimeoutSecs: (secs: number) => void
  onChangePrePairedCount: (count: number) => void
}

/**
 * The settings that belong to this owner rather than to the node.
 *
 * Pool size, transport mix and protocol policy moved to Settings: an operator
 * decides those once for the node, and a real app would not put them in front
 * of someone creating an account. What is left is what genuinely varies per
 * owner — a timeout a service might enforce or a self-custody app might let the
 * user pick, and how many participants to pre-pair.
 *
 * Both start from the node's defaults, with any Settings override on top, and
 * can be changed here — so two owners on the same node can differ, which is the
 * point: one set up with two pre-paired participants and another with three.
 */
export function StepVaultSettings({
  settings,
  node,
  onChangeProtocolTimeoutSecs,
  onChangePrePairedCount,
}: StepVaultSettingsProps) {
  const checking = node.status === 'checking'
  // The hard ceiling on pre-pairing. Setup provisions nothing, so asking for
  // more than is online would auto-pair against peers that do not exist or
  // cannot answer — the owner would sit at "0 of N paired" for good. A pool
  // that could not be read offers nothing rather than a ceiling that may not
  // hold.
  const ceiling = node.status === 'ready' ? node.online ?? 0 : 0
  const prePaired = prePairTarget(settings.prePairedCount, ceiling)
  const timeout = settings.protocolTimeoutSecs

  return (
    <div className="wizard-step" aria-busy={checking}>
      <h2>Your settings</h2>
      <p>
        These belong to this owner. Pool size and protocol policy are set for
        the whole node, under Settings.
      </p>

      <div className="participant-count-section">
        <span className="participant-count-section-label">
          Protocol timeout (seconds)
          <InfoTooltip label="About protocol timeout">
            The single timeout used everywhere. The protocol uses it passively
            to ignore expired messages; the app uses it as the active deadline —
            if a peer doesn't respond within this window the operation fails and
            the UI recovers. Lower = snappier failures; higher = more tolerant
            of slow peers.
          </InfoTooltip>
        </span>
        <div className="participant-count-input">
          <button
            className="stepper"
            onClick={() =>
              onChangeProtocolTimeoutSecs(
                Math.max(MIN_WIZARD_TIMEOUT_SECS, timeout - TIMEOUT_STEP_SECS),
              )
            }
            disabled={checking || timeout <= MIN_WIZARD_TIMEOUT_SECS}
            aria-label="Decrease protocol timeout"
          >
            −
          </button>
          <span className="count">{checking ? '…' : timeout}</span>
          <button
            className="stepper"
            onClick={() => onChangeProtocolTimeoutSecs(timeout + TIMEOUT_STEP_SECS)}
            disabled={checking}
            aria-label="Increase protocol timeout"
          >
            +
          </button>
        </div>
      </div>

      <div className="participant-count-section">
        <span className="participant-count-section-label">
          Pre-pair locally
          <span className="participant-count-section-hint" aria-live="polite">
            {prePairHint(node, ceiling)}
          </span>
        </span>
        <div className="participant-count-input">
          <button
            className="stepper"
            onClick={() => onChangePrePairedCount(Math.max(0, prePaired - 1))}
            disabled={checking || prePaired <= 0}
            aria-label="Decrease pre-paired participants"
          >
            −
          </button>
          {/* The same number setup will use — see `prePairTarget`. */}
          <span className="count">{checking ? '…' : prePaired}</span>
          <button
            className="stepper"
            onClick={() => onChangePrePairedCount(Math.min(ceiling, prePaired + 1))}
            disabled={checking || prePaired >= ceiling}
            aria-label="Increase pre-paired participants"
          >
            +
          </button>
        </div>
      </div>
    </div>
  )
}

function prePairHint(node: NodeCheck, ceiling: number): string {
  if (node.status === 'checking') return 'Testing only — skips QR exchange. Checking the node…'
  if (node.online === null) {
    return 'Could not read the participant pool, so pre-pairing is off. Pair from the owner page instead.'
  }
  if (ceiling === 0) {
    return 'No participants are online on this node — provision some under Participants.'
  }
  return `Testing only — skips QR exchange. Up to ${ceiling} online.`
}
