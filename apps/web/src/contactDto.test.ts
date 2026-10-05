// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'
import type { ContactMessage } from '@derec-alliance/web'
import type { ContactMessageDto } from './api'
import { contactMessageToDto, dtoToContactMessage } from './contactDto'

const HTTPS = { uri: 'https://a.example/derec/1', protocol: 0 }
const GRPC = { uri: 'grpcs://a.example:443', protocol: 1 }

function contact(overrides: Partial<ContactMessage> = {}): ContactMessage {
  return {
    channel_id: 18446744073709551615n,
    nonce: 7n,
    supported_transports: [HTTPS],
    contact_mode: 0,
    ...overrides,
  } as ContactMessage
}

function dto(overrides: Partial<ContactMessageDto> = {}): ContactMessageDto {
  return {
    channel_id: '18446744073709551615',
    nonce: '7',
    transport_protocol: { uri: HTTPS.uri, protocol: 'https' },
    supported_transports: [{ uri: HTTPS.uri, protocol: 'https' }],
    contact_mode: 0,
    ...overrides,
  }
}

describe('contactMessageToDto', () => {
  it('carries every advertised endpoint, protocol as a name', () => {
    const result = contactMessageToDto(contact({ supported_transports: [HTTPS, GRPC] }))

    expect(result.supported_transports).toEqual([
      { uri: HTTPS.uri, protocol: 'https' },
      { uri: GRPC.uri, protocol: 'grpc' },
    ])
  })

  it('no longer writes the singular endpoint the SDK removed', () => {
    const result = contactMessageToDto(contact({ supported_transports: [GRPC, HTTPS] }))

    expect(result.transport_protocol).toBeUndefined()
  })

  it('keeps u64 ids as decimal strings', () => {
    // Above Number.MAX_SAFE_INTEGER — a number here would round silently.
    expect(contactMessageToDto(contact()).channel_id).toBe('18446744073709551615')
  })
})

describe('dtoToContactMessage', () => {
  it('reads the endpoint list back into discriminants', () => {
    const result = dtoToContactMessage(
      dto({
        supported_transports: [
          { uri: HTTPS.uri, protocol: 'https' },
          { uri: GRPC.uri, protocol: 'grpc' },
        ],
      }),
    )

    expect(result.supported_transports).toEqual([HTTPS, GRPC])
  })

  it('falls back to the singular field in a payload from an older build', () => {
    const legacy = dto()
    delete legacy.supported_transports

    const result = dtoToContactMessage(legacy)

    expect(result.supported_transports).toEqual([HTTPS])
  })

  it('reads an unrecognised protocol name as HTTPS, as protobuf does', () => {
    const result = dtoToContactMessage(
      dto({ supported_transports: [{ uri: 'ws://a.example', protocol: 'websocket' }] }),
    )

    expect(result.supported_transports).toEqual([{ uri: 'ws://a.example', protocol: 0 }])
  })

  it('round-trips a multi-endpoint contact unchanged', () => {
    const original = contact({ supported_transports: [HTTPS, GRPC] })

    const result = dtoToContactMessage(contactMessageToDto(original))

    expect(result.channel_id).toBe(original.channel_id)
    expect(result.supported_transports).toEqual([HTTPS, GRPC])
  })
})
