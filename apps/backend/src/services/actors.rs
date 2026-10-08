// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Actors of any role: the roster, and what a backend-run actor can be asked
//! to do — mint a contact, start a pairing, compare a fingerprint.

use std::sync::Arc;

use async_trait::async_trait;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use derec_library::protocol::{ChannelStatus, DeRecEvent, DeRecFlow};
use tracing::info;
use uuid::Uuid;

use super::ports::{ActorCallError, ActorGateway, ChannelRoutes, InboxDirectory};
use super::ServiceError;
use crate::models::{
    Actor, ActorListing, ContactOptions, ContactRequest, InboxKind, PeerContact, Role,
};
use crate::repositories::actors::ActorRepository;
use crate::repositories::disabled_helpers::DisabledHelperRepository;
use crate::repositories::helper_channels::HelperChannelIndex;
use crate::repositories::mailbox_polls::MailboxPollRepository;
use crate::repositories::protocol_records::ProtocolRecordRepository;
use crate::utils::time::rfc3339_from_unix_ms;

#[async_trait]
pub trait ActorService: Send + Sync {
    /// Every actor on this node, in registration order, with its pairing state.
    async fn list(&self) -> Result<Vec<ActorListing>, ServiceError>;

    /// Have a backend-run actor mint a contact. Replica mode is refused for
    /// the actor's own secret, and beyond the replica-instance limit.
    async fn create_contact(
        &self,
        actor_id: Uuid,
        options: ContactOptions,
    ) -> Result<derec_proto::ContactMessage, ServiceError>;

    /// Have a backend-run actor initiate pairing with `contact`, taking the
    /// role named by `role` (`helper`, the default, or `owner`). Answers the
    /// transient pairing channel id.
    async fn start_pairing(
        &self,
        actor_id: Uuid,
        role: Option<String>,
        contact: PeerContact,
    ) -> Result<u64, ServiceError>;

    /// The actor's own fingerprint for a channel it holds.
    async fn fingerprint(&self, actor_id: Uuid, channel_id: &str) -> Result<String, ServiceError>;

    /// Confirm a channel's fingerprint, promoting the actor's side of it from
    /// `Pending` to `Paired`. A mismatch is refused and leaves it `Pending` —
    /// the man-in-the-middle case, which must reach the operator.
    async fn confirm_fingerprint(
        &self,
        actor_id: Uuid,
        channel_id: &str,
        fingerprint: String,
    ) -> Result<(), ServiceError>;
}

pub struct ActorServiceImpl {
    actors: Arc<dyn ActorRepository>,
    records: Arc<dyn ProtocolRecordRepository>,
    disabled_helpers: Arc<dyn DisabledHelperRepository>,
    helper_channels: Arc<dyn HelperChannelIndex>,
    polls: Arc<dyn MailboxPollRepository>,
    inboxes: Arc<dyn InboxDirectory>,
    gateway: Arc<dyn ActorGateway>,
    routes: Arc<dyn ChannelRoutes>,
}

impl ActorServiceImpl {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        actors: Arc<dyn ActorRepository>,
        records: Arc<dyn ProtocolRecordRepository>,
        disabled_helpers: Arc<dyn DisabledHelperRepository>,
        helper_channels: Arc<dyn HelperChannelIndex>,
        polls: Arc<dyn MailboxPollRepository>,
        inboxes: Arc<dyn InboxDirectory>,
        gateway: Arc<dyn ActorGateway>,
        routes: Arc<dyn ChannelRoutes>,
    ) -> Self {
        Self {
            actors,
            records,
            disabled_helpers,
            helper_channels,
            polls,
            inboxes,
            gateway,
            routes,
        }
    }

    /// The actor with this id, or not found.
    async fn existing(&self, actor_id: &Uuid) -> Result<Actor, ServiceError> {
        self.actors
            .get(actor_id)
            .await?
            .ok_or_else(|| ServiceError::NotFound("actor not found".to_owned()))
    }

    /// The actor with this id, provided it runs on this backend; `refusal`
    /// answers one that does not.
    async fn provisioned(&self, actor_id: &Uuid, refusal: &str) -> Result<Actor, ServiceError> {
        let actor = self.existing(actor_id).await?;
        if self.inboxes.kind(actor_id) != Some(InboxKind::Provisioned) {
            return Err(ServiceError::BadRequest(refusal.to_owned()));
        }
        Ok(actor)
    }

    /// Resolve a provisioned actor and a channel id it holds.
    ///
    /// A channel the actor holds no record of is not found here, before any
    /// protocol call: the SDK would otherwise answer "channel has no shared key
    /// — not yet paired", which reads as an internal fault for what is a wrong
    /// id.
    async fn held_channel(&self, actor_id: &Uuid, channel_id: &str) -> Result<u64, ServiceError> {
        self.provisioned(
            actor_id,
            "browser-managed actors derive their own fingerprints",
        )
        .await?;

        let parsed = channel_id.parse::<u64>().map_err(|_| {
            ServiceError::BadRequest(format!("channel_id `{channel_id}` is not a u64"))
        })?;

        match self.records.holds_channel(actor_id, parsed, None).await {
            Ok(true) => Ok(parsed),
            Ok(false) => Err(ServiceError::NotFound(format!(
                "this actor holds no channel {parsed}; it may not have paired yet"
            ))),
            Err(e) => {
                tracing::error!(actor_id = %actor_id, error = %e, "channel store unreadable");
                Err(ServiceError::Internal(
                    "channel store unavailable".to_owned(),
                ))
            }
        }
    }

    /// The one channel the roster reports for `actor`, and its shared key.
    ///
    /// A helper may hold several channels at once — paired with one owner,
    /// pending with another — and the roster row shows one. The choice is made
    /// from the stored records, so it is the same before and after a restart:
    ///
    /// 1. a `Paired` channel over any other status;
    /// 2. among those, the most recently created;
    /// 3. ties broken by the higher channel id.
    ///
    /// Only channels in the helper channel index are candidates: the index is
    /// written when a pairing *completes*, which is the moment the roster has
    /// always started showing a channel.
    ///
    /// Reads the stores directly rather than asking the actor, so polling the
    /// roster never competes with protocol traffic for the actor's instances.
    async fn primary_channel(&self, actor: &Actor) -> (Option<String>, Option<[u8; 32]>) {
        let Some(indexed) = self.helper_channels.get(&actor.id) else {
            return (None, None);
        };
        if indexed.is_empty() {
            return (None, None);
        }

        let records = match self.records.helper_channels(&actor.id).await {
            Ok(records) => records,
            Err(e) => {
                tracing::warn!(actor_id = %actor.id, error = %e, "channel store unreadable for the roster");
                Vec::new()
            }
        };

        let chosen = records
            .iter()
            .filter(|(_, h)| indexed.iter().any(|id| *id == h.channel_id.0.to_string()))
            .max_by_key(|(_, h)| {
                (
                    h.status == ChannelStatus::Paired,
                    h.created_at,
                    h.channel_id.0,
                )
            });

        let Some((secret_id, record)) = chosen else {
            // Indexed but not (or not readably) stored. Still deterministic:
            // the numerically highest id the index holds.
            let fallback = indexed
                .iter()
                .filter_map(|id| id.parse::<u64>().ok())
                .max()
                .map(|id| id.to_string());
            return (fallback, None);
        };

        let channel_id = record.channel_id.0;
        let shared_key = match actor.role {
            Role::Helper => self
                .records
                .shared_key(&actor.id, *secret_id, channel_id)
                .await
                .ok()
                .flatten(),
            Role::Owner => None,
        };

        (Some(channel_id.to_string()), shared_key)
    }
}

#[async_trait]
impl ActorService for ActorServiceImpl {
    async fn list(&self) -> Result<Vec<ActorListing>, ServiceError> {
        let roster = self.actors.all().await?;

        let mut listings = Vec::with_capacity(roster.len());
        for actor in roster {
            // A store failure degrades the row rather than failing the
            // roster: the list itself is what the front end polls to render,
            // and losing the whole page because a status lookup hiccuped is
            // worse than rendering one row without its channel.
            let (channel_id, shared_key) = self.primary_channel(&actor).await;
            let disabled = self
                .disabled_helpers
                .is_disabled(&actor.id)
                .await
                .unwrap_or(false);
            let browser_managed = self.inboxes.kind(&actor.id) == Some(InboxKind::Browser);
            let last_polled_at = if browser_managed {
                self.polls.last(&actor.id).map(rfc3339_from_unix_ms)
            } else {
                None
            };

            listings.push(ActorListing {
                actor,
                channel_id,
                shared_key,
                disabled,
                browser_managed,
                last_polled_at,
            });
        }
        Ok(listings)
    }

    async fn create_contact(
        &self,
        actor_id: Uuid,
        options: ContactOptions,
    ) -> Result<derec_proto::ContactMessage, ServiceError> {
        let actor = self
            .provisioned(
                &actor_id,
                "browser-managed actors generate their own contacts",
            )
            .await?;
        let contact_mode = parse_contact_mode(options.contact_mode.as_deref())?;
        let replica_for_owner_secret =
            parse_replica_secret(options.replica_for_owner_secret.as_deref())?;

        // The instance must exist before a contact can be minted from it. This
        // is idempotent, so a second replica pairing with the same owner reuses
        // the instance and its shares rather than resetting them.
        if let Some(owner_secret) = replica_for_owner_secret {
            self.gateway
                .ensure_replica_instance(&actor_id, owner_secret)
                .await
                .map_err(|e| ServiceError::from_actor_call("replica instance creation", e))?;
        }

        // The PrePair round-trip that HashedKeys and NoKeys need is
        // auto-accepted by these actors, and the fingerprint confirmation
        // NoKeys then requires is driven by the operator through the
        // fingerprint endpoints — so an unattended fixture serves all three.
        let request = ContactRequest {
            contact_mode,
            nonce: options.nonce,
            replica_for_owner_secret,
        };
        let contact = self
            .gateway
            .create_contact(&actor_id, request)
            .await
            .map_err(|e| ServiceError::from_actor_call("contact creation", e))?;

        // The first message on a new contact arrives on an id no store has
        // seen, so gRPC ingress needs a placeholder route for it. Pins expire,
        // and are capped per actor.
        if actor.advertises_grpc() {
            self.routes.pin(contact.channel_id, actor_id);
        }
        info!(actor_id = %actor_id, channel_id = %contact.channel_id, "actor contact created");
        Ok(contact)
    }

    async fn start_pairing(
        &self,
        actor_id: Uuid,
        role: Option<String>,
        contact: PeerContact,
    ) -> Result<u64, ServiceError> {
        let sender_kind = parse_pairing_role(role.as_deref())?;
        let actor = self
            .provisioned(
                &actor_id,
                "browser-managed actors initiate pairing themselves",
            )
            .await?;
        let contact = contact_message(&contact)?;
        let channel_id = contact.channel_id;

        let flow = DeRecFlow::Pairing {
            kind: sender_kind,
            contact,
            // The provisioned actor carries no app-level label for the
            // initiator; the peer's `communication_info` arrives on the wire
            // with the pair-request and is what the responder side stores.
            peer_communication_info: std::collections::HashMap::new(),
        };

        // The response arrives on the id the *peer* minted, so a
        // gRPC-reachable actor must be routable on it before the request goes
        // out — pinning after `start` returns would race a fast reply. The pin
        // is a claim *alongside* any other actor's on the same id, never
        // instead of it, and is taken back if the flow does not start.
        let pinned = actor.advertises_grpc();
        if pinned {
            self.routes.pin(channel_id, actor_id);
        }
        let unpin = || {
            if pinned {
                self.routes.unpin(channel_id, actor_id);
            }
        };

        let events = match self.gateway.start_flow(&actor_id, flow).await {
            Ok(events) => events,
            Err(e) => {
                unpin();
                return Err(ServiceError::from_actor_call("pairing", e));
            }
        };

        // `start` reports the dispatched handshake as a `PairingStarted`
        // event. This is the transient pairing id; the handshake rotates to a
        // long-term id that surfaces on `PairingCompleted`.
        let started = events.iter().find_map(|e| match e {
            DeRecEvent::PairingStarted { channel_id, .. } => Some(channel_id.0),
            _ => None,
        });

        match started {
            Some(pairing_channel_id) => {
                info!(
                    actor_id = %actor_id,
                    role = ?sender_kind,
                    channel_id = pairing_channel_id,
                    "actor started pairing as initiator"
                );
                Ok(pairing_channel_id)
            }
            None => {
                unpin();
                tracing::error!(actor_id = %actor_id, "pairing emitted no PairingStarted event");
                Err(ServiceError::Internal("pairing did not start".to_owned()))
            }
        }
    }

    async fn fingerprint(&self, actor_id: Uuid, channel_id: &str) -> Result<String, ServiceError> {
        let channel_id = self.held_channel(&actor_id, channel_id).await?;
        self.gateway
            .fingerprint(&actor_id, channel_id)
            .await
            .map_err(fingerprint_error)
    }

    async fn confirm_fingerprint(
        &self,
        actor_id: Uuid,
        channel_id: &str,
        fingerprint: String,
    ) -> Result<(), ServiceError> {
        let parsed = self.held_channel(&actor_id, channel_id).await?;

        let confirmed = self
            .gateway
            .verify_fingerprint(&actor_id, parsed, fingerprint)
            .await
            .map_err(fingerprint_error)?;
        if !confirmed {
            return Err(ServiceError::FingerprintMismatch);
        }

        info!(actor_id = %actor_id, channel_id = %channel_id, "actor confirmed fingerprint");
        Ok(())
    }
}

/// A fingerprint call on a channel the actor does hold, refused.
///
/// The one input error left once the channel is known to exist is a channel
/// whose key has not arrived yet — a pairing still in its handshake. That is a
/// state the caller can wait out (a conflict), not a fault.
fn fingerprint_error(e: ActorCallError) -> ServiceError {
    match e {
        ActorCallError::Protocol(derec_library::Error::InvalidInput(reason)) => {
            ServiceError::Conflict(format!("channel is not ready for a fingerprint: {reason}"))
        }
        other => ServiceError::from_actor_call("fingerprint", other),
    }
}

/// How a provisioned actor should deliver its public keys in a contact.
///
/// `inline_keys` is the only mode usable with no further exchange.
/// `hashed_keys` commits to the keys and has the scanner fetch them over
/// `PrePair`; `no_keys` commits to nothing and leaves the channel `Pending`
/// until both sides confirm a fingerprint out of band.
fn parse_contact_mode(raw: Option<&str>) -> Result<derec_proto::ContactMode, ServiceError> {
    match raw {
        None | Some("inline_keys") => Ok(derec_proto::ContactMode::InlineKeys),
        Some("hashed_keys") => Ok(derec_proto::ContactMode::HashedKeys),
        Some("no_keys") => Ok(derec_proto::ContactMode::NoKeys),
        Some(other) => Err(ServiceError::BadRequest(format!(
            "unknown contact mode `{other}` — expected `inline_keys`, `hashed_keys` or `no_keys`"
        ))),
    }
}

/// The mirrored owner's secret id, if one was supplied.
///
/// Absent means "no replica pairing". Present but empty is not the same thing
/// — a client that built the query from an unpopulated value would otherwise
/// silently mint an ordinary contact — so any value present that isn't a
/// valid non-zero `u64` is refused. Zero is refused because no SDK mints it:
/// it is the proto3 default, so it can only mean a field the caller forgot.
fn parse_replica_secret(raw: Option<&str>) -> Result<Option<u64>, ServiceError> {
    match raw {
        None => Ok(None),
        Some(raw) => match raw.parse::<u64>() {
            Ok(0) | Err(_) => Err(ServiceError::BadRequest(
                "replica_for_owner_secret must be a non-zero u64 as a decimal string".to_owned(),
            )),
            Ok(secret) => Ok(Some(secret)),
        },
    }
}

/// The role a backend-run actor declares when it initiates pairing.
///
/// Pairing is bi-directional: the initiator declares its own role on the wire
/// and the responder takes the complement. Provisioned actors default to
/// helper, their usual job, but either role can be driven for testing.
fn parse_pairing_role(raw: Option<&str>) -> Result<derec_proto::SenderKind, ServiceError> {
    match raw {
        None | Some("helper") => Ok(derec_proto::SenderKind::Helper),
        Some("owner") => Ok(derec_proto::SenderKind::Owner),
        Some(other) => Err(ServiceError::BadRequest(format!(
            "unknown pairing role `{other}` — expected `owner` or `helper`"
        ))),
    }
}

/// Turn a caller-supplied contact into the SDK's `ContactMessage`, refusing
/// anything malformed before the SDK sees it.
fn contact_message(contact: &PeerContact) -> Result<derec_proto::ContactMessage, ServiceError> {
    let channel_id: u64 = contact.channel_id.parse().map_err(|_| {
        ServiceError::BadRequest("invalid channel_id: expected a decimal u64 string".to_owned())
    })?;
    let nonce: u64 = contact.nonce.parse().map_err(|_| {
        ServiceError::BadRequest("invalid nonce: expected a decimal u64 string".to_owned())
    })?;

    // Key material is absent under HashedKeys / NoKeys, so decode only what
    // the initiator actually sent.
    let decode = |field: &Option<String>| -> Result<Option<Vec<u8>>, ServiceError> {
        field
            .as_deref()
            .map(|v| {
                URL_SAFE_NO_PAD.decode(v).map_err(|_| {
                    ServiceError::BadRequest("invalid contact key material".to_owned())
                })
            })
            .transpose()
    };
    let mlkem_encapsulation_key = decode(&contact.mlkem_encapsulation_key)?;
    let ecies_public_key = decode(&contact.ecies_public_key)?;
    let contact_binding_hash = decode(&contact.contact_binding_hash)?;

    if contact.endpoints.is_empty() {
        return Err(ServiceError::BadRequest(
            "the contact advertises no endpoint: set `supported_transports`".to_owned(),
        ));
    }

    Ok(derec_proto::ContactMessage {
        channel_id,
        nonce,
        supported_transports: contact.endpoints.clone(),
        contact_mode: contact.contact_mode,
        mlkem_encapsulation_key,
        ecies_public_key,
        contact_binding_hash,
        timestamp: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TransportMode;
    use crate::repositories::helper_channels::InMemoryHelperChannelIndex;
    use crate::repositories::mailbox_polls::InMemoryMailboxPolls;
    use crate::services::test_fakes::{
        helper_record, FakeActorRepository, FakeDisabledHelpers, FakeGateway, FakeInboxes,
        FakeProtocolRecords, FakeRoutes,
    };

    struct Fixture {
        actors: Arc<FakeActorRepository>,
        records: Arc<FakeProtocolRecords>,
        disabled: Arc<FakeDisabledHelpers>,
        channels: Arc<InMemoryHelperChannelIndex>,
        polls: Arc<InMemoryMailboxPolls>,
        inboxes: Arc<FakeInboxes>,
        gateway: Arc<FakeGateway>,
        routes: Arc<FakeRoutes>,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                actors: Arc::new(FakeActorRepository::default()),
                records: Arc::new(FakeProtocolRecords::default()),
                disabled: Arc::new(FakeDisabledHelpers::default()),
                channels: Arc::new(InMemoryHelperChannelIndex::new()),
                polls: Arc::new(InMemoryMailboxPolls::new()),
                inboxes: Arc::new(FakeInboxes::default()),
                gateway: Arc::new(FakeGateway::default()),
                routes: Arc::new(FakeRoutes::default()),
            }
        }

        fn service(&self) -> ActorServiceImpl {
            ActorServiceImpl::new(
                self.actors.clone(),
                self.records.clone(),
                self.disabled.clone(),
                self.channels.clone(),
                self.polls.clone(),
                self.inboxes.clone(),
                self.gateway.clone(),
                self.routes.clone(),
            )
        }

        /// A helper running on this backend.
        fn provisioned(&self, mode: TransportMode) -> Actor {
            let actor = Actor::mint(
                Role::Helper,
                "Alex",
                "http://localhost:5000",
                "localhost:50051",
                mode,
            );
            self.actors.insert(actor.clone());
            self.inboxes.provisioned(actor.id);
            actor
        }

        /// An owner running in a browser.
        fn browser_owner(&self) -> Actor {
            let actor = Actor::mint(
                Role::Owner,
                "Alice",
                "http://localhost:5000",
                "localhost:50051",
                TransportMode::Http,
            );
            self.actors.insert(actor.clone());
            self.inboxes.register_browser(actor.id);
            actor
        }
    }

    fn peer_contact() -> PeerContact {
        PeerContact {
            channel_id: "77".to_owned(),
            nonce: "5".to_owned(),
            endpoints: vec![derec_proto::TransportProtocol {
                uri: "http://peer/derec/x".to_owned(),
                protocol: derec_proto::Protocol::Https as i32,
            }],
            ..PeerContact::default()
        }
    }

    // ── Roster ──────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn the_roster_reports_the_paired_channel_over_a_newer_pending_one() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);
        fixture
            .channels
            .replace(alex.id, vec!["1".to_owned(), "2".to_owned()]);
        fixture.records.set_helper_channels(
            alex.id,
            vec![
                (9, helper_record(1, ChannelStatus::Paired, 100)),
                (9, helper_record(2, ChannelStatus::Pending, 200)),
            ],
        );
        fixture.records.set_shared_key(alex.id, 9, 1, [4u8; 32]);

        let listing = fixture.service().list().await.expect("lists");

        assert_eq!(listing[0].channel_id.as_deref(), Some("1"));
        assert_eq!(listing[0].shared_key, Some([4u8; 32]));
    }

    #[tokio::test]
    async fn a_channel_indexed_but_not_stored_falls_back_to_the_highest_id_without_a_key() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);
        fixture
            .channels
            .replace(alex.id, vec!["5".to_owned(), "12".to_owned()]);

        let listing = fixture.service().list().await.expect("lists");

        assert_eq!(listing[0].channel_id.as_deref(), Some("12"));
        assert_eq!(listing[0].shared_key, None);
    }

    #[tokio::test]
    async fn an_owner_never_reports_a_shared_key() {
        let fixture = Fixture::new();
        let alice = fixture.browser_owner();
        fixture.channels.replace(alice.id, vec!["1".to_owned()]);
        fixture.records.set_helper_channels(
            alice.id,
            vec![(9, helper_record(1, ChannelStatus::Paired, 1))],
        );
        fixture.records.set_shared_key(alice.id, 9, 1, [4u8; 32]);

        let listing = fixture.service().list().await.expect("lists");

        assert_eq!(listing[0].channel_id.as_deref(), Some("1"));
        assert_eq!(listing[0].shared_key, None);
    }

    #[tokio::test]
    async fn only_a_browser_actor_reports_when_it_last_polled() {
        let fixture = Fixture::new();
        let alice = fixture.browser_owner();
        let alex = fixture.provisioned(TransportMode::Http);
        fixture.polls.record(alice.id, 0);
        fixture.polls.record(alex.id, 0);

        let listing = fixture.service().list().await.expect("lists");

        assert!(listing[0].browser_managed);
        assert_eq!(
            listing[0].last_polled_at.as_deref(),
            Some("1970-01-01T00:00:00.000Z")
        );
        assert!(!listing[1].browser_managed);
        assert_eq!(listing[1].last_polled_at, None);
    }

    #[tokio::test]
    async fn an_unreadable_roster_is_an_internal_error() {
        let fixture = Fixture::new();
        fixture.actors.fail();

        let error = fixture.service().list().await.expect_err("fails");

        assert_eq!(
            error,
            ServiceError::Internal("actor registry unavailable".to_owned())
        );
    }

    // ── Contacts ────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_contact_minted_by_a_grpc_actor_is_pinned_for_its_first_message() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Grpc);

        let contact = fixture
            .service()
            .create_contact(alex.id, ContactOptions::default())
            .await
            .expect("mints");

        assert_eq!(fixture.routes.pins(), vec![(contact.channel_id, alex.id)]);
    }

    #[tokio::test]
    async fn a_contact_minted_by_an_http_actor_needs_no_pin() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);

        fixture
            .service()
            .create_contact(alex.id, ContactOptions::default())
            .await
            .expect("mints");

        assert!(fixture.routes.pins().is_empty());
    }

    #[tokio::test]
    async fn a_browser_actor_is_refused_before_its_options_are_read() {
        let fixture = Fixture::new();
        let alice = fixture.browser_owner();
        let options = ContactOptions {
            contact_mode: Some("bogus".to_owned()),
            ..ContactOptions::default()
        };

        let error = fixture
            .service()
            .create_contact(alice.id, options)
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::BadRequest(
                "browser-managed actors generate their own contacts".to_owned()
            )
        );
    }

    #[tokio::test]
    async fn an_unknown_actor_is_not_found() {
        let fixture = Fixture::new();

        let error = fixture
            .service()
            .create_contact(Uuid::new_v4(), ContactOptions::default())
            .await
            .expect_err("refused");

        assert_eq!(error, ServiceError::NotFound("actor not found".to_owned()));
    }

    #[tokio::test]
    async fn an_unknown_contact_mode_is_refused() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);
        let options = ContactOptions {
            contact_mode: Some("bogus".to_owned()),
            ..ContactOptions::default()
        };

        let error = fixture
            .service()
            .create_contact(alex.id, options)
            .await
            .expect_err("refused");

        assert!(
            matches!(error, ServiceError::BadRequest(m) if m.starts_with("unknown contact mode `bogus`"))
        );
    }

    #[tokio::test]
    async fn a_zero_or_empty_replica_secret_is_refused_rather_than_ignored() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);

        for raw in ["", "0", "x"] {
            let options = ContactOptions {
                replica_for_owner_secret: Some(raw.to_owned()),
                ..ContactOptions::default()
            };
            let error = fixture
                .service()
                .create_contact(alex.id, options)
                .await
                .expect_err("refused");
            assert_eq!(
                error,
                ServiceError::BadRequest(
                    "replica_for_owner_secret must be a non-zero u64 as a decimal string"
                        .to_owned()
                ),
                "{raw:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_replica_contact_ensures_the_replica_instance_first() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);
        let options = ContactOptions {
            replica_for_owner_secret: Some("42".to_owned()),
            ..ContactOptions::default()
        };

        fixture
            .service()
            .create_contact(alex.id, options)
            .await
            .expect("mints");

        assert_eq!(fixture.gateway.replicas_ensured(), vec![(alex.id, 42)]);
        assert_eq!(
            fixture.gateway.contact_requests()[0].replica_for_owner_secret,
            Some(42)
        );
    }

    #[tokio::test]
    async fn the_replica_limit_is_a_conflict() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);
        fixture
            .gateway
            .fail_next(ActorCallError::ReplicaLimitReached { max: 16 });
        let options = ContactOptions {
            replica_for_owner_secret: Some("42".to_owned()),
            ..ContactOptions::default()
        };

        let error = fixture
            .service()
            .create_contact(alex.id, options)
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::Conflict(
                "this actor already mirrors 16 owners, the most it will hold".to_owned()
            )
        );
        assert!(
            fixture.gateway.contact_requests().is_empty(),
            "no contact is minted"
        );
    }

    // ── Pairing ─────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn pairing_answers_the_transient_channel_id() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);
        fixture.gateway.pairing_starts_on(91);

        let channel = fixture
            .service()
            .start_pairing(alex.id, None, peer_contact())
            .await
            .expect("starts");

        assert_eq!(channel, 91);
    }

    #[tokio::test]
    async fn an_unknown_role_is_refused_before_the_actor_is_looked_up() {
        let fixture = Fixture::new();

        let error = fixture
            .service()
            .start_pairing(Uuid::new_v4(), Some("admin".to_owned()), peer_contact())
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::BadRequest(
                "unknown pairing role `admin` — expected `owner` or `helper`".to_owned()
            )
        );
    }

    #[tokio::test]
    async fn a_grpc_actor_is_pinned_before_the_request_and_unpinned_when_it_fails() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Grpc);
        fixture.gateway.fail_next(ActorCallError::PeerUnreachable);

        let error = fixture
            .service()
            .start_pairing(alex.id, None, peer_contact())
            .await
            .expect_err("fails");

        assert_eq!(
            error,
            ServiceError::BadGateway("pairing failed: the peer could not be reached".to_owned())
        );
        assert_eq!(fixture.routes.pins(), vec![(77, alex.id)]);
        assert_eq!(fixture.routes.unpins(), vec![(77, alex.id)]);
    }

    #[tokio::test]
    async fn a_pairing_that_reports_no_start_is_an_internal_error_and_unpins() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Grpc);

        let error = fixture
            .service()
            .start_pairing(alex.id, None, peer_contact())
            .await
            .expect_err("fails");

        assert_eq!(
            error,
            ServiceError::Internal("pairing did not start".to_owned())
        );
        assert_eq!(fixture.routes.unpins(), vec![(77, alex.id)]);
    }

    #[tokio::test]
    async fn a_contact_naming_no_endpoint_is_refused() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);
        let contact = PeerContact {
            endpoints: Vec::new(),
            ..peer_contact()
        };

        let error = fixture
            .service()
            .start_pairing(alex.id, None, contact)
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::BadRequest(
                "the contact advertises no endpoint: set `supported_transports`".to_owned()
            )
        );
    }

    #[tokio::test]
    async fn malformed_contact_ids_and_keys_are_refused() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);
        let cases = [
            (
                PeerContact {
                    channel_id: "x".to_owned(),
                    ..peer_contact()
                },
                "invalid channel_id: expected a decimal u64 string",
            ),
            (
                PeerContact {
                    nonce: "-1".to_owned(),
                    ..peer_contact()
                },
                "invalid nonce: expected a decimal u64 string",
            ),
            (
                PeerContact {
                    ecies_public_key: Some("!!".to_owned()),
                    ..peer_contact()
                },
                "invalid contact key material",
            ),
        ];

        for (contact, message) in cases {
            let error = fixture
                .service()
                .start_pairing(alex.id, None, contact)
                .await
                .expect_err("refused");
            assert_eq!(error, ServiceError::BadRequest(message.to_owned()));
        }
    }

    // ── Fingerprints ────────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_channel_the_actor_does_not_hold_is_not_found_before_any_protocol_call() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);

        let error = fixture
            .service()
            .fingerprint(alex.id, "8")
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::NotFound(
                "this actor holds no channel 8; it may not have paired yet".to_owned()
            )
        );
    }

    #[tokio::test]
    async fn a_channel_id_that_is_not_a_number_is_refused() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);

        let error = fixture
            .service()
            .fingerprint(alex.id, "abc")
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::BadRequest("channel_id `abc` is not a u64".to_owned())
        );
    }

    #[tokio::test]
    async fn a_held_channel_answers_the_actors_fingerprint() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);
        fixture.records.hold(alex.id, 8);

        let fingerprint = fixture
            .service()
            .fingerprint(alex.id, "8")
            .await
            .expect("answers");

        assert_eq!(fingerprint, "fingerprint-8");
    }

    #[tokio::test]
    async fn a_channel_without_its_key_yet_is_a_conflict_to_wait_out() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);
        fixture.records.hold(alex.id, 8);
        fixture.gateway.fail_next(ActorCallError::Protocol(
            derec_library::Error::InvalidInput("no key"),
        ));

        let error = fixture
            .service()
            .fingerprint(alex.id, "8")
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::Conflict("channel is not ready for a fingerprint: no key".to_owned())
        );
    }

    #[tokio::test]
    async fn a_mismatched_fingerprint_is_refused_as_a_mismatch() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);
        fixture.records.hold(alex.id, 8);

        let error = fixture
            .service()
            .confirm_fingerprint(alex.id, "8", "wrong".to_owned())
            .await
            .expect_err("refused");

        assert_eq!(error, ServiceError::FingerprintMismatch);
    }

    #[tokio::test]
    async fn a_matching_fingerprint_confirms() {
        let fixture = Fixture::new();
        let alex = fixture.provisioned(TransportMode::Http);
        fixture.records.hold(alex.id, 8);

        fixture
            .service()
            .confirm_fingerprint(alex.id, "8", "fingerprint-8".to_owned())
            .await
            .expect("confirms");
    }

    #[tokio::test]
    async fn a_browser_actor_derives_its_own_fingerprints() {
        let fixture = Fixture::new();
        let alice = fixture.browser_owner();

        let error = fixture
            .service()
            .fingerprint(alice.id, "8")
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::BadRequest(
                "browser-managed actors derive their own fingerprints".to_owned()
            )
        );
    }
}
