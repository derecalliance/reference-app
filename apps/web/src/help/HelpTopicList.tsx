// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

import { List, ListItemButton, ListItemText, Typography } from '@mui/material'

import type { HelpTopic } from './topics'

export interface TopicListEntry {
  topic: HelpTopic
  /** The matched text, while searching; `null` lists the title alone. */
  snippet: string | null
}

export interface HelpTopicListProps {
  entries: readonly TopicListEntry[]
  currentId: string | null
  /** The search as typed, for the empty state. */
  query: string
  onOpen: (id: string) => void
}

/** The topics, or the search results with a snippet of what matched in each. */
export function HelpTopicList({ entries, currentId, query, onOpen }: HelpTopicListProps) {
  if (entries.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 2 }}>
        No topics match “{query.trim()}”. Try fewer or different words, or look in
        Troubleshooting for the message you see.
      </Typography>
    )
  }

  return (
    <List dense disablePadding>
      {entries.map(({ topic, snippet }) => {
        const current = topic.id === currentId
        return (
          <ListItemButton
            key={topic.id}
            selected={current}
            aria-current={current ? 'true' : undefined}
            onClick={() => onOpen(topic.id)}
            sx={{ borderRadius: 1, alignItems: 'flex-start' }}
          >
            <ListItemText
              primary={topic.title}
              secondary={snippet}
              slotProps={{
                secondary: { sx: { overflowWrap: 'anywhere' } },
              }}
            />
          </ListItemButton>
        )
      })}
    </List>
  )
}
