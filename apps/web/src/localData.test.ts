// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { beforeEach, describe, expect, it } from 'vitest'
import { clearAllLocalData, countLocalDataEntries, eraseVaultLocalData } from './localData'

describe('localData', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('counts only derec-prefixed entries', () => {
    localStorage.setItem('derec:a', '1')
    localStorage.setItem('derec:b', '2')
    localStorage.setItem('other', '3')

    expect(countLocalDataEntries()).toBe(2)
  })

  it('clears derec entries and leaves foreign keys intact', () => {
    localStorage.setItem('derec:a', '1')
    localStorage.setItem('other', '3')

    expect(clearAllLocalData()).toBe(1)
    expect(countLocalDataEntries()).toBe(0)
    expect(localStorage.getItem('other')).toBe('3')
  })
})

describe('localData — browser-wide preferences', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('sweeps the dot-prefixed preferences too, so a reset really starts from scratch', () => {
    localStorage.setItem('derec.protocolDefaults', '{"minParticipants":2}')
    localStorage.setItem('derec.section', 'settings')

    expect(clearAllLocalData()).toBe(2)
    expect(localStorage.getItem('derec.protocolDefaults')).toBeNull()
    expect(localStorage.getItem('derec.section')).toBeNull()
  })

  it('leaves the cross-tab coordination keys to the tabs still using them', () => {
    localStorage.setItem('derec-lock:derec:vault-lock:v1', '{}')

    expect(clearAllLocalData()).toBe(0)
    expect(localStorage.getItem('derec-lock:derec:vault-lock:v1')).toBe('{}')
  })
})

describe('eraseVaultLocalData', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('removes the vault’s stores and the records kept beside them, replica id and adoption block included', () => {
    localStorage.setItem('derec:vault:v1:42:channel:helper:7', 'x')
    localStorage.setItem('derec:replica-adoption-block:v1', '{}')
    localStorage.setItem('derec:replica-adoption-block:v2', '{}')
    localStorage.setItem('derec:replica-state:v1', '{}')
    localStorage.setItem('derec:replica-offer:v1', '{}')
    localStorage.setItem('derec:replica-id:v1', '123')
    // Another vault's identity is not this vault's to erase.
    localStorage.setItem('derec:replica-id:v2', '456')

    eraseVaultLocalData('v1')

    expect(localStorage.getItem('derec:vault:v1:42:channel:helper:7')).toBeNull()
    expect(localStorage.getItem('derec:replica-state:v1')).toBeNull()
    expect(localStorage.getItem('derec:replica-offer:v1')).toBeNull()
    expect(localStorage.getItem('derec:replica-id:v1')).toBeNull()
    expect(localStorage.getItem('derec:replica-id:v2')).toBe('456')
    expect(localStorage.getItem('derec:replica-adoption-block:v1')).toBeNull()
    expect(localStorage.getItem('derec:replica-adoption-block:v2')).toBe('{}')
  })
})
