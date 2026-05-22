use std::sync::Arc;
use std::time::Duration;

use actix::prelude::*;
use rand::Rng as _;
use tracing::{info, error};
use uuid::Uuid;

use derec_library::protocol::{DeRecChannelStore, DeRecEvent, DeRecFlow, PendingAction};
use derec_library::types::ChannelId;

use crate::models::Role;
use crate::state::AppState;
use crate::stores::ActorProtocol;

pub struct ProvisionedActor {
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

    fn handle_events(&mut self, events: Vec<DeRecEvent>, ctx: &mut Context<Self>) {
        for event in events {
            match event {
                DeRecEvent::PairingCompleted { channel_id, peer_communication_info, .. } => {
                    let cid = channel_id.0.to_string();
                    let peer_name = peer_communication_info
                        .get("name")
                        .cloned()
                        .unwrap_or_default();

                    match self.role {
                        Role::Participant => {
                            self.state.participant_channels
                                .entry(self.actor_id)
                                .or_default()
                                .push(cid.clone());

                            info!(
                                session_id = %self.session_id,
                                actor_id = %self.actor_id,
                                channel_id = channel_id.0,
                                peer_name = %peer_name,
                                "participant pairing complete — channel recorded"
                            );

                            // Auto-link new channel to any existing channel from the same owner name.
                            if !peer_name.is_empty() {
                                ctx.notify(AutoLinkByName {
                                    new_channel_id: channel_id.0,
                                    peer_name,
                                });
                            }
                        }
                        Role::Replica => {
                            self.state.replica_channels
                                .entry(self.actor_id)
                                .or_default()
                                .push(cid);
                            info!(
                                session_id = %self.session_id,
                                actor_id = %self.actor_id,
                                channel_id = channel_id.0,
                                "replica pairing complete — channel recorded"
                            );
                        }
                        Role::Owner => {}
                    }
                }

                DeRecEvent::ActionRequired { action, .. } => {
                    ctx.notify(AcceptAction(action));
                }

                DeRecEvent::Unpaired { channel_id } => {
                    let cid = channel_id.0.to_string();
                    // Drop the channel from the per-actor index so the
                    // session-status enrichment stops reporting this actor
                    // as paired on a channel that no longer exists.
                    if let Some(mut entry) = self.state.participant_channels.get_mut(&self.actor_id) {
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

/// Incoming protocol bytes from a peer. Schedules processing after a random delay.
#[derive(Message)]
#[rtype(result = "()")]
pub struct IncomingMessage(pub Vec<u8>);

// Delayed so concurrent messages from the same sender don't race through WASM in lockstep.
#[derive(Message)]
#[rtype(result = "()")]
struct ProcessDelayed(Vec<u8>);

#[derive(Message)]
#[rtype(result = "()")]
struct AcceptAction(PendingAction);

#[derive(Message)]
#[rtype(result = "()")]
struct AutoLinkByName {
    new_channel_id: u64,
    peer_name: String,
}

#[derive(Message)]
#[rtype(result = "Result<derec_proto::ContactMessage, derec_library::Error>")]
pub struct CreateContactMsg;

#[derive(Message)]
#[rtype(result = "Result<Option<u64>, derec_library::Error>")]
pub struct StartFlowMsg(pub DeRecFlow);

#[derive(Message)]
#[rtype(result = "Option<[u8; 32]>")]
pub struct LoadSharedKeyMsg(pub u64);

#[derive(Message)]
#[rtype(result = "Result<String, derec_library::Error>")]
pub struct GetFingerprintMsg(pub u64);

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
        let mut protocol = self.protocol.take().expect("protocol taken while processing");
        let bytes = msg.0;

        Box::pin(
            async move {
                let result = protocol.process(&bytes).await;
                (protocol, result)
            }
            .into_actor(self)
            .map(|(protocol, result), actor, ctx| {
                actor.protocol = Some(protocol);
                match result {
                    Ok(events) => actor.handle_events(events, ctx),
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

impl Handler<AcceptAction> for ProvisionedActor {
    type Result = ResponseActFuture<Self, ()>;

    fn handle(&mut self, msg: AcceptAction, _ctx: &mut Context<Self>) -> Self::Result {
        let action = msg.0;
        let action_desc = match &action {
            PendingAction::Pairing { .. } => "Pairing",
            PendingAction::StoreShare { .. } => "StoreShare",
            PendingAction::VerifyShare { .. } => "VerifyShare",
            PendingAction::Discovery { .. } => "Discovery",
            PendingAction::GetShare { .. } => "GetShare",
            PendingAction::Unpair { .. } => "Unpair",
        };

        info!(
            session_id = %self.session_id,
            actor_id = %self.actor_id,
            action = action_desc,
            "auto-accepting ActionRequired"
        );

        let mut protocol = self.protocol.take().expect("protocol taken while accepting");

        Box::pin(
            async move {
                let result = protocol.accept(action).await;
                (protocol, result)
            }
            .into_actor(self)
            .map(|(protocol, result), actor, ctx| {
                actor.protocol = Some(protocol);
                match result {
                    Ok(events) => actor.handle_events(events, ctx),
                    Err(e) => {
                        error!(
                            session_id = %actor.session_id,
                            actor_id = %actor.actor_id,
                            error = %e,
                            "auto-accept failed"
                        );
                    }
                }
            }),
        )
    }
}

impl Handler<AutoLinkByName> for ProvisionedActor {
    type Result = ResponseActFuture<Self, ()>;

    fn handle(&mut self, msg: AutoLinkByName, _ctx: &mut Context<Self>) -> Self::Result {
        let mut protocol = self.protocol.take().expect("protocol taken while linking channels");
        let new_cid = msg.new_channel_id;
        let peer_name = msg.peer_name;
        let peer_name_for_log = peer_name.clone();
        let session_id = self.session_id;
        let actor_id = self.actor_id;

        Box::pin(
            async move {
                // Collect all channels that share the same peer name (excluding the new one).
                let channels_result: Result<Vec<_>, _> = protocol.channel_store.channels().await;
                let channels_to_link: Vec<u64> = match channels_result {
                    // App-level identity match: the protocol exposes the
                    // peer's free-form `communication_info`; we treat the
                    // optional `"name"` key as the display-name convention
                    // and link channels with the same one. The protocol
                    // itself does not understand this key.
                    Ok(channels) => channels
                        .into_iter()
                        .filter(|ch| {
                            ch.id.0 != new_cid
                                && ch
                                    .communication_info
                                    .get("name")
                                    .map(String::as_str)
                                    == Some(peer_name.as_str())
                        })
                        .map(|ch| ch.id.0)
                        .collect(),
                    Err(e) => {
                        error!(
                            session_id = %session_id,
                            actor_id = %actor_id,
                            error = %e,
                            "AutoLinkByName: failed to load channels"
                        );
                        return (protocol, 0usize);
                    }
                };

                let mut linked = 0usize;
                for existing_cid in &channels_to_link {
                    if let Err(e) = protocol
                        .channel_store
                        .link_channel(ChannelId(*existing_cid), ChannelId(new_cid))
                        .await
                    {
                        error!(
                            session_id = %session_id,
                            actor_id = %actor_id,
                            existing_channel_id = existing_cid,
                            new_channel_id = new_cid,
                            error = %e,
                            "AutoLinkByName: link_channel failed"
                        );
                    } else {
                        linked += 1;
                    }
                }

                (protocol, linked)
            }
            .into_actor(self)
            .map(move |(protocol, linked), actor, _ctx| {
                actor.protocol = Some(protocol);
                if linked > 0 {
                    info!(
                        session_id = %actor.session_id,
                        actor_id = %actor.actor_id,
                        new_channel_id = new_cid,
                        peer_name = %peer_name_for_log,
                        linked_channels = linked,
                        "auto-linked new channel to existing channels by owner name"
                    );
                }
            }),
        )
    }
}

impl Handler<CreateContactMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Result<derec_proto::ContactMessage, derec_library::Error>>;

    fn handle(&mut self, _msg: CreateContactMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let mut protocol = self.protocol.take().expect("protocol taken while creating contact");

        Box::pin(
            async move {
                let result = protocol.create_contact(None).await;
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

impl Handler<StartFlowMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Result<Option<u64>, derec_library::Error>>;

    fn handle(&mut self, msg: StartFlowMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let mut protocol = self.protocol.take().expect("protocol taken while starting flow");
        let flow = msg.0;

        Box::pin(
            async move {
                let result = protocol.start(flow).await;
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

impl Handler<LoadSharedKeyMsg> for ProvisionedActor {
    type Result = Option<[u8; 32]>;

    fn handle(&mut self, msg: LoadSharedKeyMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let Some(protocol) = self.protocol.as_ref() else {
            return None;
        };
        protocol.secret_store.load_shared_key(msg.0)
    }
}

impl Handler<GetFingerprintMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Result<String, derec_library::Error>>;

    fn handle(&mut self, msg: GetFingerprintMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let protocol = self.protocol.take().expect("protocol taken while getting fingerprint");
        let channel_id = msg.0;

        Box::pin(
            async move {
                let result = protocol.get_fingerprint(channel_id.into()).await;
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

impl Handler<VerifyFingerprintMsg> for ProvisionedActor {
    type Result = ResponseActFuture<Self, Result<bool, derec_library::Error>>;

    fn handle(&mut self, msg: VerifyFingerprintMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let mut protocol = self.protocol.take().expect("protocol taken while verifying fingerprint");
        let channel_id = msg.channel_id;
        let fingerprint = msg.fingerprint;

        Box::pin(
            async move {
                let result = protocol.verify_fingerprint(channel_id.into(), &fingerprint).await;
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
