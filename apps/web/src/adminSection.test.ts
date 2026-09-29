import { afterEach, describe, expect, it } from 'vitest'

import { APP_SECTIONS, loadSection, persistSection } from './adminSection'

/**
 * The selected section survives a reload, because an operator watching a node
 * reloads constantly and being thrown back to the owner page every time is the
 * kind of small friction that makes a tool annoying to live in.
 *
 * Both failure paths below are real rather than defensive padding: a stale
 * value outlives a rename of the sections, and `localStorage` genuinely throws
 * in Safari's private mode rather than no-opping.
 */
describe('adminSection', () => {
  afterEach(() => localStorage.clear())

  it('starts on owner when nothing is stored', () => {
    // Owner is the app's reason for existing; admin is where you go on purpose.
    expect(loadSection()).toBe('owner')
  })

  it('round-trips every section', () => {
    for (const section of APP_SECTIONS) {
      persistSection(section)
      expect(loadSection()).toBe(section)
    }
  })

  it('falls back to owner when the stored value is not a section', () => {
    // A value left by an older build, or a hand-edited one. Rendering nothing
    // because a string did not match is worse than starting at home.
    localStorage.setItem('derec.section', 'nonsense')

    expect(loadSection()).toBe('owner')
  })

  it('survives localStorage throwing on write', () => {
    // Safari in private mode throws on setItem. The app must still run; only
    // the persistence is lost.
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError')
    }

    expect(() => persistSection('inspect')).not.toThrow()

    Storage.prototype.setItem = original
  })

  it('survives localStorage throwing on read', () => {
    const original = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new Error('SecurityError')
    }

    expect(loadSection()).toBe('owner')

    Storage.prototype.getItem = original
  })
})
