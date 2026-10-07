// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Box,
  Divider,
  Link,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'

import { SEARCH_HIGHLIGHT, searchTerms } from './search'
import { topicIdFromHref } from './topics'

/** Most ranges registered at once; a one-letter query should not stall the page. */
const MAX_HIGHLIGHTS = 300

export interface MarkdownViewProps {
  markdown: string
  /** The search query, whose words are highlighted; the first match is scrolled to. */
  query: string
  /** Open another topic, from a link such as `[Pairing](03-pairing.md)`. */
  onOpenTopic: (id: string) => void
}

/** Shared by inline code and the code inside a block. */
const MONO = { fontFamily: 'var(--mono, monospace)', fontSize: '0.875em' } as const

/**
 * One Help topic, rendered with the app's MUI typography.
 *
 * `react-markdown` builds React elements and never injects HTML, so a topic
 * cannot carry markup or script. Every element is mapped to an MUI
 * counterpart: the app's global `h1`/`h2`/`code` rules are written for its own
 * screens, and bare elements would inherit their 56 px headings.
 */
export function MarkdownView({ markdown, query, onOpenTopic }: MarkdownViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Highlight without touching the DOM React owns: the CSS Custom Highlight
  // API paints ranges over existing text, so nothing is wrapped and nothing
  // can fall out of step with the next render. Where it is missing, the first
  // match is still scrolled to.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ranges = matchRanges(container, query)
    const highlights = typeof CSS !== 'undefined' ? CSS.highlights : undefined
    if (highlights && typeof Highlight !== 'undefined') {
      if (ranges.length > 0) highlights.set(SEARCH_HIGHLIGHT, new Highlight(...ranges))
      else highlights.delete(SEARCH_HIGHLIGHT)
    }
    const first = ranges[0]?.startContainer.parentElement
    if (first && typeof first.scrollIntoView === 'function') {
      first.scrollIntoView({ block: 'center' })
    }
    return () => {
      highlights?.delete(SEARCH_HIGHLIGHT)
    }
  }, [markdown, query])

  // Memoised so typing in the search box neither re-parses the topic nor
  // remounts it: component functions recreated per render are new element
  // types to React, and would rebuild every node the highlight points at.
  const content = useMemo(() => {
    const components = markdownComponents(onOpenTopic)
    return (
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </Markdown>
    )
  }, [markdown, onOpenTopic])

  return (
    <Box ref={containerRef} sx={{ minWidth: 0, overflowWrap: 'break-word' }}>
      {content}
    </Box>
  )
}

/** Every Markdown element, mapped to its MUI counterpart. */
function markdownComponents(onOpenTopic: (id: string) => void): Components {
  return {
    h1: ({ children }) => (
      <Typography variant="h5" component="h1" gutterBottom>
        {children}
      </Typography>
    ),
    h2: ({ children }) => (
      <Typography variant="h6" component="h2" sx={{ mt: 4, mb: 1 }}>
        {children}
      </Typography>
    ),
    h3: ({ children }) => (
      <Typography variant="subtitle1" component="h3" sx={{ mt: 3, mb: 1, fontWeight: 600 }}>
        {children}
      </Typography>
    ),
    p: ({ children }) => (
      <Typography variant="body1" component="p" sx={{ mb: 1.5 }}>
        {children}
      </Typography>
    ),
    ul: ({ children }) => (
      <Box component="ul" sx={{ pl: 3, mt: 0, mb: 1.5 }}>
        {children}
      </Box>
    ),
    ol: ({ children }) => (
      <Box component="ol" sx={{ pl: 3, mt: 0, mb: 1.5 }}>
        {children}
      </Box>
    ),
    li: ({ children }) => (
      <Typography variant="body1" component="li" sx={{ mb: 0.5 }}>
        {children}
      </Typography>
    ),
    a: ({ href, children }) => (
      <TopicLink href={href} onOpenTopic={onOpenTopic}>
        {children}
      </TopicLink>
    ),
    hr: () => <Divider sx={{ my: 3 }} />,
    blockquote: ({ children }) => (
      <Box
        component="blockquote"
        sx={{ m: 0, mb: 1.5, pl: 2, borderLeft: 3, borderColor: 'divider', color: 'text.secondary' }}
      >
        {children}
      </Box>
    ),
    code: ({ children }) => (
      <Box
        component="code"
        sx={{
          ...MONO,
          px: 0.5,
          py: 0.125,
          borderRadius: 0.5,
          bgcolor: 'action.hover',
          color: 'inherit',
          overflowWrap: 'anywhere',
        }}
      >
        {children}
      </Box>
    ),
    pre: ({ children }) => (
      <Box
        component="pre"
        sx={{
          m: 0,
          mb: 2,
          p: 1.5,
          overflowX: 'auto',
          borderRadius: 1,
          bgcolor: 'action.hover',
          // The block owns the background; the `code` inside it must not
          // paint a second one or wrap the lines it is meant to keep.
          '& code': { ...MONO, p: 0, bgcolor: 'transparent', overflowWrap: 'normal' },
        }}
      >
        {children}
      </Box>
    ),
    // Wide tables scroll inside their own box, never the page.
    table: ({ children }) => (
      <TableContainer
        sx={{ mb: 2, border: 1, borderColor: 'divider', borderRadius: 1, overflowX: 'auto' }}
      >
        <Table size="small">{children}</Table>
      </TableContainer>
    ),
    thead: ({ children }) => <TableHead>{children}</TableHead>,
    tbody: ({ children }) => <TableBody>{children}</TableBody>,
    tr: ({ children }) => <TableRow>{children}</TableRow>,
    th: ({ children }) => (
      <TableCell component="th" sx={{ fontWeight: 600, verticalAlign: 'bottom' }}>
        {children}
      </TableCell>
    ),
    td: ({ children }) => <TableCell sx={{ verticalAlign: 'top' }}>{children}</TableCell>,
  }
}

/**
 * A link in a topic: another topic opens in place, anything else opens in a
 * new tab.
 */
function TopicLink({
  href,
  onOpenTopic,
  children,
}: {
  href: string | undefined
  onOpenTopic: (id: string) => void
  children: ReactNode
}) {
  const topicId = topicIdFromHref(href)
  if (topicId) {
    return (
      // A button, not an href: the app's hash is its router, and switching
      // topic is state within this pane.
      <Link
        component="button"
        type="button"
        onClick={() => onOpenTopic(topicId)}
        sx={{ font: 'inherit', verticalAlign: 'baseline', textAlign: 'left' }}
      >
        {children}
      </Link>
    )
  }
  return (
    <Link href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </Link>
  )
}

/**
 * A range for every occurrence of each query word in `root`'s text.
 *
 * Case-insensitive and per text node, so a word split across formatting (half
 * in `code`, half not) is not found — acceptable for a highlight.
 */
function matchRanges(root: HTMLElement, query: string): Range[] {
  const terms = searchTerms(query)
  if (terms.length === 0) return []
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node && ranges.length < MAX_HIGHLIGHTS; node = walker.nextNode()) {
    const text = (node.textContent ?? '').toLowerCase()
    for (const term of terms) {
      let at = text.indexOf(term)
      while (at !== -1 && ranges.length < MAX_HIGHLIGHTS) {
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + term.length)
        ranges.push(range)
        at = text.indexOf(term, at + term.length)
      }
    }
  }
  return ranges
}
