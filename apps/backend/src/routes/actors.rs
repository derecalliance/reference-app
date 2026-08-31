use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use derec_library::protocol::DeRecFlow;
use tracing::info;
use uuid::Uuid;

use crate::{
    actor::{CreateContactMsg, LoadSharedKeyMsg, StartFlowMsg},
    models::{Actor, ActorWithStatus, ListActorsResponse, Role},
    routes::actor_guard::ensure_actor_exists,
    routes::participants::{ContactMessageDto, contact_to_dto},
    state::{ActorInbox, AppState},
};
use derec_library::protocol::DeRecEvent;
use serde::Deserialize;

/// Role the caller wants a backend-managed actor to take when it initiates
/// pairing.
///
/// Pairing is bi-directional: the initiator declares its own role on the wire
/// and the responder takes the complement. Provisioned actors default to
/// Helper (their usual job), but either role can be driven for testing.
#[derive(Debug, Deserialize, Default)]
pub struct PairRoleQuery {
    #[serde(default)]
    pub role: Option<String>,
}

/// How a provisioned actor should deliver its public keys in a contact.
///
/// Defaults to `inline_keys`, which is the only mode usable with no further
/// exchange. `hashed_keys` commits to the keys and has the scanner fetch them
/// over `PrePair`; `no_keys` commits to nothing and leaves the channel
/// `Pending` until both sides confirm a fingerprint out of band.
#[derive(Debug, Deserialize, Default)]
pub struct ContactModeQuery {
    #[serde(default)]
    pub contact_mode: Option<String>,
    /// `NoKeys` contacts are typically hand-typed, so callers pick a small
    /// human-readable nonce rather than letting the library mint a random u64.
    #[serde(default)]
    pub nonce: Option<u64>,
}

impl ContactModeQuery {
    fn contact_mode(&self) -> Result<derec_proto::ContactMode, Response> {
        match self.contact_mode.as_deref() {
            None | Some("inline_keys") => Ok(derec_proto::ContactMode::InlineKeys),
            Some("hashed_keys") => Ok(derec_proto::ContactMode::HashedKeys),
            Some("no_keys") => Ok(derec_proto::ContactMode::NoKeys),
            Some(other) => Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": format!(
                        "unknown contact mode `{other}` — expected `inline_keys`, `hashed_keys` or `no_keys`"
                    )
                })),
            )
                .into_response()),
        }
    }
}

impl PairRoleQuery {
    fn sender_kind(&self) -> Result<derec_proto::SenderKind, Response> {
        match self.role.as_deref() {
            None | Some("helper") => Ok(derec_proto::SenderKind::Helper),
            Some("owner") => Ok(derec_proto::SenderKind::Owner),
            Some(other) => Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": format!("unknown pairing role `{other}` — expected `owner` or `helper`")
                })),
            )
                .into_response()),
        }
    }
}

/// GET /actors
///
/// Every actor registered on this server, enriched with live pairing status, in
/// registration order. This is how a browser context discovers its peers.
pub async fn list(State(state): State<Arc<AppState>>) -> Response {
    let actors = enrich_actors(&state, &state.actors.all()).await;

    (StatusCode::OK, Json(ListActorsResponse { actors })).into_response()
}

/// Decorate a roster snapshot with the pairing state held outside the registry.
pub(crate) async fn enrich_actors(state: &AppState, actors: &[Actor]) -> Vec<ActorWithStatus> {
    let mut result = Vec::with_capacity(actors.len());

    for a in actors {
        let channel_id = state
            .participant_channels
            .get(&a.id)
            .and_then(|v| v.value().last().cloned())
            .or_else(|| {
                state
                    .replica_channels
                    .get(&a.id)
                    .and_then(|v| v.value().last().cloned())
            });

        let disabled = if state.disabled_participants.contains_key(&a.id)
            || state.disabled_replicas.contains_key(&a.id)
        {
            Some(true)
        } else {
            None
        };

        // Only participants carry one, and only once pairing has produced a
        // channel whose key the backend instance actually holds.
        let shared_key = match (a.role, channel_id.as_deref().map(str::parse::<u64>)) {
            (Role::Participant, Some(Ok(cid))) => match provisioned_addr(state, &a.id) {
                Some(addr) => addr
                    .send(LoadSharedKeyMsg { channel_id: cid })
                    .await
                    .ok()
                    .flatten()
                    .map(|k| URL_SAFE_NO_PAD.encode(&k[..])),
                None => None,
            },
            _ => None,
        };

        let browser_managed = if state.browser_receivers.contains_key(&a.id) {
            Some(true)
        } else {
            None
        };

        let replica_confirmed = if a.role == Role::Replica && state.replica_confirmed.contains_key(&a.id)
        {
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

/// Resolves a backend-managed actor's mailbox address. `None` for a browser
/// actor, or one whose `spawn_provisioned` failed to build an instance.
pub(crate) fn provisioned_addr(
    state: &AppState,
    actor_id: &Uuid,
) -> Option<actix::Addr<crate::actor::ProvisionedActor>> {
    state
        .actor_inboxes
        .get(actor_id)
        .and_then(|entry| match entry.value() {
            ActorInbox::Provisioned(addr) => Some(addr.clone()),
            ActorInbox::Browser(_) => None,
        })
}

/// POST /actors/:actor_id/contact
///
/// Unified endpoint for creating a contact message for any provisioned actor,
/// regardless of role (participant or replica). All message exchange between
/// parties must flow through the actor's transport URI (mailbox).
///
/// Role is not checked — both provisioned roles use this endpoint, and the
/// `ActorInbox` match below is what rejects a browser actor.
pub async fn create_contact(
    State(state): State<Arc<AppState>>,
    Path(actor_id): Path<Uuid>,
    Query(query): Query<ContactModeQuery>,
) -> Response {
    if let Err(response) = ensure_actor_exists(&state, &actor_id) {
        return response;
    }

    let Some(addr) = provisioned_addr(&state, &actor_id) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "browser-managed actors generate their own contacts"
            })),
        )
            .into_response();
    };

    let contact_mode = match query.contact_mode() {
        Ok(mode) => mode,
        Err(response) => return response,
    };

    // The PrePair round-trip that HashedKeys and NoKeys need is auto-accepted
    // by these actors, and the fingerprint confirmation NoKeys then requires is
    // driven by the operator through the fingerprint endpoints — so an
    // unattended fixture can serve all three modes.
    let msg = CreateContactMsg {
        contact_mode,
        nonce: query.nonce,
    };

    match addr.send(msg).await {
        Ok(Ok(contact)) => {
            let dto = contact_to_dto(&contact);
            info!(
                actor_id = %actor_id,
                channel_id = %dto.channel_id,
                "actor contact created"
            );
            (StatusCode::OK, Json(dto)).into_response()
        }
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("create_contact failed: {e}") })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("actor mailbox error: {e}") })),
        )
            .into_response(),
    }
}

/// POST /actors/:actor_id/start-pairing
///
/// Has a backend-managed actor initiate pairing using the provided contact.
/// The caller supplies the owner's contact; this endpoint triggers the actor
/// to call protocol.start(Pairing { kind: Helper, contact }) and returns the
/// resulting channel_id.
pub async fn start_pairing(
    State(state): State<Arc<AppState>>,
    Path(actor_id): Path<Uuid>,
    Query(role): Query<PairRoleQuery>,
    Json(req): Json<ContactMessageDto>,
) -> Response {
    let sender_kind = match role.sender_kind() {
        Ok(k) => k,
        Err(resp) => return resp,
    };

    if let Err(response) = ensure_actor_exists(&state, &actor_id) {
        return response;
    }

    let Some(addr) = provisioned_addr(&state, &actor_id) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "browser-managed actors initiate pairing themselves"
            })),
        )
            .into_response();
    };

    let channel_id: u64 = match req.channel_id.parse() {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "invalid channel_id" })),
            )
                .into_response();
        }
    };
    let nonce: u64 = match req.nonce.parse() {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "invalid nonce" })),
            )
                .into_response();
        }
    };
    // Key material is absent under HashedKeys / NoKeys, so decode only what
    // the initiator actually sent.
    let decode_opt = |field: &Option<String>| -> Result<Option<Vec<u8>>, ()> {
        field
            .as_deref()
            .map(|v| URL_SAFE_NO_PAD.decode(v).map_err(|_| ()))
            .transpose()
    };

    let (mlkem_encapsulation_key, ecies_public_key, contact_binding_hash) = match (
        decode_opt(&req.mlkem_encapsulation_key),
        decode_opt(&req.ecies_public_key),
        decode_opt(&req.contact_binding_hash),
    ) {
        (Ok(m), Ok(e), Ok(h)) => (m, e, h),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "invalid contact key material" })),
            )
                .into_response();
        }
    };

    let contact = derec_proto::ContactMessage {
        channel_id,
        nonce,
        transport_protocol: Some(derec_proto::TransportProtocol {
            uri: req.transport_protocol.uri.clone(),
            protocol: 0, // HTTPS
        }),
        contact_mode: req.contact_mode,
        mlkem_encapsulation_key,
        ecies_public_key,
        contact_binding_hash,
        timestamp: None,
    };

    let flow = DeRecFlow::Pairing {
        kind: sender_kind,
        contact,
        // The provisioned actor doesn't carry an app-level label for the
        // initiator; the peer's `communication_info` arrives on the wire
        // with the pair-request and is what the responder side stores.
        peer_communication_info: std::collections::HashMap::new(),
    };

    match addr.send(StartFlowMsg { flow }).await {
        Ok(Ok(events)) => {
            // `start` no longer returns the channel id directly — it reports
            // the dispatched handshake as a `PairingStarted` event. This is
            // the transient pairing id; the handshake rotates to a long-term
            // id that surfaces on `PairingCompleted`.
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
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({
                            "channel_id": pairing_channel_id.to_string()
                        })),
                    )
                        .into_response()
                }
                None => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": "pairing emitted no PairingStarted event" })),
                )
                    .into_response(),
            }
        }
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("pairing failed: {e}") })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("actor mailbox error: {e}") })),
        )
            .into_response(),
    }
}

// ── Fingerprint confirmation ────────────────────────────────────────────────
//
// Actor-generic, unlike the replica-scoped pair in `routes::replicas`: those
// infer the channel from the replica's pairing history, which only works for a
// role that pairs once. A `NoKeys` pairing can happen on any provisioned actor
// and on any of its channels, so these take the channel explicitly.

#[derive(Debug, Deserialize)]
pub struct ChannelQueryParam {
    pub channel_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ConfirmFingerprintBody {
    pub channel_id: String,
    pub fingerprint: String,
}

/// Resolve a provisioned actor and a channel id it can answer for.
fn provisioned_channel(
    state: &AppState,
    actor_id: &Uuid,
    channel_id: &str,
) -> Result<(actix::Addr<crate::actor::ProvisionedActor>, u64), Response> {
    ensure_actor_exists(state, actor_id)?;

    let addr = provisioned_addr(state, actor_id).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "browser-managed actors derive their own fingerprints"
            })),
        )
            .into_response()
    })?;

    let parsed = channel_id.parse::<u64>().map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("channel_id `{channel_id}` is not a u64")
            })),
        )
            .into_response()
    })?;

    Ok((addr, parsed))
}

/// GET /actors/:actor_id/fingerprint?channel_id=…
///
/// The actor's own fingerprint for `channel_id`, for out-of-band comparison.
/// Both sides derive the same value from the shared key.
pub async fn get_fingerprint(
    State(state): State<Arc<AppState>>,
    Path(actor_id): Path<Uuid>,
    Query(query): Query<ChannelQueryParam>,
) -> Response {
    let (addr, channel_id) = match provisioned_channel(&state, &actor_id, &query.channel_id) {
        Ok(pair) => pair,
        Err(response) => return response,
    };

    match addr.send(crate::actor::GetFingerprintMsg { channel_id }).await {
        Ok(Ok(fingerprint)) => (
            StatusCode::OK,
            Json(serde_json::json!({ "fingerprint": fingerprint })),
        )
            .into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("get_fingerprint failed: {e}") })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("actor mailbox error: {e}") })),
        )
            .into_response(),
    }
}

/// POST /actors/:actor_id/confirm-fingerprint
///
/// Promotes the actor's side of the channel from `Pending` to `Paired`.
///
/// A mismatch answers `400 {"error":"fingerprint mismatch"}` and leaves the
/// channel `Pending` — that is the man-in-the-middle case, where the two sides
/// derived different shared keys, and it must reach the operator rather than be
/// retried.
pub async fn confirm_fingerprint(
    State(state): State<Arc<AppState>>,
    Path(actor_id): Path<Uuid>,
    Json(body): Json<ConfirmFingerprintBody>,
) -> Response {
    let (addr, channel_id) = match provisioned_channel(&state, &actor_id, &body.channel_id) {
        Ok(pair) => pair,
        Err(response) => return response,
    };

    let msg = crate::actor::VerifyFingerprintMsg {
        channel_id,
        fingerprint: body.fingerprint,
    };

    match addr.send(msg).await {
        Ok(Ok(true)) => {
            info!(
                actor_id = %actor_id,
                channel_id = %body.channel_id,
                "actor confirmed fingerprint"
            );
            (StatusCode::OK, Json(serde_json::json!({ "confirmed": true }))).into_response()
        }
        Ok(Ok(false)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "fingerprint mismatch" })),
        )
            .into_response(),
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("verify_fingerprint failed: {e}") })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("actor mailbox error: {e}") })),
        )
            .into_response(),
    }
}
