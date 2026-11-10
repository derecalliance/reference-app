// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { primitives, type ContactMessage } from '@derec-alliance/web'

import type { ContactMessageDto } from '../api'
import { bytesToHex } from '../bytes'
import { contactMessageToDto, dtoToContactMessage } from '../contactDto'
import { fromBase64Url } from '../derecApi'
import { errorText } from '../errorText'

/** How a pasted contact was written, as far as the paste field can tell. */
export type ContactEncoding = 'json' | 'hex' | 'base64'

/** Said when a paste is none of the accepted forms. */
const UNRECOGNISED =
  'Not a contact. Paste the JSON payload from a Share Contact QR code, or the contact’s ' +
  'raw protobuf bytes as hex or base64.'

/** QR/clipboard payload — same wire form as the signaling DTO. */
export function serializeContact(contact: ContactMessage): string {
  return JSON.stringify(contactMessageToDto(contact))
}

/**
 * The contact's protobuf wire bytes as lower-case hex — the form another
 * implementation exchanges out of band, and one `deserializeContact` reads back.
 */
export function contactToHex(contact: ContactMessage): string {
  return bytesToHex(primitives.pairing.request.encode_contact(contact))
}

/**
 * Read a pasted or scanned contact, in any form the paste field accepts: the
 * app's JSON payload, or the raw protobuf `ContactMessage` bytes as hex or
 * base64 (standard or URL-safe) — what `POST /api/v1/actors/{id}/contact`
 * answers with `Accept: application/octet-stream`, once encoded as text.
 *
 * Bytes are decoded by the SDK, so a contact that breaks its mode's
 * invariants is refused here exactly as it would be at pairing.
 */
export function deserializeContact(payload: string): ContactMessage {
  const text = payload.trim()
  const encoding = detectContactEncoding(text)
  if (encoding === 'json') return dtoToContactMessage(JSON.parse(text) as ContactMessageDto)
  if (encoding === null) throw new Error(UNRECOGNISED)

  const bytes = encoding === 'hex' ? hexToBytes(text) : fromBase64Url(compact(text))
  try {
    return primitives.pairing.request.decode_contact(bytes)
  } catch (err) {
    throw new Error(`Not a valid contact (read as ${encoding} protobuf bytes): ${errorText(err)}`, {
      cause: err,
    })
  }
}

/**
 * Which form `text` is in, or `null` when it is none of them.
 *
 * Hex is tried before base64 because every hex string is also valid base64
 * text; a contact is over a kilobyte, so a real base64 contact is never
 * all-hex by accident.
 */
export function detectContactEncoding(text: string): ContactEncoding | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return 'json'
  const body = compact(trimmed)
  if (body.length === 0) return null
  const hex = body.replace(/^0x/i, '')
  if (hex.length % 2 === 0 && /^[0-9a-f]+$/i.test(hex)) return 'hex'
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(body) && body.length % 4 !== 1) return 'base64'
  return null
}

/** Hex with optional `0x` and any whitespace, as bytes. */
function hexToBytes(text: string): Uint8Array {
  const hex = compact(text).replace(/^0x/i, '')
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/** Line breaks and spaces that a terminal or an editor wrapped into a paste. */
function compact(text: string): string {
  return text.replace(/\s+/g, '')
}
