// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it, vi } from 'vitest'

import { installWasmBorrowGuard } from './wasmBorrowGuard'

const BORROW_MESSAGE =
  'recursive use of an object detected which would lead to unsafe aliasing in rust'

describe('wasm borrow guard', () => {
  it('reports the overlap wasm-bindgen throws out of a microtask', () => {
    // The throw escapes as an uncaught error and the call's promise never
    // settles, so without this the only trace is a line in devtools.
    const target = new EventTarget()
    const report = vi.fn()
    installWasmBorrowGuard(target, report)

    target.dispatchEvent(new ErrorEvent('error', { message: `Uncaught ${BORROW_MESSAGE}` }))

    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0][0]).toMatch(/overlapped/)
  })

  it('leaves every other uncaught error alone', () => {
    const target = new EventTarget()
    const report = vi.fn()
    installWasmBorrowGuard(target, report)

    target.dispatchEvent(new ErrorEvent('error', { message: 'TypeError: x is undefined' }))

    expect(report).not.toHaveBeenCalled()
  })

  it('can be removed', () => {
    const target = new EventTarget()
    const report = vi.fn()
    const uninstall = installWasmBorrowGuard(target, report)

    uninstall()
    target.dispatchEvent(new ErrorEvent('error', { message: BORROW_MESSAGE }))

    expect(report).not.toHaveBeenCalled()
  })
})
