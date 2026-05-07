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
    models::{Actor, ActorWithStatus, AddParticipantRequest, AddParticipantResponse, AddReplicaRequest, AddReplicaResponse, CreateSessionRequest, CreateSessionResponse, GetSessionResponse, JoinSessionRequest, JoinSessionResponse, Role, Session, Transport, TransportProtocol},
    state::{ActorInbox, AppState},
    stores::{HttpTransport, InMemoryChannelStore, InMemorySecretStore, InMemoryShareStore},
};

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateSessionRequest>,
) -> impl IntoResponse {
    let session_id = Uuid::new_v4();

    let caller = provisioned_actor(Role::Owner, &req.name, session_id, &state.base_url);

    // Register the owner's browser inbox.
    register_browser_actor(&state, caller.id);

    let mut actors: Vec<Actor> = vec![caller.clone()];

    // Provision the requested number of additional participants.
    for _ in 1..=req.additional_participants {
        let participant = provisioned_actor(
            Role::Participant,
            &format!("{} {}", FirstName().fake::<String>(), LastName().fake::<String>()),
            session_id,
            &state.base_url,
        );

        spawn_provisioned(&state, participant.id, session_id, Role::Participant, &participant.transport.uri, Some(participant.name.clone()));
        actors.push(participant);
    }

    let session = Session {
        _id: session_id,
        actors: actors.clone(),
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

/// DELETE /sessions/:session_id/pending-associations
pub async fn clear_pending_associations(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<Uuid>,
) -> Response {
    let session = match state.sessions.get(&session_id) {
        Some(s) => s.value().clone(),
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "session not found" })),
            )
                .into_response();
        }
    };

    let mut cleared = 0usize;
    for actor in &session.actors {
        if state.pending_associations.remove(&actor.id).is_some() {
            cleared += 1;
        }
    }

    info!(session_id = %session_id, cleared, "pending associations cleared");

    (StatusCode::OK, Json(serde_json::json!({ "cleared": cleared }))).into_response()
}

/// GET /sessions/:session_id
pub async fn get(
    State(state): State<Arc<AppState>>,
    Path(session_id): Path<Uuid>,
) -> Response {
    match state.sessions.get(&session_id) {
        Some(entry) => {
            let actors = enrich_actors(&state, &entry.value().actors).await;
            (StatusCode::OK, Json(GetSessionResponse { session_id, actors })).into_response()
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

    spawn_provisioned(&state, participant.id, session_id, Role::Participant, &participant.transport.uri, Some(participant.name.clone()));
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

    spawn_provisioned(&state, replica.id, session_id, Role::Replica, &replica.transport.uri, Some(replica.name.clone()));
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

    (StatusCode::OK, Json(JoinSessionResponse { session_id, actor, actors })).into_response()
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

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Register a browser-managed actor (owner or browser participant).
fn register_browser_actor(state: &AppState, actor_id: Uuid) {
    let (tx, rx) = mpsc::unbounded_channel();
    state.actor_inboxes.insert(actor_id, ActorInbox::Browser(tx));
    state.browser_receivers.insert(actor_id, Arc::new(Mutex::new(rx)));
}

/// Create a DeRecProtocol, start an Actix actor for it, and register the inbox.
fn spawn_provisioned(state: &AppState, actor_id: Uuid, session_id: Uuid, role: Role, transport_uri: &str, name: Option<String>) {
    let protocol = create_protocol(state, transport_uri, name);
    let app_state = Arc::new(state.clone());

    let addr = ProvisionedActor::start_in_arbiter(&state.arbiter, move |_ctx| {
        ProvisionedActor::new(protocol, actor_id, session_id, role, app_state)
    });

    state.actor_inboxes.insert(actor_id, ActorInbox::Provisioned(addr));
}

/// Create a DeRecProtocol instance for a provisioned actor.
fn create_protocol(state: &AppState, transport_uri: &str, name: Option<String>) -> crate::stores::ActorProtocol {
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
        .with_timeout_in_secs(300)
        .with_communication_info(info)
        .build()
}

/// Build `ActorWithStatus` list from a session's actors.
async fn enrich_actors(state: &AppState, actors: &[Actor]) -> Vec<ActorWithStatus> {
    let mut result = Vec::with_capacity(actors.len());

    for a in actors {
        let channel_id = state.participant_channels.get(&a.id)
            .and_then(|v| v.value().last().cloned())
            .or_else(|| state.replica_channels.get(&a.id).and_then(|v| v.value().last().cloned()));
        let pending_recovery_channel_id = state.pending_associations.get(&a.id).map(|v| v.value().clone());

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

        let browser_managed = if a.role == Role::Participant && state.browser_receivers.contains_key(&a.id) {
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
            pending_recovery_channel_id,
            shared_key,
            disabled,
            browser_managed,
            replica_confirmed,
        });
    }

    result
}

/// Build a backend-provisioned actor whose transport URI points at this relay.
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
