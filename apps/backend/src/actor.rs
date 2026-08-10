use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use actix::prelude::*;
use rand::Rng as _;
use tracing::{error, info, warn};
use uuid::Uuid;

use derec_library::protocol::{
    AutoAcceptPolicy, DeRecChannelStore, DeRecEvent, DeRecFlow, DeRecProtocolBuilder,
};
use derec_library::types::ChannelId;

use crate::models::{Role, UnpairAck};
use crate::state::AppState;
use crate::stores::{
    ActorProtocol, HttpTransport, InMemoryChannelStore, InMemorySecretStore, InMemoryShareStore,
    InMemoryStateStore, InMemoryUserSecretStore,
};

/// Everything needed to build this actor's protocol instance.
#[derive(Clone)]
pub struct ProtocolConfig {
    /// The secret this actor protects as Owner. Helper-role channels share
    /// the same instance and carry their own Owner's id on each share record.
    pub secret_id: u64,
    pub transport_uri: String,
    pub communication_info: HashMap<String, String>,
    pub timeout_secs: u32,
    pub unpair_ack: UnpairAck,
    pub threshold: usize,
    pub keep_versions_count: usize,
    /// Stable per-device replica id. Required for this actor to take part in
    /// any replica-mode pairing; `None` for plain participants.
    pub replica_id: Option<u64>,
    pub http_client: reqwest::Client,
}

/// Build a provisioned actor's protocol instance.
///
/// Provisioned actors are interoperability-test fixtures with no user to
/// prompt, so every inbound action is auto-accepted by the library rather than
/// by a hand-rolled accept loop.
pub fn build_protocol(config: &ProtocolConfig) -> Result<ActorProtocol, derec_library::Error> {
    let mut builder = DeRecProtocolBuilder::new(config.secret_id)
        .with_channel_store(InMemoryChannelStore::default())
        .with_share_store(InMemoryShareStore::default())
        .with_secret_store(InMemorySecretStore::default())
        .with_user_secret_store(InMemoryUserSecretStore::default())
        .with_state_store(InMemoryStateStore::default())
        .with_transport(HttpTransport::new(config.http_client.clone()))
        .with_own_transport(config.transport_uri.as_str())
        .with_threshold(config.threshold)
        .with_keep_versions_count(config.keep_versions_count)
        .with_timeout(Duration::from_secs(config.timeout_secs as u64))
        .with_communication_info(config.communication_info.clone())
        .with_unpair_ack(config.unpair_ack.to_library())
        .with_auto_accept(AutoAcceptPolicy::all());

    if let Some(replica_id) = config.replica_id {
        builder = builder.with_replica_id(replica_id);
    }

    builder.build()
}

/// A backend-managed protocol participant.
///
/// A `DeRecProtocol` instance is bound to one `secret_id` because that is the
/// secret it protects as Owner. Helper-role channels live in the same
/// instance: shares are separated by `channel_id` and each carries its own
/// Owner's `secret_id` on the record, so one actor serves many owners without
/// needing an instance per relationship.
pub struct ProvisionedActor {
    /// `None` only while a call has borrowed it for an async step.
    protocol: Option<ActorProtocol>,
    actor_id: Uuid,
    session_id: Uuid,
    role: Role,
    state: Arc<AppState>,
}

impl ProvisionedActor {
    pub fn new(
        protocol: ActorProtocol,
        actor_id: Uuid,
        session_id: Uuid,
        role: Role,
        state: Arc<AppState>,
    ) -> Self {
        Self {
            protocol: Some(protocol),
            actor_id,
            session_id,
            role,
            state,
        }
    }

    fn handle_events(&mut self, events: &[DeRecEvent]) {
        for event in events {
            match event {
                DeRecEvent::PairingCompleted {
                    channel_id,
                    pairing_channel_id,
                    peer_communication_info,
                    ..
                } => {
                    // The handshake atomically rotates to a new long-term id;
                    // the library refuses traffic on the transient one from
                    // here on, so all state keys on the new value.
                    let cid = channel_id.0.to_string();
                    let peer_name = peer_communication_info
                        .get("name")
                        .cloned()
                        .unwrap_or_default();

                    match self.role {
                        Role::Participant => {
                            self.state
                                .participant_channels
                                .entry(self.actor_id)
                                .or_default()
                                .push(cid);

                            // Channels are deliberately *not* auto-linked here.
                            // Deciding that a new channel belongs to an owner we
                            // already help is an authentication step, and no
                            // field on the wire carries a trustworthy identity —
                            // a matching display name least of all. An operator
                            // links explicitly via the link endpoint.
                            info!(
                                session_id = %self.session_id,
                                actor_id = %self.actor_id,
                                channel_id = channel_id.0,
                                pairing_channel_id = pairing_channel_id.0,
                                peer_name = %peer_name,
                                "participant pairing complete — channel recorded"
                            );
                        }
                        Role::Replica => {
                            self.state
                                .replica_channels
                                .entry(self.actor_id)
                                .or_default()
                                .push(cid);
                            info!(
                                session_id = %self.session_id,
                                actor_id = %self.actor_id,
                                channel_id = channel_id.0,
                                pairing_channel_id = pairing_channel_id.0,
                                "replica pairing complete — channel recorded"
                            );
                        }
                        Role::Owner => {}
                    }
                }

                DeRecEvent::ReplicaPaired {
                    channel_id,
                    peer_replica_id,
                } => {
                    info!(
                        session_id = %self.session_id,
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        peer_replica_id = peer_replica_id,
                        "replica pair handshake complete"
                    );
                }

                DeRecEvent::ReplicaSecretReceived {
                    channel_id,
                    from_replica_id,
                    version,
                    shares,
                    ..
                } => {
                    info!(
                        session_id = %self.session_id,
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        from_replica_id = from_replica_id,
                        version = version,
                        share_count = shares.len(),
                        "replica secret sync received"
                    );
                }

                DeRecEvent::ReplicaSecretAcked {
                    channel_id,
                    version,
                    status,
                    memo,
                    ..
                } => {
                    info!(
                        session_id = %self.session_id,
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        version = version,
                        status = status,
                        memo = %memo,
                        "replica secret sync acknowledged"
                    );
                }

                DeRecEvent::AutoAccepted {
                    channel_id,
                    action_kind,
                } => {
                    info!(
                        session_id = %self.session_id,
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        action = ?action_kind,
                        "auto-accepted inbound action"
                    );
                }

                // With `AutoAcceptPolicy::all()` the library accepts every
                // inbound action itself, so reaching here means a flow was
                // added that the policy does not yet cover.
                DeRecEvent::ActionRequired { channel_id, .. } => {
                    warn!(
                        session_id = %self.session_id,
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        "ActionRequired surfaced despite auto-accept-all; action dropped"
                    );
                }

                DeRecEvent::Unpaired { channel_id } => {
                    let cid = channel_id.0.to_string();
                    // Drop the channel from the per-actor index so the
                    // session-status enrichment stops reporting this actor
                    // as paired on a channel that no longer exists.
                    if let Some(mut entry) = self.state.participant_channels.get_mut(&self.actor_id)
                    {
                        entry.retain(|c| c != &cid);
                    }
                    if let Some(mut entry) = self.state.replica_channels.get_mut(&self.actor_id) {
                        entry.retain(|c| c != &cid);
                    }
                    info!(
                        session_id = %self.session_id,
                        actor_id = %self.actor_id,
                        channel_id = channel_id.0,
                        "channel torn down via unpair flow"
                    );
                }

                _ => {}
            }
        }
    }
}

impl Actor for ProvisionedActor {
    type Context = Context<Self>;

    fn started(&mut self, _ctx: &mut Self::Context) {
        info!(
            session_id = %self.session_id,
            actor_id = %self.actor_id,
            role = ?self.role,
            "provisioned actor started"
        );
    }
}

/// Incoming protocol bytes from a peer. Routed to the instance that owns the
/// envelope's channel, then processed after a random delay.
#[derive(Message)]
#[rtype(result = "()")]
pub struct IncomingMessage(pub Vec<u8>);

// Delayed so concurrent messages from the same sender don't race through the
// protocol in lockstep.
#[derive(Message)]
#[rtype(result = "()")]
struct ProcessDelayed(Vec<u8>);

/// Create an out-of-band contact for `secret_id`, instantiating the protocol
/// for that secret if this actor has not seen it before.
#[derive(Message)]
#[rtype(result = "Result<derec_proto::ContactMessage, derec_library::Error>")]
pub struct CreateContactMsg {
    pub contact_mode: derec_proto::ContactMode,
    pub nonce: Option<u64>,
}

#[derive(Message)]
#[rtype(result = "Result<Vec<DeRecEvent>, derec_library::Error>")]
pub struct StartFlowMsg {
    pub flow: DeRecFlow,
}

#[derive(Message)]
#[rtype(result = "Option<[u8; 32]>")]
pub struct LoadSharedKeyMsg {
    pub channel_id: u64,
}

/// One channel this actor holds, for the operator's link picker.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ChannelSummary {
    pub channel_id: String,
    /// Peer's app-level display name, from `communication_info["name"]`.
    /// Informational only — never an identity the actor acts on.
    pub peer_name: String,
    /// This actor's role on the channel: "owner" or "helper".
    pub role: String,
    /// Channels already linked to this one, itself excluded.
    pub linked_channel_ids: Vec<String>,
}

#[derive(Message)]
#[rtype(result = "Result<Vec<ChannelSummary>, derec_library::Error>")]
pub struct ListChannelsMsg;

/// Record that two channels belong to the same owner. Undirected and
/// idempotent; the operator stands in for the authentication a real helper
/// would perform before making this claim.
#[derive(Message)]
#[rtype(result = "Result<(), derec_library::Error>")]
pub struct LinkChannelsMsg {
    pub channel_id: u64,
    pub link_to_channel_id: u64,
}

#[derive(Message)]
#[rtype(result = "Result<String, derec_library::Error>")]
pub struct GetFingerprintMsg {
    pub channel_id: u64,
}

#[derive(Message)]
#[rtype(result = "Result<bool, derec_library::Error>")]
pub struct VerifyFingerprintMsg {
    pub channel_id: u64,
    pub fingerprint: String,
}

impl Handler<IncomingMessage> for ProvisionedActor {
    type Result = ();

    fn handle(&mut self, msg: IncomingMessage, ctx: &mut Context<Self>) {
        let delay = Duration::from_millis(rand::thread_rng().gen_range(500..=3000));
        ctx.notify_later(ProcessDelayed(msg.0), delay);
    }
}

impl Handler<ProcessDelayed> for ProvisionedActor {
    type Result = ResponseActFuture<Self, ()>;

    fn handle(&mut self, msg: ProcessDelayed, _ctx: &mut Context<Self>) -> Self::Result {
        let Some(mut protocol) = self.protocol.take() else {
            error!(
                session_id = %self.session_id,
                actor_id = %self.actor_id,
                "protocol already borrowed; dropping message"
            );
            return Box::pin(actix::fut::ready(()));
        };
        let bytes = msg.0;

        Box::pin(
            async move {
                let result = protocol.process(&bytes).await;
                (protocol, result)
            }
            .into_actor(self)
            .map(move |(protocol, result), actor, _ctx| {
                actor.protocol = Some(protocol);
                match result {
                    Ok(events) => actor.handle_events(&events),
                    Err(e) => {
                        error!(
                            session_id = %actor.session_id,
                            actor_id = %actor.actor_id,
                            error = %e,
                            "actor process() failed"
                        );
                    }
                }
            }),
        )
    }
}

impl Handler<ListChannelsMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Result<Vec<ChannelSummary>, derec_library::Error>>;

    fn handle(&mut self, _msg: ListChannelsMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let Some(protocol) = self.protocol.take() else {
            return Box::pin(actix::fut::ready(Err(derec_library::Error::Invariant(
                "protocol already borrowed",
            ))));
        };
        let secret_id = protocol.secret_id();

        Box::pin(
            async move {
                let result = match protocol.channel_store.channels(secret_id).await {
                    Ok(channels) => {
                        let mut summaries = Vec::with_capacity(channels.len());
                        for ch in &channels {
                            let linked = protocol
                                .channel_store
                                .linked_channels(secret_id, ch.id)
                                .await
                                .unwrap_or_default()
                                .into_iter()
                                .filter(|c| c.0 != ch.id.0)
                                .map(|c| c.0.to_string())
                                .collect();
                            summaries.push(ChannelSummary {
                                channel_id: ch.id.0.to_string(),
                                peer_name: ch
                                    .communication_info
                                    .get("name")
                                    .cloned()
                                    .unwrap_or_default(),
                                // The channel row records the *peer's* role;
                                // this actor's own is always the inverse.
                                role: match ch.peer_role {
                                    derec_proto::SenderKind::Owner => "helper".to_owned(),
                                    _ => "owner".to_owned(),
                                },
                                linked_channel_ids: linked,
                            });
                        }
                        Ok(summaries)
                    }
                    Err(e) => Err(derec_library::Error::from(e)),
                };
                (protocol, result)
            }
            .into_actor(self)
            .map(|(protocol, result), actor, _ctx| {
                actor.protocol = Some(protocol);
                result
            }),
        )
    }
}

impl Handler<LinkChannelsMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Result<(), derec_library::Error>>;

    fn handle(&mut self, msg: LinkChannelsMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let Some(mut protocol) = self.protocol.take() else {
            return Box::pin(actix::fut::ready(Err(derec_library::Error::Invariant(
                "protocol already borrowed",
            ))));
        };
        let secret_id = protocol.secret_id();
        let (a, b) = (msg.channel_id, msg.link_to_channel_id);
        let (session_id, actor_id) = (self.session_id, self.actor_id);

        Box::pin(
            async move {
                let result = protocol
                    .channel_store
                    .link_channel(secret_id, ChannelId(a), ChannelId(b))
                    .await
                    .map_err(derec_library::Error::from);
                if result.is_ok() {
                    info!(
                        session_id = %session_id,
                        actor_id = %actor_id,
                        channel_id = a,
                        link_to_channel_id = b,
                        "channels linked by operator"
                    );
                }
                (protocol, result)
            }
            .into_actor(self)
            .map(|(protocol, result), actor, _ctx| {
                actor.protocol = Some(protocol);
                result
            }),
        )
    }
}

impl Handler<CreateContactMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Result<derec_proto::ContactMessage, derec_library::Error>>;

    fn handle(&mut self, msg: CreateContactMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let Some(mut protocol) = self.protocol.take() else {
            return Box::pin(actix::fut::ready(Err(derec_library::Error::Invariant(
                "protocol already borrowed",
            ))));
        };
        let contact_mode = msg.contact_mode;
        let nonce = msg.nonce;

        Box::pin(
            async move {
                let result = protocol.create_contact(None, contact_mode, nonce).await;
                (protocol, result)
            }
            .into_actor(self)
            .map(move |(protocol, result), actor, _ctx| {
                actor.protocol = Some(protocol);
                result
            }),
        )
    }
}

impl Handler<StartFlowMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Result<Vec<DeRecEvent>, derec_library::Error>>;

    fn handle(&mut self, msg: StartFlowMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let Some(mut protocol) = self.protocol.take() else {
            return Box::pin(actix::fut::ready(Err(derec_library::Error::Invariant(
                "protocol already borrowed",
            ))));
        };
        let flow = msg.flow;

        Box::pin(
            async move {
                let result = protocol.start(flow).await;
                (protocol, result)
            }
            .into_actor(self)
            .map(move |(protocol, result), actor, _ctx| {
                actor.protocol = Some(protocol);
                if let Ok(events) = &result {
                    actor.handle_events(events);
                }
                result
            }),
        )
    }
}

impl Handler<LoadSharedKeyMsg> for ProvisionedActor {
    type Result = Option<[u8; 32]>;

    fn handle(&mut self, msg: LoadSharedKeyMsg, _ctx: &mut Context<Self>) -> Self::Result {
        self.protocol
            .as_ref()
            .and_then(|p| p.secret_store.load_shared_key(p.secret_id(), msg.channel_id))
    }
}

impl Handler<GetFingerprintMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Result<String, derec_library::Error>>;

    fn handle(&mut self, msg: GetFingerprintMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let Some(protocol) = self.protocol.take() else {
            return Box::pin(actix::fut::ready(Err(derec_library::Error::Invariant(
                "protocol already borrowed",
            ))));
        };
        let channel_id = msg.channel_id;

        Box::pin(
            async move {
                let result = protocol.get_fingerprint(channel_id.into()).await;
                (protocol, result)
            }
            .into_actor(self)
            .map(move |(protocol, result), actor, _ctx| {
                actor.protocol = Some(protocol);
                result
            }),
        )
    }
}

impl Handler<VerifyFingerprintMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Result<bool, derec_library::Error>>;

    fn handle(&mut self, msg: VerifyFingerprintMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let Some(mut protocol) = self.protocol.take() else {
            return Box::pin(actix::fut::ready(Err(derec_library::Error::Invariant(
                "protocol already borrowed",
            ))));
        };
        let channel_id = msg.channel_id;
        let fingerprint = msg.fingerprint;

        Box::pin(
            async move {
                let result = protocol
                    .verify_fingerprint(channel_id.into(), &fingerprint)
                    .await;
                (protocol, result)
            }
            .into_actor(self)
            .map(move |(protocol, result), actor, _ctx| {
                actor.protocol = Some(protocol);
                result
            }),
        )
    }
}
