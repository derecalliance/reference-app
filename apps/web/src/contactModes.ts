import { ContactMode } from '@derec-alliance/web'

/**
 * How a contact delivers the initiator's public encryption material.
 *
 * The three modes differ in what the out-of-band contact commits to, and that
 * difference decides whether the resulting channel is usable straight away:
 *
 * - `InlineKeys` — keys are in the contact. Usable immediately.
 * - `HashedKeys` — the contact carries a SHA-384 commitment; the scanner
 *   fetches the real keys over `PrePair` and checks them against it. A
 *   mismatch aborts the handshake. Usable immediately.
 * - `NoKeys` — the contact carries neither keys nor a commitment, only
 *   `channel_id`, `nonce` and the endpoint, so it is small enough to dictate
 *   or hand-type. Nothing binds the keys the scanner receives to the contact
 *   that was delivered, so the channel stays `Pending` until both sides
 *   confirm a fingerprint out of band.
 */
export type ContactModeKey = 'inline_keys' | 'hashed_keys' | 'no_keys'

export const DEFAULT_CONTACT_MODE: ContactModeKey = 'inline_keys'

export interface ContactModeOption {
  key: ContactModeKey
  label: string
  /**
   * One-line explanation, surfaced on hover rather than beside the control.
   *
   * Carries the consequence, not just the mechanism — `no_keys` says the
   * fingerprint is required, because that is the part that changes what the
   * user has to do next.
   */
  hint: string
}

export const CONTACT_MODE_OPTIONS: readonly ContactModeOption[] = [
  {
    key: 'inline_keys',
    label: 'Inline keys',
    hint: 'Keys travel in the contact. Pairs immediately.',
  },
  {
    key: 'hashed_keys',
    label: 'Hashed keys',
    hint: 'Contact carries a hash; keys are fetched and verified against it.',
  },
  {
    key: 'no_keys',
    label: 'No keys',
    hint: 'Short enough to dictate. Both sides must confirm a fingerprint before use.',
  },
]

const BY_KEY = new Map(CONTACT_MODE_OPTIONS.map(o => [o.key, o]))

export function contactModeOption(key: ContactModeKey): ContactModeOption {
  const option = BY_KEY.get(key)
  if (!option) throw new Error(`unknown contact mode: ${key}`)
  return option
}

/** The library's numeric enum value for a mode. */
export function toContactMode(key: ContactModeKey): ContactMode {
  switch (key) {
    case 'inline_keys':
      return ContactMode.InlineKeys
    case 'hashed_keys':
      return ContactMode.HashedKeys
    case 'no_keys':
      return ContactMode.NoKeys
  }
}

export function normalizeContactMode(value: string | undefined | null): ContactModeKey {
  return value === 'hashed_keys' || value === 'no_keys' || value === 'inline_keys'
    ? value
    : DEFAULT_CONTACT_MODE
}

/**
 * A short, human-typable nonce for a `NoKeys` contact.
 *
 * The library would mint a random `u64`, but the whole point of `NoKeys` is a
 * contact someone can read aloud, so a six-digit value is generated here
 * instead. It is not a secret — it only has to be unique enough to keep two
 * concurrent contacts apart.
 */
export function humanNonce(): bigint {
  return BigInt(100_000 + Math.floor(Math.random() * 900_000))
}
