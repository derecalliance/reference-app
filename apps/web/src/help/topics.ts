// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

/**
 * The Help topics: one Markdown file per topic under `./content`, ordered by
 * the numeric prefix of its file name.
 *
 * Each file opens with a `# Title` line and a one-paragraph summary. The files
 * are bundled as raw strings — the Help pane is lazy-loaded, so they cost
 * nothing until it is first opened — and parsed once, here, into the shape the
 * pane and the search need.
 */

export interface HelpTopic {
  /** The file name without `.md`, e.g. `03-pairing`. Stable: links and storage use it. */
  id: string
  title: string
  /** The first paragraph after the title. */
  summary: string
  /** The whole file, as rendered. */
  markdown: string
  /** Every `##`/`###` heading, in order. */
  headings: string[]
  /** The body below the title as plain text, for search and snippets. */
  text: string
}

/** The topic Help opens on when nothing else was chosen. */
export const DEFAULT_TOPIC_ID = '00-getting-started'

const TOPIC_FILE = /(\d\d-[a-z0-9-]+)\.md$/
const HEADING = /^#{2,3}\s+(.+?)\s*$/

/** A topic file's id from its path, or `null` when it is not one. */
function topicIdOf(path: string): string | null {
  return TOPIC_FILE.exec(path)?.[1] ?? null
}

/**
 * The topic a Markdown link points at, or `null` when it is not a topic link.
 *
 * Topics link to each other by file name — `[Pairing](03-pairing.md)` — so
 * they read correctly as plain files too; the pane turns those into topic
 * switches instead of navigations.
 */
export function topicIdFromHref(href: string | undefined): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null
  const path = href.split('#')[0].replace(/^\.\//, '')
  return /^\d\d-[a-z0-9-]+\.md$/.test(path) ? path.slice(0, -'.md'.length) : null
}

/**
 * Markdown reduced to the words a reader sees: syntax, link targets and table
 * rules dropped, whitespace collapsed. Approximate by design — it feeds search
 * and snippets, never rendering.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^```.*$/gm, ' ')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    // Inline marks vanish without leaving a gap ("(`x`)" reads "(x)"); table
    // and quote bars separate words. `_` is kept: the topics use `*` for
    // emphasis, and setting names such as `relay_allowed_hosts` must stay
    // searchable as typed.
    .replace(/[`*]/g, '')
    .replace(/[|>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse one topic file. `path` only supplies the id. */
export function parseTopic(path: string, raw: string): HelpTopic {
  const id = topicIdOf(path) ?? path
  const lines = raw.replace(/\r\n/g, '\n').split('\n')

  const titleIndex = lines.findIndex(line => /^#\s+/.test(line))
  const title = titleIndex === -1 ? id : lines[titleIndex].replace(/^#\s+/, '').trim()
  const bodyLines = titleIndex === -1 ? lines : lines.slice(titleIndex + 1)

  // The first block of text after the title, up to the next blank line.
  const summaryLines: string[] = []
  for (const line of bodyLines) {
    if (line.trim() === '') {
      if (summaryLines.length > 0) break
      continue
    }
    if (/^#/.test(line)) break
    summaryLines.push(line.trim())
  }

  let inFence = false
  const headings: string[] = []
  for (const line of bodyLines) {
    if (line.startsWith('```')) inFence = !inFence
    if (inFence) continue
    const match = HEADING.exec(line)
    if (match) headings.push(plainText(match[1]))
  }

  return {
    id,
    title,
    summary: plainText(summaryLines.join(' ')),
    markdown: raw,
    headings,
    text: plainText(bodyLines.join('\n')),
  }
}

const FILES = import.meta.glob<string>('./content/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** Every topic, in file-name order. */
export const HELP_TOPICS: readonly HelpTopic[] = Object.entries(FILES)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, raw]) => parseTopic(path, raw))

const STORAGE_KEY = 'derec.help.topic'

/** The topic last open in this browser, if it still exists. */
export function loadOpenTopic(topics: readonly HelpTopic[]): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && topics.some(t => t.id === stored)) return stored
  } catch {
    // Storage can be unavailable; remembering the topic is only a convenience.
  }
  return topics.some(t => t.id === DEFAULT_TOPIC_ID) ? DEFAULT_TOPIC_ID : (topics[0]?.id ?? '')
}

export function persistOpenTopic(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // Safari in private mode throws rather than no-opping.
  }
}
