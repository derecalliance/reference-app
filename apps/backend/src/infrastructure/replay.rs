// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Recognising a message delivered twice, or delivered back to its sender.
//!
//! From SDK 0.0.11 this is the application's job. `process` handles every
//! copy of a message within the inbound window, and both ends of a channel
//! encrypt under one key, so a message reflected to the actor that sent it
//! decrypts there as the peer's. Nothing a copy carries in the clear tells it
//! apart — sequence, trace id and protocol version are unauthenticated, and an
//! envelope can be re-encoded — so copies are recognised by
//! [`derec_library::derec_message::message_id`], a hash of the encrypted
//! message alone.
//!
//! The library's contract: keep the id of every envelope sent and of every one
//! `process` accepted until `max(sent or received at, its timestamp) + the
//! inbound window`, and drop an inbound envelope whose id is kept.
//!
//! The contract also asks for the record to survive a restart: an id kept
//! only in memory would let a copy replayed just after one be processed again.
//! Each actor checks its own log in memory, shared by its transport and its
//! inbound path, and writes every id through to the database
//! ([`SeenMessageRepository`]), from which the log is restored when the actor
//! starts. The write is not awaited by the message it records, so a crash in
//! the moment between the two can still lose one id.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use derec_library::derec_message::message_id;
use uuid::Uuid;

use crate::models::SeenEnvelope;
use crate::repositories::seen_messages::SeenMessageRepository;
use crate::utils::time::now_unix_secs;

/// Now, in the unsigned seconds `message_id` reports.
fn now_secs() -> u64 {
    u64::try_from(now_unix_secs()).unwrap_or(0)
}

/// Where an actor's log is written through to.
struct Persistence {
    store: Arc<dyn SeenMessageRepository>,
    actor_id: Uuid,
}

/// One actor's log of the messages it sent or accepted.
pub struct ReplayGuard {
    /// Envelope id → when it may be forgotten, in Unix seconds.
    seen: Mutex<HashMap<[u8; 32], u64>>,
    /// The inbound window, `inbound_message`, in seconds. Atomic because a
    /// reconfigure changes it while the transport holding this log lives on.
    window_secs: AtomicU64,
    /// The current time in Unix seconds; replaced in tests.
    clock: fn() -> u64,
    /// `None` keeps the log in memory only, for fixtures.
    persistence: Option<Persistence>,
}

impl std::fmt::Debug for ReplayGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReplayGuard")
            .field("window_secs", &self.window_secs)
            .field("persisted", &self.persistence.is_some())
            .finish_non_exhaustive()
    }
}

/// A log with no window, for fixtures that never set one: an id is kept only
/// within the second it was remembered in.
impl Default for ReplayGuard {
    fn default() -> Self {
        Self::new(0)
    }
}

impl ReplayGuard {
    /// A log kept in memory only.
    pub fn new(window_secs: u64) -> Self {
        Self::with_clock(window_secs, now_secs)
    }

    /// `actor_id`'s log, holding what it had remembered before a restart and
    /// writing what it remembers from now on to `store`.
    pub fn persisted(
        window_secs: u64,
        store: Arc<dyn SeenMessageRepository>,
        actor_id: Uuid,
        restored: &[SeenEnvelope],
    ) -> Self {
        let mut guard = Self::new(window_secs);
        guard.persistence = Some(Persistence { store, actor_id });
        if let Ok(seen) = guard.seen.get_mut() {
            seen.extend(restored.iter().map(|s| (s.id, s.expires_at)));
        }
        guard
    }

    fn with_clock(window_secs: u64, clock: fn() -> u64) -> Self {
        Self {
            seen: Mutex::new(HashMap::new()),
            window_secs: AtomicU64::new(window_secs),
            clock,
            persistence: None,
        }
    }

    /// Follow a change of the actor's inbound window.
    pub fn set_window(&self, window_secs: u64) {
        self.window_secs.store(window_secs, Ordering::Relaxed);
    }

    /// Whether `bytes` is a copy of a message this actor already sent or
    /// accepted. Bytes that are not an envelope are never a copy: `process`
    /// refuses them on its own and says why.
    pub fn is_copy(&self, bytes: &[u8]) -> bool {
        let Ok(id) = message_id(bytes) else {
            return false;
        };
        let now = (self.clock)();
        self.seen
            .lock()
            .map(|seen| seen.get(&id.id).is_some_and(|&expires| expires >= now))
            .unwrap_or(false)
    }

    /// Remember `bytes`: sent by this actor, or accepted by `process`.
    pub fn remember(&self, bytes: &[u8]) {
        let Ok(id) = message_id(bytes) else {
            return;
        };
        let now = (self.clock)();
        let expires = now.max(id.timestamp) + self.window_secs.load(Ordering::Relaxed);
        if let Ok(mut seen) = self.seen.lock() {
            // Expired ids go on every write, so the log never outgrows one window.
            seen.retain(|_, &mut until| until >= now);
            seen.insert(id.id, expires);
        }
        self.persist(
            SeenEnvelope {
                id: id.id,
                expires_at: expires,
            },
            now,
        );
    }

    /// Write `seen` through to the database, off the message's own path.
    fn persist(&self, seen: SeenEnvelope, now: u64) {
        let Some(persistence) = &self.persistence else {
            return;
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::warn!(actor_id = %persistence.actor_id, "no runtime to record a message id on; kept in memory only");
            return;
        };
        let store = Arc::clone(&persistence.store);
        let actor_id = persistence.actor_id;
        runtime.spawn(async move {
            if let Err(e) = store.remember(&actor_id, seen, now).await {
                tracing::warn!(
                    actor_id = %actor_id,
                    error = %e,
                    "could not record a message id; a copy replayed after a restart would not be recognised"
                );
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use derec_proto::DeRecMessage;
    use prost::Message;

    fn envelope(body: &[u8], timestamp: i64) -> Vec<u8> {
        let mut message = DeRecMessage {
            message: body.to_vec(),
            timestamp: Some(Default::default()),
            ..Default::default()
        };
        if let Some(sent_at) = message.timestamp.as_mut() {
            sent_at.seconds = timestamp;
        }
        message.encode_to_vec()
    }

    #[test]
    fn a_remembered_message_is_a_copy_and_another_is_not() {
        let guard = ReplayGuard::new(30);
        let now = now_secs() as i64;
        guard.remember(&envelope(b"sealed", now));

        assert!(guard.is_copy(&envelope(b"sealed", now)));
        // Re-stamped in the clear, it is still the same message.
        assert!(guard.is_copy(&envelope(b"sealed", now + 1)));
        assert!(!guard.is_copy(&envelope(b"other", now)));
    }

    #[test]
    fn an_id_is_kept_for_one_window_from_the_later_of_now_and_its_timestamp() {
        static NOW: AtomicU64 = AtomicU64::new(100);
        let guard = ReplayGuard::with_clock(30, || NOW.load(Ordering::Relaxed));
        guard.remember(&envelope(b"sealed", 120));

        NOW.store(150, Ordering::Relaxed);
        assert!(guard.is_copy(&envelope(b"sealed", 120)));
        NOW.store(151, Ordering::Relaxed);
        assert!(!guard.is_copy(&envelope(b"sealed", 120)));
    }

    #[test]
    fn a_restored_log_still_knows_what_was_remembered_before_the_restart() {
        struct NoStore;
        #[async_trait::async_trait]
        impl SeenMessageRepository for NoStore {
            async fn live(
                &self,
                _: &Uuid,
                _: u64,
            ) -> Result<Vec<SeenEnvelope>, crate::repositories::RepositoryError> {
                Ok(Vec::new())
            }
            async fn remember(
                &self,
                _: &Uuid,
                _: SeenEnvelope,
                _: u64,
            ) -> Result<(), crate::repositories::RepositoryError> {
                Ok(())
            }
        }

        let now = now_secs();
        let sent = envelope(b"sealed", now as i64);
        let Ok(id) = message_id(&sent) else {
            panic!("an envelope with a timestamp has an id");
        };
        let restored = [SeenEnvelope {
            id: id.id,
            expires_at: now + 30,
        }];

        let guard = ReplayGuard::persisted(30, Arc::new(NoStore), Uuid::new_v4(), &restored);

        assert!(guard.is_copy(&sent));
        assert!(!guard.is_copy(&envelope(b"other", now as i64)));
    }

    #[test]
    fn bytes_that_are_not_an_envelope_are_never_a_copy() {
        let guard = ReplayGuard::new(30);
        guard.remember(b"\xff\xff");

        assert!(!guard.is_copy(b"\xff\xff"));
    }
}
