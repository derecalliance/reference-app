// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { describe, expect, it } from 'vitest'

import { searchTerms, searchTopics } from './search'
import { HELP_TOPICS, parseTopic, plainText, topicIdFromHref, DEFAULT_TOPIC_ID } from './topics'

const pairing = parseTopic(
  './content/03-pairing.md',
  [
    '# Pairing',
    '',
    'How to pair a vault with helpers.',
    '',
    '## Contact modes',
    '',
    'Inline keys, hashed keys and no keys. See [Replicas](07-replicas.md).',
  ].join('\n'),
)
const replicas = parseTopic(
  './content/07-replicas.md',
  [
    '# Replicas',
    '',
    'Mirroring a vault onto another device.',
    '',
    '## Conflicts',
    '',
    'Publishing is paused until the conflict is resolved. Pairing is refused too.',
  ].join('\n'),
)
const glossary = parseTopic(
  './content/17-glossary.md',
  ['# Glossary', '', 'Short definitions.', '', '| Term | Meaning |', '| --- | --- |', '| **Contact** | What one side shares. |'].join('\n'),
)
const topics = [pairing, replicas, glossary]

describe('parseTopic', () => {
  it('reads the id, title, summary and headings', () => {
    expect(pairing.id).toBe('03-pairing')
    expect(pairing.title).toBe('Pairing')
    expect(pairing.summary).toBe('How to pair a vault with helpers.')
    expect(pairing.headings).toEqual(['Contact modes'])
  })

  it('keeps link text and drops link targets and table rules from the plain text', () => {
    expect(pairing.text).toContain('See Replicas.')
    expect(pairing.text).not.toContain('07-replicas.md')
    expect(glossary.text).not.toContain('---')
    expect(plainText('**Bold** `code`')).toBe('Bold code')
  })
})

describe('topicIdFromHref', () => {
  it('recognises links between topics', () => {
    expect(topicIdFromHref('07-replicas.md')).toBe('07-replicas')
    expect(topicIdFromHref('./07-replicas.md#conflicts')).toBe('07-replicas')
  })

  it('leaves every other link alone', () => {
    expect(topicIdFromHref('https://example.com/07-replicas.md')).toBeNull()
    expect(topicIdFromHref('README.md')).toBeNull()
    expect(topicIdFromHref(undefined)).toBeNull()
  })
})

describe('searchTopics', () => {
  it('matches nothing for an empty query', () => {
    expect(searchTerms('   ')).toEqual([])
    expect(searchTopics(topics, '  ')).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(searchTopics(topics, 'REPLICAS').map(h => h.topic.id)).toContain('07-replicas')
  })

  it('ranks a title match above a heading match above a body match', () => {
    // "pairing": the title of one topic, body text of another.
    const ids = searchTopics(topics, 'pairing').map(h => h.topic.id)
    expect(ids).toEqual(['03-pairing', '07-replicas'])

    // "contact": a heading in one topic, body text in another.
    const contact = searchTopics(topics, 'contact')
    expect(contact.map(h => h.topic.id)).toEqual(['03-pairing', '17-glossary'])
    expect(contact[0].field).toBe('heading')
    expect(contact[1].field).toBe('body')
  })

  it('requires every word, and ranks the words found as a phrase higher', () => {
    expect(searchTopics(topics, 'conflict nonexistentword')).toEqual([])
    const hits = searchTopics(topics, 'publishing is paused')
    expect(hits.map(h => h.topic.id)).toEqual(['07-replicas'])
  })

  it('shows the summary for a title match, the heading for a heading match, and context for a body match', () => {
    expect(searchTopics(topics, 'glossary')[0].snippet).toBe('Short definitions.')
    expect(searchTopics(topics, 'conflicts')[0].snippet).toBe('Conflicts')
    const body = searchTopics(topics, 'paused')[0]
    expect(body.field).toBe('body')
    expect(body.snippet).toContain('Publishing is paused')
  })

  it('keeps the topics’ own order between equal scores', () => {
    expect(searchTopics(topics, 'vault').map(h => h.topic.id)).toEqual(['03-pairing', '07-replicas'])
  })
})

describe('the bundled topics', () => {
  it('start with Getting started, and each has a title and a summary', () => {
    expect(HELP_TOPICS.length).toBeGreaterThan(10)
    expect(HELP_TOPICS[0].id).toBe(DEFAULT_TOPIC_ID)
    for (const topic of HELP_TOPICS) {
      expect(topic.title, topic.id).not.toBe(topic.id)
      expect(topic.summary.length, topic.id).toBeGreaterThan(20)
    }
  })

  it('link only to topics that exist', () => {
    const ids = new Set(HELP_TOPICS.map(t => t.id))
    for (const topic of HELP_TOPICS) {
      for (const [, href] of topic.markdown.matchAll(/\]\(([^)]+)\)/g)) {
        const target = topicIdFromHref(href)
        if (target !== null) expect(ids.has(target), `${topic.id} → ${href}`).toBe(true)
      }
    }
  })

  it('find a setting by its name as written, underscores included', () => {
    const ids = searchTopics(HELP_TOPICS, 'relay_allowed_hosts').map(h => h.topic.id)
    expect(ids).toContain('15-node-configuration')
    expect(ids).toContain('13-transports')
  })

  it('finds Getting started by searching for it', () => {
    expect(searchTopics(HELP_TOPICS, 'getting started')[0].topic.id).toBe(DEFAULT_TOPIC_ID)
  })
})
