// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import { formatRoute, parseHash, type Route } from './routing'

describe('parseHash', () => {
  it.each(['', '#', '#/'])('reads %j as the vault list', hash => {
    expect(parseHash(hash)).toEqual({ kind: 'list' })
  })

  it('reads the new-vault wizard, in each flow', () => {
    expect(parseHash('#/new')).toEqual({ kind: 'new', flow: 'setup' })
    expect(parseHash('#/new/claim')).toEqual({ kind: 'new', flow: 'claim' })
  })

  it('reads a vault by id', () => {
    expect(parseHash('#/vault/5a2e8c1d-0f3b-4b6e-9c11-2d7a0e4f8b90')).toEqual({
      kind: 'vault',
      id: '5a2e8c1d-0f3b-4b6e-9c11-2d7a0e4f8b90',
    })
  })

  it('decodes an escaped id', () => {
    expect(parseHash('#/vault/a%20b')).toEqual({ kind: 'vault', id: 'a b' })
  })

  it.each(['#/foo', '#/vault/', '#/vault', '#/new/elsewhere', '#vault/x', '#/vault/a/b'])(
    'falls back to the list for %j rather than a blank page',
    hash => {
      expect(parseHash(hash)).toEqual({ kind: 'list' })
    },
  )
})

describe('formatRoute', () => {
  const routes: Route[] = [
    { kind: 'list' },
    { kind: 'new', flow: 'setup' },
    { kind: 'new', flow: 'claim' },
    { kind: 'vault', id: 'abc-123' },
    { kind: 'vault', id: 'a b/c' },
  ]

  it.each(routes)('round-trips %j', route => {
    expect(parseHash(formatRoute(route))).toEqual(route)
  })

  it('writes the forms the spec names', () => {
    expect(formatRoute({ kind: 'list' })).toBe('#/')
    expect(formatRoute({ kind: 'new', flow: 'setup' })).toBe('#/new')
    expect(formatRoute({ kind: 'vault', id: 'abc' })).toBe('#/vault/abc')
  })
})
