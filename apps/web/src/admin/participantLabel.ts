// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/** The two fields a participant label is built from. */
interface Named {
  id: string
  name: string
}

/**
 * The accessible name for one participant's row: its name, plus a short id
 * when another participant shares that name.
 *
 * Duplicate names are routine — the pool is named from a random list, and an
 * operator may provision "Alex" twice — and two rows of "Delete Alex" are
 * indistinguishable in a screen reader's button list.
 */
export function participantLabel(
  actor: Named,
  all: readonly Named[],
): string {
  const collides = all.some(other => other.id !== actor.id && other.name === actor.name)
  return collides ? `${actor.name} (${actor.id.slice(0, 8)})` : actor.name
}
