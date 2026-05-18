use std::sync::Arc;
use std::time::Duration;

use actix::prelude::*;
use rand::Rng as _;
use tracing::{info, error};
use uuid::Uuid;

use derec_library::protocol::{DeRecEvent, DeRecFlow, PendingAction};

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
                DeRecEvent::PairingCompleted { channel_id, .. } => {
                    let cid = channel_id.0.to_string();
                    match self.role {
                        Role::Participant => {
                            let actor_id = self.actor_id;
                            let new_cid: u64 = channel_id.0;

                            // If the participant already has a channel, this is a re-pairing
                            // (recovery or replacement). Auto-migrate shares so GetShare
                            // succeeds immediately on the new channel.
                            let old_cid_opt = {
                                let entry = self.state.participant_channels.get(&actor_id);
                                entry.as_deref()
                                    .and_then(|v| v.last())
                                    .and_then(|s| s.parse::<u64>().ok())
                            };

                            if let Some(old_cid) = old_cid_opt {
                                // Only migrate when the channel actually changed.  The /pair
                                // endpoint may already have done this eagerly; guard avoids
                                // a redundant self-copy and spurious log noise.
                                if old_cid != new_cid {
                                    if let Some(protocol) = self.protocol.as_mut() {
                                        // Try the precise channel first. If that finds nothing
                                        // (the stored channel_id may differ from what
                                        // participant_channels records, depending on which
                                        // party's contact was used during initial pairing),
                                        // fall back to migrating all shares held by this actor.
                                        let migrated = {
                                            let precise = protocol.share_store.associate_channel(old_cid, new_cid);
                                            if precise == 0 {
                                                protocol.share_store.associate_all_to_channel(new_cid)
                                            } else {
                                                precise
                                            }
                                        };
                                        protocol.secret_store.associate_channel(old_cid, new_cid);
                                        info!(
                                            session_id = %self.session_id,
                                            actor_id = %actor_id,
                                            old_channel_id = old_cid,
                                            new_channel_id = new_cid,
                                            migrated_shares = migrated,
                                            "re-pairing — channels auto-associated"
                                        );
                                    }
                                    let old_str = old_cid.to_string();
                                    self.state.participant_channels
                                        .entry(actor_id)
                                        .or_default()
                                        .retain(|c| *c != old_str);
                                }
                            }

                            self.state.participant_channels
                                .entry(actor_id)
                                .or_default()
                                .push(cid.clone());
                            info!(
                                session_id = %self.session_id,
                                actor_id = %actor_id,
                                channel_id = new_cid,
                                "participant pairing complete — channel recorded"
                            );
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
#[rtype(result = "Result<derec_proto::ContactMessage, derec_library::Error>")]
pub struct CreateContactMsg;

#[derive(Message)]
#[rtype(result = "Result<Option<u64>, derec_library::Error>")]
pub struct StartFlowMsg(pub DeRecFlow);

/// Copies shares and secrets from `old_cid` to `new_cid` in the actor's stores.
#[derive(Message)]
#[rtype(result = "AssociateChannelResult")]
pub struct AssociateChannelMsg {
    pub old_cid: u64,
    pub new_cid: u64,
}

pub struct AssociateChannelResult {
    pub migrated_shares: usize,
}

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

impl Handler<AssociateChannelMsg> for ProvisionedActor {
    type Result = MessageResult<AssociateChannelMsg>;

    fn handle(&mut self, msg: AssociateChannelMsg, _ctx: &mut Context<Self>) -> Self::Result {
        let Some(protocol) = self.protocol.as_mut() else {
            // Protocol is taken by an in-flight async handler; caller can retry.
            return MessageResult(AssociateChannelResult { migrated_shares: 0 });
        };
        let migrated_shares = protocol.share_store.associate_channel(msg.old_cid, msg.new_cid);
        protocol.secret_store.associate_channel(msg.old_cid, msg.new_cid);
        MessageResult(AssociateChannelResult { migrated_shares })
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
