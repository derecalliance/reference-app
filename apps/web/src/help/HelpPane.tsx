// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import SearchIcon from '@mui/icons-material/Search'
import {
  Box,
  Button,
  Collapse,
  GlobalStyles,
  InputAdornment,
  TextField,
  Typography,
  alpha,
  useMediaQuery,
} from '@mui/material'

import { MarkdownView } from './MarkdownView'
import { SEARCH_HIGHLIGHT, searchTopics } from './search'
import { HelpTopicList, type TopicListEntry } from './HelpTopicList'
import { HELP_TOPICS, loadOpenTopic, persistOpenTopic, type HelpTopic } from './topics'

/** The width at which the app switches to its phone layout (see `index.css`). */
const PHONE_QUERY = '(max-width: 640px)'

/** Room the sticky search bar takes, so a topic scrolled to is not hidden under it. */
const SEARCH_BAR_OFFSET = 88

export interface HelpPaneProps {
  /** The topics to show. Defaults to the bundled ones; tests pass their own. */
  topics?: readonly HelpTopic[]
}

/**
 * The Help section: how to use the app and configure its node, for developers.
 *
 * A search box over a topic list and a reading pane. On a phone the list folds
 * into a collapsible above the topic, opened while a search is being typed and
 * closed again once a result is picked.
 */
export function HelpPane({ topics = HELP_TOPICS }: HelpPaneProps) {
  const phone = useMediaQuery(PHONE_QUERY)
  const [openId, setOpenId] = useState(() => loadOpenTopic(topics))
  const [query, setQuery] = useState('')
  const [phoneListOpen, setPhoneListOpen] = useState(false)
  const topRef = useRef<HTMLDivElement>(null)
  const searchId = useId()
  const statusId = useId()

  const searching = query.trim() !== ''
  const hits = useMemo(() => searchTopics(topics, query), [topics, query])
  const entries: TopicListEntry[] = searching
    ? hits.map(hit => ({ topic: hit.topic, snippet: hit.snippet }))
    : topics.map(topic => ({ topic, snippet: null }))
  const openTopic = topics.find(t => t.id === openId) ?? topics[0]

  const open = useCallback((id: string) => {
    setOpenId(id)
    persistOpenTopic(id)
    setPhoneListOpen(false)
    // Back to the top of the new topic when the reader had scrolled past it;
    // with a query, the highlight then scrolls on to its first match.
    const top = topRef.current
    if (top && top.getBoundingClientRect().top < SEARCH_BAR_OFFSET) {
      top.scrollIntoView?.({ block: 'start' })
    }
  }, [])

  function changeQuery(next: string) {
    setQuery(next)
    // A phone shows the results while they are being narrowed down.
    setPhoneListOpen(next.trim() !== '')
  }

  function handleSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && hits.length > 0) {
      event.preventDefault()
      open(hits[0].topic.id)
    } else if (event.key === 'Escape' && query !== '') {
      event.preventDefault()
      changeQuery('')
    }
  }

  const status = !searching
    ? `${topics.length} topics`
    : hits.length === 0
      ? 'No topics match'
      : `${hits.length} ${hits.length === 1 ? 'topic matches' : 'topics match'}`

  const list = (
    <HelpTopicList
      entries={entries}
      currentId={openTopic?.id ?? null}
      query={query}
      onOpen={open}
    />
  )

  return (
    <Box sx={{ maxWidth: 1200, minWidth: 0 }}>
      <GlobalStyles
        styles={theme => ({
          [`::highlight(${SEARCH_HIGHLIGHT})`]: {
            backgroundColor: alpha(theme.palette.primary.main, 0.35),
            color: theme.palette.text.primary,
          },
        })}
      />

      <Typography variant="h5" component="h1">
        Help
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        How to use this app and configure its node.
      </Typography>

      {/* Sticky, so the box stays in reach while the highlight scrolls the
          topic to a match. */}
      <Box
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          bgcolor: 'background.default',
          py: 1,
        }}
      >
        <TextField
          id={searchId}
          type="search"
          size="small"
          fullWidth
          label="Search help"
          placeholder="A word, a setting, or an error message"
          value={query}
          onChange={event => changeQuery(event.target.value)}
          onKeyDown={handleSearchKey}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
            htmlInput: { 'aria-describedby': statusId },
          }}
        />
        <Typography
          id={statusId}
          variant="caption"
          color="text.secondary"
          role="status"
          sx={{ display: 'block', mt: 0.5 }}
        >
          {status}
          {searching && hits.length > 0 && ' · Enter opens the first, Escape clears'}
        </Typography>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: phone ? 'minmax(0, 1fr)' : '260px minmax(0, 1fr)',
          gap: phone ? 1 : 3,
          alignItems: 'start',
        }}
      >
        {phone ? (
          <Box>
            <Button
              fullWidth
              variant="outlined"
              onClick={() => setPhoneListOpen(v => !v)}
              aria-expanded={phoneListOpen}
              endIcon={phoneListOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              sx={{ justifyContent: 'space-between', textTransform: 'none' }}
            >
              {phoneListOpen ? 'Hide topics' : `Topic: ${openTopic?.title ?? '—'}`}
            </Button>
            <Collapse in={phoneListOpen} unmountOnExit>
              <Box sx={{ mt: 1 }}>{list}</Box>
            </Collapse>
          </Box>
        ) : (
          <Box
            component="nav"
            aria-label="Help topics"
            sx={{
              position: 'sticky',
              top: SEARCH_BAR_OFFSET,
              maxHeight: `calc(100vh - ${SEARCH_BAR_OFFSET + 160}px)`,
              overflowY: 'auto',
            }}
          >
            {list}
          </Box>
        )}

        <Box
          component="article"
          aria-label={openTopic?.title ?? 'Help topic'}
          sx={{ minWidth: 0 }}
        >
          <Box ref={topRef} sx={{ scrollMarginTop: `${SEARCH_BAR_OFFSET}px` }} />
          {openTopic ? (
            <MarkdownView markdown={openTopic.markdown} query={query} onOpenTopic={open} />
          ) : (
            <Typography color="text.secondary">No help topics are bundled with this build.</Typography>
          )}
        </Box>
      </Box>
    </Box>
  )
}
