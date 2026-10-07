// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Helper-side channel ids per actor: one entry per paired owner.

use dashmap::DashMap;
use uuid::Uuid;

/// Deliberately in memory, and deliberately not a table.
///
/// It is a *derived* index: every entry restates a channel the actor's own
/// channel store already holds, and it exists so roster enrichment does not
/// have to ask each actor. Persisting it would add a second source of truth
/// for something the stores already own.
///
/// It is also written from a synchronous context — the actor's event handling
/// — so a SQL write here could only be fire-and-forget. That is worse than it
/// sounds: the index is written when pairing completes and read immediately
/// afterwards by the roster, and `helper_auto_confirm`'s tick-backstop test
/// distinguishes "the event path ran" from "the backstop swept it" by whether
/// this index is populated. An eventually-consistent write makes that
/// unanswerable.
///
/// Boot recovery rebuilds it from each actor's channel store, which is the
/// right place for derived data to come back from.
pub trait HelperChannelIndex: Send + Sync {
    /// Record a completed pairing's channel against an actor.
    fn push(&self, actor_id: Uuid, channel_id: String);
    /// Drop one channel, so the roster stops reporting this actor as paired on
    /// a channel that no longer exists.
    fn remove(&self, actor_id: &Uuid, channel_id: &str);
    /// The channels recorded for this actor, in the order they were recorded.
    /// `None` when nothing was ever recorded for it.
    fn get(&self, actor_id: &Uuid) -> Option<Vec<String>>;
    /// Replace everything recorded for this actor.
    fn replace(&self, actor_id: Uuid, channel_ids: Vec<String>);
    /// Forget this actor, answering what was recorded for it.
    fn forget(&self, actor_id: &Uuid) -> Vec<String>;
}

#[derive(Debug, Default)]
pub struct InMemoryHelperChannelIndex {
    channels: DashMap<Uuid, Vec<String>>,
}

impl InMemoryHelperChannelIndex {
    pub fn new() -> Self {
        Self::default()
    }
}

impl HelperChannelIndex for InMemoryHelperChannelIndex {
    fn push(&self, actor_id: Uuid, channel_id: String) {
        self.channels.entry(actor_id).or_default().push(channel_id);
    }

    fn remove(&self, actor_id: &Uuid, channel_id: &str) {
        if let Some(mut entry) = self.channels.get_mut(actor_id) {
            entry.retain(|c| c != channel_id);
        }
    }

    fn get(&self, actor_id: &Uuid) -> Option<Vec<String>> {
        self.channels
            .get(actor_id)
            .map(|entry| entry.value().clone())
    }

    fn replace(&self, actor_id: Uuid, channel_ids: Vec<String>) {
        self.channels.insert(actor_id, channel_ids);
    }

    fn forget(&self, actor_id: &Uuid) -> Vec<String> {
        self.channels
            .remove(actor_id)
            .map(|(_, v)| v)
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_are_kept_per_actor_in_the_order_they_were_recorded() {
        let index = InMemoryHelperChannelIndex::new();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());

        index.push(a, "2".to_owned());
        index.push(a, "1".to_owned());

        assert_eq!(index.get(&a), Some(vec!["2".to_owned(), "1".to_owned()]));
        assert_eq!(index.get(&b), None);
    }

    #[test]
    fn removing_a_channel_keeps_the_others() {
        let index = InMemoryHelperChannelIndex::new();
        let a = Uuid::new_v4();
        index.push(a, "1".to_owned());
        index.push(a, "2".to_owned());

        index.remove(&a, "1");

        assert_eq!(index.get(&a), Some(vec!["2".to_owned()]));
    }

    #[test]
    fn forgetting_an_actor_hands_back_what_it_held() {
        let index = InMemoryHelperChannelIndex::new();
        let a = Uuid::new_v4();
        index.replace(a, vec!["7".to_owned()]);

        assert_eq!(index.forget(&a), vec!["7".to_owned()]);
        assert_eq!(index.get(&a), None);
        assert!(index.forget(&a).is_empty());
    }
}
