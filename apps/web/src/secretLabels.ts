// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * Naming secrets so the list and the switcher can tell them apart.
 *
 * Nothing stops two secrets in one browser carrying the same name — they are
 * different owner actors, and the node only identifies them by id — but a list
 * of two identical names is a list nobody can pick from. Names that collide get
 * the start of the actor id appended; unique ones are left alone.
 */

/** How much of the actor id tells two namesakes apart. */
const ID_SUFFIX_LENGTH = 8

/** The comparison key for a name: what the person would read as "the same". */
export function nameKey(name: string): string {
  return name.normalize('NFC').trim().toLocaleLowerCase()
}

/** A label per local secret id: the name, plus an id suffix when another secret shares it. */
export function distinctSecretLabels(
  entries: readonly { id: string; name: string }[],
): Map<string, string> {
  const counts = new Map<string, number>()
  for (const { name } of entries) {
    const key = nameKey(name)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return new Map(
    entries.map(({ id, name }) => [
      id,
      (counts.get(nameKey(name)) ?? 0) > 1 ? `${name.trim()} · ${id.slice(0, ID_SUFFIX_LENGTH)}` : name,
    ]),
  )
}

/** Whether `name` would collide with a secret this browser already holds. */
export function isDuplicateSecretName(name: string, existing: readonly string[]): boolean {
  const key = nameKey(name)
  return key !== '' && existing.some(other => nameKey(other) === key)
}
