use std::sync::Arc;

use actix::Actor as _;
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use tokio::sync::{Mutex, mpsc};
use tracing::info;
use uuid::Uuid;

use fake::Fake;
use fake::faker::name::en::{FirstName, LastName};

use crate::{
    actor::{LoadSharedKeyMsg, ProvisionedActor},
    models::{Actor, ActorWithStatus, AddParticipantRequest, AddParticipantResponse, AddReplicaRequest, AddReplicaResponse, CreateSessionRequest, CreateSessionResponse, GetSessionResponse, JoinSessionRequest, JoinSessionResponse, Role, Session, Transport, TransportProtocol, UnpairAck},
    state::{ActorInbox, AppState},
    stores::{HttpTransport, InMemoryChannelStore, InMemorySecretStore, InMemoryShareStore},
};

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateSessionRequest>,
) -> impl IntoResponse {
    let session_id = Uuid::new_v4();
    let protocol_timeout_secs = req.protocol_timeout_secs.unwrap_or(300);
    let authentication_method = req.authentication_method.unwrap_or_default();
    let unpair_ack = req.unpair_ack.unwrap_or_default();
    let auto_accept_unpair_requests = req.auto_accept_unpair_requests.unwrap_or(true);

    let caller = provisioned_actor(Role::Owner, &req.name, session_id, &state.base_url);

    register_browser_actor(&state, caller.id);

    let mut actors: Vec<Actor> = vec![caller.clone()];

    for _ in 1..=req.additional_participants {
        let participant = provisioned_actor(
            Role::Participant,
            &format!("{} {}", FirstName().fake::<String>(), LastName().fake::<String>()),
            session_id,
            &state.base_url,
        );

        spawn_provisioned(&state, participant.id, session_id, Role::Participant, &participant.transport.uri, Some(participant.name.clone()), protocol_timeout_secs, unpair_ack);
        actors.push(participant);
    }

    let session = Session {
        _id: session_id,
        actors: actors.clone(),
        min_participants: req.min_participants.unwrap_or(2),
        recommended_participants: req.recommended_participants.unwrap_or(5),
        protocol_timeout_secs,
        authentication_method,
        unpair_ack,
        auto_accept_unpair_requests,
    };

    state.sessions.insert(session_id, session);

    info!(
        session_id = %session_id,
        actor_count = actors.len(),
        "session created"
    );

    (
        StatusCode::CREATED,
        Json(CreateSessionResponse {
            session_id,
            actors,
        }),
    )
}

/// GET /sessions/:session_id
pub async fn get(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<Uuid>,
) -> Response {
    match state.sessions.get(&session_id) {
        Some(entry) => {
            let session = entry.value().clone();
            let actors = enrich_actors(&state, &session.actors).await;
            (StatusCode::OK, Json(GetSessionResponse {
                session_id,
                actors,
                min_participants: session.min_participants,
                recommended_participants: session.recommended_participants,
                protocol_timeout_secs: session.protocol_timeout_secs,
                authentication_method: session.authentication_method,
                unpair_ack: session.unpair_ack,
                auto_accept_unpair_requests: session.auto_accept_unpair_requests,
            })).into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response(),
    }
}

/// POST /sessions/:session_id/participants
pub async fn add_participant(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<Uuid>,
    Json(req): Json<AddParticipantRequest>,
) -> Response {
    let mut session = match state.sessions.get_mut(&session_id) {
        Some(s) => s,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "session not found" })),
            )
                .into_response();
        }
    };

    let participant = provisioned_actor(Role::Participant, &req.name, session_id, &state.base_url);

    spawn_provisioned(&state, participant.id, session_id, Role::Participant, &participant.transport.uri, Some(participant.name.clone()), session.protocol_timeout_secs, session.unpair_ack);
    session.actors.push(participant.clone());

    info!(
        session_id = %session_id,
        participant_id = %participant.id,
        name = %participant.name,
        "participant added to session"
    );

    (StatusCode::CREATED, Json(AddParticipantResponse { actor: participant })).into_response()
}

/// POST /sessions/:session_id/replicas
pub async fn add_replica(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<Uuid>,
    Json(req): Json<AddReplicaRequest>,
) -> Response {
    let mut session = match state.sessions.get_mut(&session_id) {
        Some(s) => s,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "session not found" })),
            )
                .into_response();
        }
    };

    let replica = provisioned_actor(Role::Replica, &req.name, session_id, &state.base_url);

    spawn_provisioned(&state, replica.id, session_id, Role::Replica, &replica.transport.uri, Some(replica.name.clone()), session.protocol_timeout_secs, session.unpair_ack);
    session.actors.push(replica.clone());

    info!(
        session_id = %session_id,
        replica_id = %replica.id,
        name = %replica.name,
        "replica added to session"
    );

    (StatusCode::CREATED, Json(AddReplicaResponse { actor: replica })).into_response()
}

/// POST /sessions/:session_id/join
///
/// Two modes:
///   - **Normal**: creates a new owner actor and registers its mailbox.
///   - **Claim** (when `req.claim_actor_id` is set): adopts an existing
///     owner actor's identity. Used by the recovery-join flow so the
///     recovering user can poll the mailbox tied to an old transport URI
///     that the network still recognizes (helpers' channel stores still
///     point at it). The mailbox tx/rx is rebound to a fresh pair so the
///     new tab starts receiving; any previous tab silently stops.
pub async fn join(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<Uuid>,
    Json(req): Json<JoinSessionRequest>,
) -> Response {
    let session_exists = state.sessions.contains_key(&session_id);
    if !session_exists {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response();
    }

    // ── Claim path ───────────────────────────────────────────────────────
    if let Some(claim_actor_id) = req.claim_actor_id {
        let claimed: Option<Actor> = {
            let session = state.sessions.get(&session_id).unwrap();
            session
                .actors
                .iter()
                .find(|a| a.id == claim_actor_id && a.role == Role::Owner)
                .cloned()
        };

        let actor = match claimed {
            Some(a) => a,
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({
                        "error": "claim_actor_id not found in session, or is not an owner"
                    })),
                )
                    .into_response();
            }
        };

        // Rebind the browser receiver. `insert` replaces any prior entry,
        // so the previous tab's tx is dropped and its `pollMailbox` returns
        // empty from here on — the new tab now owns the rx.
        register_browser_actor(&state, actor.id);

        info!(
            session_id = %session_id,
            actor_id = %actor.id,
            name = %actor.name,
            "owner actor reclaimed in recovery mode"
        );

        // Snapshot actors before the async enrich so we don't hold a dashmap
        // guard across an await.
        let actors_snapshot: Vec<Actor> = state
            .sessions
            .get(&session_id)
            .unwrap()
            .actors
            .clone();
        let actors = enrich_actors(&state, &actors_snapshot).await;

        let session = state.sessions.get(&session_id).unwrap();
        return (StatusCode::OK, Json(JoinSessionResponse {
            session_id,
            actor,
            actors,
            min_participants: session.min_participants,
            recommended_participants: session.recommended_participants,
            protocol_timeout_secs: session.protocol_timeout_secs,
            authentication_method: session.authentication_method,
            unpair_ack: session.unpair_ack,
            auto_accept_unpair_requests: session.auto_accept_unpair_requests,
        })).into_response();
    }

    // ── Normal path ──────────────────────────────────────────────────────
    let actor = provisioned_actor(Role::Owner, &req.name, session_id, &state.base_url);
    register_browser_actor(&state, actor.id);

    {
        let mut session = state.sessions.get_mut(&session_id).unwrap();
        session.actors.push(actor.clone());
    }

    let actors = {
        let session = state.sessions.get(&session_id).unwrap();
        enrich_actors(&state, &session.actors).await
    };

    info!(
        session_id = %session_id,
        actor_id = %actor.id,
        name = %actor.name,
        "owner joined session"
    );

    let (min_participants, recommended_participants, protocol_timeout_secs, authentication_method, unpair_ack, auto_accept_unpair_requests) = {
        let session = state.sessions.get(&session_id).unwrap();
        (
            session.min_participants,
            session.recommended_participants,
            session.protocol_timeout_secs,
            session.authentication_method,
            session.unpair_ack,
            session.auto_accept_unpair_requests,
        )
    };

    (StatusCode::OK, Json(JoinSessionResponse {
        session_id,
        actor,
        actors,
        min_participants,
        recommended_participants,
        protocol_timeout_secs,
        authentication_method,
        unpair_ack,
        auto_accept_unpair_requests,
    })).into_response()
}

/// POST /sessions/:session_id/participants/:participant_id/browser-contact
pub async fn post_browser_contact(
    State(state): State<Arc<AppState>>,
    Path((session_id, participant_id)): Path<(Uuid, Uuid)>,
    body: String,
) -> Response {
    if !state.sessions.contains_key(&session_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response();
    }
    state.browser_participant_contacts.insert(participant_id, body);
    info!(session_id = %session_id, participant_id = %participant_id, "browser contact stored");
    StatusCode::OK.into_response()
}

/// GET /sessions/:session_id/participants/:participant_id/browser-contact
pub async fn get_browser_contact(
    State(state): State<Arc<AppState>>,
    Path((session_id, participant_id)): Path<(Uuid, Uuid)>,
) -> Response {
    if !state.sessions.contains_key(&session_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        )
            .into_response();
    }
    match state.browser_participant_contacts.get(&participant_id) {
        Some(contact) => (StatusCode::OK, contact.value().clone()).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn register_browser_actor(state: &AppState, actor_id: Uuid) {
    let (tx, rx) = mpsc::unbounded_channel();
    state.actor_inboxes.insert(actor_id, ActorInbox::Browser(tx));
    state.browser_receivers.insert(actor_id, Arc::new(Mutex::new(rx)));
}

fn spawn_provisioned(state: &AppState, actor_id: Uuid, session_id: Uuid, role: Role, transport_uri: &str, name: Option<String>, timeout_secs: u32, unpair_ack: UnpairAck) {
    let protocol = create_protocol(state, transport_uri, name, timeout_secs, unpair_ack);
    let app_state = Arc::new(state.clone());

    let addr = ProvisionedActor::start_in_arbiter(&state.arbiter, move |_ctx| {
        ProvisionedActor::new(protocol, actor_id, session_id, role, app_state)
    });

    state.actor_inboxes.insert(actor_id, ActorInbox::Provisioned(addr));
}

fn create_protocol(state: &AppState, transport_uri: &str, name: Option<String>, timeout_secs: u32, unpair_ack: UnpairAck) -> crate::stores::ActorProtocol {
    let transport = HttpTransport::new(state.http_client.clone());
    let own_transport = derec_proto::TransportProtocol {
        uri: transport_uri.to_owned(),
        protocol: 0, // HTTPS
    };
    let mut info = std::collections::HashMap::new();
    if let Some(n) = name {
        info.insert("name".to_owned(), n);
    }
    derec_library::protocol::DeRecProtocolBuilder::new()
        .with_channel_store(InMemoryChannelStore::default())
        .with_share_store(InMemoryShareStore::default())
        .with_secret_store(InMemorySecretStore::default())
        .with_transport(transport)
        .with_own_transport(own_transport)
        .with_threshold(2)
        .with_keep_versions_count(3)
        .with_timeout_in_secs(timeout_secs as u64)
        .with_communication_info(info)
        .with_unpair_ack(unpair_ack.to_library())
        .build()
}

async fn enrich_actors(state: &AppState, actors: &[Actor]) -> Vec<ActorWithStatus> {
    let mut result = Vec::with_capacity(actors.len());

    for a in actors {
        let channel_id = state.participant_channels.get(&a.id)
            .and_then(|v| v.value().last().cloned())
            .or_else(|| state.replica_channels.get(&a.id).and_then(|v| v.value().last().cloned()));

        let disabled = if state.disabled_participants.contains_key(&a.id) || state.disabled_replicas.contains_key(&a.id) {
            Some(true)
        } else {
            None
        };

        let shared_key = if a.role == Role::Participant {
            if let Some(cid_str) = &channel_id {
                if let Ok(cid) = cid_str.parse::<u64>() {
                    if let Some(entry) = state.actor_inboxes.get(&a.id) {
                        if let ActorInbox::Provisioned(addr) = entry.value() {
                            addr.send(LoadSharedKeyMsg(cid)).await
                                .ok()
                                .flatten()
                                .map(|k| URL_SAFE_NO_PAD.encode(&k[..]))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        let browser_managed = if state.browser_receivers.contains_key(&a.id) {
            Some(true)
        } else {
            None
        };

        let replica_confirmed = if a.role == Role::Replica && state.replica_confirmed.contains_key(&a.id) {
            Some(true)
        } else {
            None
        };

        result.push(ActorWithStatus {
            actor: a.clone(),
            channel_id,
            shared_key,
            disabled,
            browser_managed,
            replica_confirmed,
        });
    }

    result
}

fn provisioned_actor(role: Role, name: &str, session_id: Uuid, base_url: &str) -> Actor {
    let actor_id = Uuid::new_v4();
    let role_segment = match role {
        Role::Owner => "owners",
        Role::Participant => "participants",
        Role::Replica => "replicas",
    };
    Actor {
        id: actor_id,
        role,
        name: name.to_owned(),
        transport: Transport {
            protocol: TransportProtocol::Https,
            uri: format!("{base_url}/derec/sessions/{session_id}/{role_segment}/{actor_id}"),
        },
    }
}
