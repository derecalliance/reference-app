// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { ReplicaConflict, UserSecret } from '../types'

/**
 * Why publishing from this vault is paused, in words to show on every control
 * that would publish.
 */
export function replicaConflictBlockReason(conflict: ReplicaConflict): string {
  return (
    `This vault's copy of v${conflict.version} differs from its replica group's. Publishing is ` +
    'paused until you resolve the conflict — a new version from this device would replace the ' +
    "other members' copies and lose their change."
  )
}

/** One secret as it appears in this device's copy, the rival's, or both. */
export interface ConflictEntry {
  /** The secret's id, shared by both copies when both hold it. */
  id: string
  mine: UserSecret | null
  theirs: UserSecret | null
}

/** What to do with one entry when publishing the resolution. */
export type EntryResolution = 'mine' | 'theirs' | 'drop'

/**
 * Line the two copies up secret by secret, by id: one entry per id, in this
 * device's order first, then whatever only the rival holds.
 *
 * By id because that is what a secret *is* across versions — an edit keeps
 * the id and changes the contents, so the same id on both sides with different
 * contents is the one real disagreement to settle.
 */
export function conflictEntries(
  mine: readonly UserSecret[],
  theirs: readonly UserSecret[],
): ConflictEntry[] {
  const theirsById = new Map(theirs.map(s => [s.id, s]))
  const mineIds = new Set(mine.map(s => s.id))
  return [
    ...mine.map(s => ({ id: s.id, mine: s, theirs: theirsById.get(s.id) ?? null })),
    ...theirs.filter(s => !mineIds.has(s.id)).map(s => ({ id: s.id, mine: null, theirs: s })),
  ]
}

/** Both copies hold this secret, with the same name and contents. */
export function isIdentical(entry: ConflictEntry): boolean {
  return (
    entry.mine !== null &&
    entry.theirs !== null &&
    entry.mine.name === entry.theirs.name &&
    entry.mine.data === entry.theirs.data
  )
}

/**
 * The starting choice for an entry: keep everything either side has, and for
 * a secret both sides changed, this device's version.
 *
 * Keeping is the default because dropping is the one choice that loses data;
 * a secret one member deleted reappears, and the owner unticks it.
 */
export function defaultResolution(entry: ConflictEntry): EntryResolution {
  return entry.mine !== null ? 'mine' : 'theirs'
}

/** The secrets the resolving publish carries, in the order the entries are listed. */
export function mergedSecrets(
  entries: readonly ConflictEntry[],
  choices: Readonly<Record<string, EntryResolution>>,
): UserSecret[] {
  return entries.flatMap(entry => {
    const choice = choices[entry.id] ?? defaultResolution(entry)
    const picked = choice === 'mine' ? entry.mine : choice === 'theirs' ? entry.theirs : null
    return picked ? [picked] : []
  })
}
