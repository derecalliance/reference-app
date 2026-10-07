// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import type { HelpTopic } from './topics'

/**
 * Search over the Help topics. Deliberately small: eighteen short documents
 * need no index and no library, only a case-insensitive scan that ranks
 * where a match was found.
 */

/** Where a topic matched, strongest first. */
export type MatchField = 'title' | 'heading' | 'body'

/** The name search matches are registered under in `CSS.highlights`. */
export const SEARCH_HIGHLIGHT = 'help-search'

export interface SearchHit {
  topic: HelpTopic
  field: MatchField
  /** A short excerpt showing the match. */
  snippet: string
}

const FIELD_WEIGHT: Record<MatchField, number> = { title: 3, heading: 2, body: 1 }
/** The whole query found as typed counts for more than its words scattered. */
const PHRASE_BONUS: Record<MatchField, number> = { title: 12, heading: 8, body: 4 }
/** Characters of context either side of a body match. */
const SNIPPET_CONTEXT = 60

/** The query as lower-case words. Empty when there is nothing to search for. */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(term => term.length > 0)
}

/** The strongest field `needle` (lower-case) occurs in, or `null`. */
function fieldOf(topic: HelpTopic, needle: string): MatchField | null {
  if (topic.title.toLowerCase().includes(needle)) return 'title'
  if (topic.headings.some(h => h.toLowerCase().includes(needle))) return 'heading'
  if (topic.text.toLowerCase().includes(needle)) return 'body'
  return null
}

/** Up to `SNIPPET_CONTEXT` characters either side of the first `needle` in `text`. */
function excerpt(text: string, needle: string): string {
  const at = text.toLowerCase().indexOf(needle)
  if (at === -1) return text.slice(0, SNIPPET_CONTEXT * 2)
  const start = Math.max(0, at - SNIPPET_CONTEXT)
  const end = Math.min(text.length, at + needle.length + SNIPPET_CONTEXT)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

function snippetFor(topic: HelpTopic, field: MatchField, needle: string): string {
  if (field === 'title') return topic.summary
  if (field === 'heading') {
    return topic.headings.find(h => h.toLowerCase().includes(needle)) ?? topic.summary
  }
  return excerpt(topic.text, needle)
}

/**
 * The topics matching `query`, best first.
 *
 * Every word must occur somewhere in a topic. A topic ranks by where its words
 * occur — title over headings over body — with a bonus when the whole query
 * occurs as typed, so pasting an error message finds the topic that quotes it.
 * Ties keep the topics' own order. An empty query matches nothing.
 */
export function searchTopics(topics: readonly HelpTopic[], query: string): SearchHit[] {
  const terms = searchTerms(query)
  if (terms.length === 0) return []
  const phrase = terms.join(' ')

  const scored: { hit: SearchHit; score: number; order: number }[] = []
  topics.forEach((topic, order) => {
    const fields = terms.map(term => fieldOf(topic, term))
    if (fields.some(field => field === null)) return

    const phraseField = terms.length > 1 ? fieldOf(topic, phrase) : null
    let score = fields.reduce((sum, field) => sum + (field ? FIELD_WEIGHT[field] : 0), 0)
    if (phraseField) score += PHRASE_BONUS[phraseField]

    // The snippet shows the phrase when it occurs, else the first word.
    const needle = phraseField ? phrase : terms[0]
    const field = phraseField ?? fields[0] ?? 'body'
    scored.push({ hit: { topic, field, snippet: snippetFor(topic, field, needle) }, score, order })
  })

  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(entry => entry.hit)
}
