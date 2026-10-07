// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Where each actor's traffic goes: a running instance, or a browser mailbox.

use actix::Addr;
use dashmap::DashMap;
use uuid::Uuid;

use super::provisioned::{IncomingMessage, ProvisionedActor};
use crate::models::InboxKind;
use crate::services::ports::InboxDirectory;

/// Unified inbox for all actors, regardless of whether they run in-process or
/// in a browser.
pub enum ActorInbox {
    /// Messages are queued in the database mailbox and drained by the tab's
    /// HTTP polling. Nothing live to hold here — the variant only records that
    /// this actor's protocol runs in a browser.
    Browser,
    /// Messages are delivered directly to the actix actor's mailbox.
    Provisioned(Addr<ProvisionedActor>),
}

/// Every actor this node delivers to.
///
/// This stays in memory because it cannot be anything else: an `actix::Addr`
/// is a runtime handle with no serialised form. It is rebuilt when actors are
/// respawned at boot.
#[derive(Default)]
pub struct ActorInboxes {
    inboxes: DashMap<Uuid, ActorInbox>,
}

impl ActorInboxes {
    pub fn new() -> Self {
        Self::default()
    }

    /// Point `actor_id`'s traffic at a running actor.
    pub fn insert_provisioned(&self, actor_id: Uuid, addr: Addr<ProvisionedActor>) {
        self.inboxes.insert(actor_id, ActorInbox::Provisioned(addr));
    }

    /// The running actor behind `actor_id`, if it is backend-run. `None` for a
    /// browser actor, or one that failed to start.
    pub fn provisioned(&self, actor_id: &Uuid) -> Option<Addr<ProvisionedActor>> {
        // Resolved and released at once: a `DashMap` guard held across an
        // `.await` would block every other writer to the same shard.
        self.inboxes
            .get(actor_id)
            .and_then(|entry| match entry.value() {
                ActorInbox::Provisioned(addr) => Some(addr.clone()),
                ActorInbox::Browser => None,
            })
    }

    pub fn contains(&self, actor_id: &Uuid) -> bool {
        self.inboxes.contains_key(actor_id)
    }

    /// Take `actor_id`'s inbox away, handing back what it was.
    pub fn remove(&self, actor_id: &Uuid) -> Option<ActorInbox> {
        self.inboxes.remove(actor_id).map(|(_, inbox)| inbox)
    }

    /// Every backend-run actor.
    pub fn provisioned_ids(&self) -> Vec<Uuid> {
        self.inboxes
            .iter()
            .filter(|entry| matches!(entry.value(), ActorInbox::Provisioned(_)))
            .map(|entry| *entry.key())
            .collect()
    }
}

impl InboxDirectory for ActorInboxes {
    fn kind(&self, actor_id: &Uuid) -> Option<InboxKind> {
        self.inboxes.get(actor_id).map(|entry| match entry.value() {
            ActorInbox::Browser => InboxKind::Browser,
            ActorInbox::Provisioned(_) => InboxKind::Provisioned,
        })
    }

    fn register_browser(&self, actor_id: Uuid) {
        self.inboxes.entry(actor_id).or_insert(ActorInbox::Browser);
    }

    fn deliver(&self, actor_id: &Uuid, bytes: Vec<u8>) -> bool {
        match self.provisioned(actor_id) {
            Some(addr) => {
                addr.do_send(IncomingMessage(bytes));
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registering_a_browser_actor_twice_keeps_one_browser_inbox() {
        let inboxes = ActorInboxes::new();
        let id = Uuid::new_v4();

        inboxes.register_browser(id);
        inboxes.register_browser(id);

        assert_eq!(inboxes.kind(&id), Some(InboxKind::Browser));
        assert!(inboxes.provisioned_ids().is_empty());
    }

    #[test]
    fn a_browser_actor_has_no_instance_to_deliver_to() {
        let inboxes = ActorInboxes::new();
        let id = Uuid::new_v4();
        inboxes.register_browser(id);

        assert!(!inboxes.deliver(&id, vec![1]));
        assert!(!inboxes.deliver(&Uuid::new_v4(), vec![1]));
    }

    #[test]
    fn an_unknown_actor_has_no_inbox() {
        assert_eq!(ActorInboxes::new().kind(&Uuid::new_v4()), None);
    }
}
