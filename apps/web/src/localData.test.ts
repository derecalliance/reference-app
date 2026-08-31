import { beforeEach, describe, expect, it } from 'vitest'
import { clearAllLocalData, countLocalDataEntries } from './localData'

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
