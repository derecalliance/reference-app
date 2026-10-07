// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Server-side observability, for humans and for agents.
//!
//! This app is a debugging tool. Everything it knows should be reachable
//! without clicking, because the thing reading it is as often an agent or a
//! `curl` as a person at a browser.
//!
//! Two surfaces, both served over plain HTTP:
//!
//! - a **state snapshot** — what exists right now: actors and the endpoints
//!   they advertise, which tier of the channel router holds each channel,
//!   which protocol instances an actor is running.
//! - an **event log** — what happened, in order, with the transport each
//!   message actually travelled over. The front end has always had its own
//!   browser-side log of the flows it drives; this is the half it could never
//!   see, and the only half an agent working over HTTP can reach at all.
//!
//! # Why a ring buffer
//!
//! An unbounded log in a long-running dev container is a slow memory leak, and
//! a developer debugging a flow cares about the last few hundred events, not
//! the first few hundred. [`EventLog`] keeps a fixed window and drops the
//! oldest, reporting `dropped` so a reader can tell truncation from silence.

use std::collections::VecDeque;
use std::sync::RwLock;

use crate::models::{Event, EventSnapshot, NewEvent, EVENT_LOG_CAPACITY};
use crate::services::ports::EventRecorder;

/// A bounded, append-only log.
#[derive(Debug)]
pub struct EventLog {
    inner: RwLock<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    events: VecDeque<Event>,
    next_seq: u64,
    dropped: u64,
}

impl Default for EventLog {
    fn default() -> Self {
        Self::new()
    }
}

impl EventLog {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(Inner {
                events: VecDeque::with_capacity(64),
                next_seq: 1,
                dropped: 0,
            }),
        }
    }

    /// Record one event, evicting the oldest if the window is full.
    ///
    /// Takes a [`NewEvent`] rather than a built `Event` so callers cannot get
    /// `seq` or `at_ms` wrong — both are this type's to assign.
    pub fn record(&self, new: NewEvent) {
        let mut inner = self.write();

        let seq = inner.next_seq;
        inner.next_seq += 1;

        let event = Event {
            seq,
            at_ms: now_ms(),
            direction: new.direction,
            carrier: new.carrier,
            outcome: new.outcome,
            actor_id: new.actor_id,
            channel_id: new.channel_id.map(|c| c.to_string()),
            bytes: new.bytes,
            detail: new.detail,
        };

        if inner.events.len() == EVENT_LOG_CAPACITY {
            inner.events.pop_front();
            inner.dropped += 1;
        }
        inner.events.push_back(event);
    }

    /// Events with `seq` greater than `after`, oldest first, capped at `limit`.
    ///
    /// `after = 0` means "from the beginning of the retained window". A reader
    /// polls by passing back the highest `seq` it has already seen, which is
    /// why the cursor is a sequence number rather than a timestamp: two events
    /// in the same millisecond must still be distinguishable.
    pub fn since(&self, after: u64, limit: usize) -> EventSnapshot {
        let inner = self.read();

        let events: Vec<Event> = inner
            .events
            .iter()
            .filter(|e| e.seq > after)
            .take(limit)
            .cloned()
            .collect();

        EventSnapshot {
            events,
            dropped: inner.dropped,
            latest_seq: inner.next_seq.saturating_sub(1),
        }
    }

    /// A poisoned lock means a previous holder panicked mid-write. The log has
    /// no cross-field invariant worth protecting and losing observability is
    /// the worst possible response to a panic, so recover rather than escalate
    /// — the same stance the node's other in-memory indexes take.
    fn read(&self) -> std::sync::RwLockReadGuard<'_, Inner> {
        self.inner.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, Inner> {
        self.inner.write().unwrap_or_else(|e| e.into_inner())
    }
}

impl EventRecorder for EventLog {
    fn record(&self, event: NewEvent) {
        EventLog::record(self, event);
    }

    fn since(&self, after: u64, limit: usize) -> EventSnapshot {
        EventLog::since(self, after, limit)
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Carrier, Direction, Outcome};

    fn event(
        direction: Direction,
        carrier: Carrier,
        outcome: Outcome,
        channel_id: u64,
        bytes: usize,
        detail: &str,
    ) -> NewEvent {
        NewEvent {
            direction,
            carrier,
            outcome,
            actor_id: None,
            channel_id: Some(channel_id),
            bytes,
            detail: detail.to_owned(),
        }
    }

    fn log_with(n: usize) -> EventLog {
        let log = EventLog::new();
        for i in 0..n {
            log.record(event(
                Direction::Inbound,
                Carrier::Http,
                Outcome::Delivered,
                i as u64,
                10,
                &format!("event {i}"),
            ));
        }
        log
    }

    #[test]
    fn sequence_numbers_start_at_one_and_increase() {
        let snapshot = log_with(3).since(0, 100);

        assert_eq!(
            snapshot.events.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(snapshot.latest_seq, 3);
    }

    #[test]
    fn since_returns_only_what_follows_the_cursor() {
        // The polling contract: hand back the highest seq you have seen and
        // get exactly what you have not.
        let snapshot = log_with(5).since(3, 100);

        assert_eq!(
            snapshot.events.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![4, 5]
        );
    }

    #[test]
    fn an_empty_log_reports_no_events_and_no_loss() {
        let snapshot = EventLog::new().since(0, 100);

        assert!(snapshot.events.is_empty());
        assert_eq!(snapshot.dropped, 0);
        assert_eq!(snapshot.latest_seq, 0);
    }

    #[test]
    fn the_window_evicts_the_oldest_and_says_how_many() {
        // Silence and truncation look identical to a reader diagnosing a gap,
        // so the count is what distinguishes them.
        let log = log_with(EVENT_LOG_CAPACITY + 5);

        let snapshot = log.since(0, EVENT_LOG_CAPACITY * 2);

        assert_eq!(snapshot.dropped, 5);
        assert_eq!(snapshot.events.len(), EVENT_LOG_CAPACITY);
        assert_eq!(
            snapshot.events.first().map(|e| e.seq),
            Some(6),
            "the five oldest must be the ones evicted"
        );
    }

    #[test]
    fn limit_caps_a_page_without_losing_the_cursor() {
        let log = log_with(10);

        let page = log.since(0, 4);

        assert_eq!(page.events.len(), 4);
        assert_eq!(
            page.latest_seq, 10,
            "latest_seq reports the log's head, not the page's tail, so a \
             reader knows more is waiting"
        );
    }

    #[test]
    fn a_cursor_past_the_head_yields_nothing_rather_than_wrapping() {
        let snapshot = log_with(3).since(99, 100);

        assert!(snapshot.events.is_empty());
        assert_eq!(snapshot.latest_seq, 3);
    }

    #[test]
    fn channel_ids_serialize_as_decimal_strings() {
        // A u64 channel id exceeds JavaScript's exact integer range, so it
        // must never travel as a JSON number.
        let log = EventLog::new();
        log.record(event(
            Direction::Outbound,
            Carrier::Grpc,
            Outcome::Delivered,
            18446744073709551615,
            0,
            "big",
        ));

        let json = serde_json::to_string(&log.since(0, 10).events).expect("serializes");

        assert!(json.contains("\"18446744073709551615\""));
    }

    #[test]
    fn an_unroutable_message_records_with_no_actor() {
        // The interesting failure: a message arrived and could not be placed.
        // It must still appear, precisely because it has no actor.
        let log = EventLog::new();
        log.record(event(
            Direction::Inbound,
            Carrier::Grpc,
            Outcome::Refused,
            42,
            120,
            "no actor holds channel 42",
        ));

        let snapshot = log.since(0, 10);

        assert_eq!(snapshot.events.len(), 1);
        assert!(snapshot.events[0].actor_id.is_none());
        assert_eq!(snapshot.events[0].outcome, Outcome::Refused);
    }
}
