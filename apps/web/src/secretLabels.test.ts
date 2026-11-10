// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import { distinctSecretLabels, isDuplicateSecretName } from './secretLabels'

describe('distinctSecretLabels', () => {
  it('leaves unique names alone and suffixes namesakes with their id', () => {
    const labels = distinctSecretLabels([
      { id: 'aaaaaaaa-1111', name: 'Alice' },
      { id: 'bbbbbbbb-2222', name: 'alice ' },
      { id: 'cccccccc-3333', name: 'Bob' },
    ])

    expect(labels.get('aaaaaaaa-1111')).toBe('Alice · aaaaaaaa')
    expect(labels.get('bbbbbbbb-2222')).toBe('alice · bbbbbbbb')
    expect(labels.get('cccccccc-3333')).toBe('Bob')
  })
})

describe('isDuplicateSecretName', () => {
  it('matches regardless of case, surrounding space and Unicode form', () => {
    expect(isDuplicateSecretName(' ALICE', ['Alice'])).toBe(true)
    expect(isDuplicateSecretName('José', ['José'])).toBe(true)
    expect(isDuplicateSecretName('Bob', ['Alice'])).toBe(false)
    expect(isDuplicateSecretName('  ', ['  '])).toBe(false)
  })
})
