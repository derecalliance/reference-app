// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const decodeContact = vi.fn()
const encodeContact = vi.fn()

vi.mock('@derec-alliance/web', async importOriginal => ({
  ...(await importOriginal<typeof import('@derec-alliance/web')>()),
  primitives: {
    pairing: { request: { decode_contact: decodeContact, encode_contact: encodeContact } },
  },
}))

const { contactToHex, deserializeContact, detectContactEncoding } = await import('./contact')

const BYTES = new Uint8Array([0x08, 0x2a, 0x10, 0xff, 0xfb])
const DECODED = { channel_id: 42n, nonce: 7n, contact_mode: 0, supported_transports: [] }

beforeEach(() => {
  decodeContact.mockReset().mockReturnValue(DECODED)
  encodeContact.mockReset().mockReturnValue(BYTES)
})

describe('detectContactEncoding', () => {
  it.each([
    ['{"channel_id":"1"}', 'json'],
    ['  {"channel_id":"1"}  ', 'json'],
    ['082a10fffb', 'hex'],
    ['0x082A10FFFB', 'hex'],
    ['08 2a 10\nff fb', 'hex'],
    ['CCoQ//s=', 'base64'],
    ['CCoQ__s', 'base64'],
    ['CCoQ\n//s=', 'base64'],
  ] as const)('reads %j as %s', (text, encoding) => {
    expect(detectContactEncoding(text)).toBe(encoding)
  })

  it.each(['', '   ', 'not a contact!', '082a1', 'x'])('recognises nothing in %j', text => {
    expect(detectContactEncoding(text)).toBeNull()
  })
})

describe('deserializeContact', () => {
  it('reads the JSON payload without the SDK decoder', () => {
    const contact = deserializeContact('{"channel_id":"9","nonce":"3","transport_protocol":{"uri":"http://h/derec/a","protocol":"https"}}')

    expect(contact.channel_id).toBe(9n)
    expect(decodeContact).not.toHaveBeenCalled()
  })

  it('hands hex bytes to the SDK decoder', () => {
    expect(deserializeContact('0x08 2a 10 ff fb')).toBe(DECODED)
    expect(decodeContact).toHaveBeenCalledWith(BYTES)
  })

  it('hands base64 bytes, standard or URL-safe, to the SDK decoder', () => {
    deserializeContact('CCoQ//s=')
    deserializeContact('CCoQ__s')

    expect(decodeContact).toHaveBeenNthCalledWith(1, BYTES)
    expect(decodeContact).toHaveBeenNthCalledWith(2, BYTES)
  })

  it('says how it read bytes the SDK refuses', () => {
    decodeContact.mockImplementation(() => {
      throw { category: 'decode', code: 'decode_error', message: 'not a ContactMessage' }
    })

    expect(() => deserializeContact('082a10fffb')).toThrow(
      'Not a valid contact (read as hex protobuf bytes): not a ContactMessage',
    )
  })

  it('names the accepted forms for text that is none of them', () => {
    expect(() => deserializeContact('hello, there!')).toThrow(/JSON payload .* hex or base64/)
  })
})

describe('contactToHex', () => {
  it('is the SDK’s encoding of the contact, as hex', () => {
    expect(contactToHex(DECODED as never)).toBe('082a10fffb')
    expect(encodeContact).toHaveBeenCalledWith(DECODED)
  })
})
