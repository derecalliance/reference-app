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
    transport_protocol: HTTPS,
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

  it('mirrors the first entry into the deprecated singular field', () => {
    // A DTO whose singular field disagreed with the list would hand a
    // pre-0.0.3 reader a different endpoint than a current one.
    const result = contactMessageToDto(
      contact({ transport_protocol: undefined, supported_transports: [GRPC, HTTPS] }),
    )

    expect(result.transport_protocol).toEqual({ uri: GRPC.uri, protocol: 'grpc' })
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
    expect(result.transport_protocol).toEqual(HTTPS)
  })

  it('falls back to the singular field for a peer predating the list', () => {
    const legacy = dto()
    delete legacy.supported_transports

    const result = dtoToContactMessage(legacy)

    expect(result.supported_transports).toEqual([HTTPS])
    expect(result.transport_protocol).toEqual(HTTPS)
  })

  it('reads an unrecognised protocol name as HTTPS, as protobuf does', () => {
    const result = dtoToContactMessage(
      dto({ supported_transports: [{ uri: 'ws://a.example', protocol: 'websocket' }] }),
    )

    expect(result.supported_transports).toEqual([{ uri: 'ws://a.example', protocol: 0 }])
  })

  it('round-trips a multi-endpoint contact unchanged', () => {
    const original = contact({ transport_protocol: HTTPS, supported_transports: [HTTPS, GRPC] })

    const result = dtoToContactMessage(contactMessageToDto(original))

    expect(result.channel_id).toBe(original.channel_id)
    expect(result.supported_transports).toEqual([HTTPS, GRPC])
  })
})
