// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import { formatRoute, parseHash, type Route } from './routing'

describe('parseHash', () => {
  it.each(['', '#', '#/'])('reads %j as the secret list', hash => {
    expect(parseHash(hash)).toEqual({ kind: 'list' })
  })

  it('reads the new-secret wizard, in each flow', () => {
    expect(parseHash('#/new')).toEqual({ kind: 'new', flow: 'setup' })
    expect(parseHash('#/new/claim')).toEqual({ kind: 'new', flow: 'claim' })
  })

  it('reads a secret by id', () => {
    expect(parseHash('#/secret/5a2e8c1d-0f3b-4b6e-9c11-2d7a0e4f8b90')).toEqual({
      kind: 'secret',
      id: '5a2e8c1d-0f3b-4b6e-9c11-2d7a0e4f8b90',
    })
  })

  it('reads a link from before the rename, under #/vault/', () => {
    expect(parseHash('#/secret/abc')).toEqual({ kind: 'secret', id: 'abc' })
  })

  it('reads a secret opened on its Notifications tab', () => {
    expect(parseHash('#/secret/abc/notifications')).toEqual({ kind: 'secret', id: 'abc', tab: 'notifications' })
  })

  it('decodes an escaped id', () => {
    expect(parseHash('#/secret/a%20b')).toEqual({ kind: 'secret', id: 'a b' })
  })

  it.each(['#/foo', '#/secret/', '#/secret', '#/new/elsewhere', '#secret/x', '#/secret/a/b'])(
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
    { kind: 'secret', id: 'abc-123' },
    { kind: 'secret', id: 'a b/c' },
    { kind: 'secret', id: 'abc', tab: 'notifications' },
  ]

  it.each(routes)('round-trips %j', route => {
    expect(parseHash(formatRoute(route))).toEqual(route)
  })

  it('writes the forms the spec names', () => {
    expect(formatRoute({ kind: 'list' })).toBe('#/')
    expect(formatRoute({ kind: 'new', flow: 'setup' })).toBe('#/new')
    expect(formatRoute({ kind: 'secret', id: 'abc' })).toBe('#/secret/abc')
    expect(formatRoute({ kind: 'secret', id: 'abc', tab: 'notifications' })).toBe('#/secret/abc/notifications')
  })
})
