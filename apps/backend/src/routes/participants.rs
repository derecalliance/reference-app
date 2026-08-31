use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use tracing::info;
use uuid::Uuid;

use crate::{
    models::{
        AddParticipantRequest, AddParticipantResponse, EnsureParticipantsRequest,
        EnsureParticipantsResponse, Role,
    },
    provisioning::{provisioned_actor, spawn_provisioned},
    routes::actor_guard::{ensure_actor_role, not_found},
    routes::actors::provisioned_addr,
    state::{AppState, EnsuredParticipants},
};

/// Mirrors the FE's ContactMessage serialization: `u64` fields travel as
/// decimal strings (they exceed the exact range of a JavaScript number) and
/// binary fields are base64url-encoded.
///
/// Key material is optional because it is only inlined under
/// [`derec_proto::ContactMode::InlineKeys`]; `HashedKeys` carries a binding
/// hash instead, and `NoKeys` carries neither.
#[derive(Debug, Serialize, Deserialize)]
pub struct ContactMessageDto {
    pub channel_id: String,
    pub nonce: String,
    pub transport_protocol: TransportProtocolDto,
    /// `ContactMode` numeric value: 0 = INLINE_KEYS, 1 = HASHED_KEYS, 2 = NO_KEYS.
    #[serde(default)]
    pub contact_mode: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mlkem_encapsulation_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ecies_public_key: Option<String>,
    /// SHA-384 commitment over the key material; present only under `HashedKeys`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact_binding_hash: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TransportProtocolDto {
    pub uri: String,
    pub protocol: String,
}

pub fn contact_to_dto(c: &derec_proto::ContactMessage) -> ContactMessageDto {
    let tp = c.transport_protocol.as_ref();
    ContactMessageDto {
        channel_id: c.channel_id.to_string(),
        nonce: c.nonce.to_string(),
        transport_protocol: TransportProtocolDto {
            uri: tp.map(|t| t.uri.clone()).unwrap_or_default(),
            protocol: String::from("https"),
        },
        contact_mode: c.contact_mode,
        mlkem_encapsulation_key: c
            .mlkem_encapsulation_key
            .as_ref()
            .map(|k| URL_SAFE_NO_PAD.encode(k)),
        ecies_public_key: c.ecies_public_key.as_ref().map(|k| URL_SAFE_NO_PAD.encode(k)),
        contact_binding_hash: c
            .contact_binding_hash
            .as_ref()
            .map(|h| URL_SAFE_NO_PAD.encode(h)),
    }
}

#[derive(Debug, Deserialize)]
pub struct SetStatusRequest {
    pub disabled: bool,
}

#[derive(Debug, Serialize)]
pub struct ToggleStatusResponse {
    pub disabled: bool,
}

/// POST /participants
///
/// Provisions one backend-run participant. The caller supplies the protocol
/// settings the new actor should run with — the front end owns configuration,
/// so there is no server-held policy to inherit. Omitted settings fall back to
/// the operator-supplied defaults served at `GET /config`.
pub async fn add(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AddParticipantRequest>,
) -> Response {
    let (timeout_secs, unpair_ack) = req.settings.resolve(&state.defaults);

    // `None`: a participant protects its own secret and never inherits an
    // owner's. Only a `Role::Replica` does, and only from an explicitly named
    // owner — see `provisioning::actor_secret_id`.
    let participant = provisioned_actor(Role::Participant, &req.name, &state.base_url, None);

    spawn_provisioned(&state, &participant, timeout_secs, unpair_ack);
    state.actors.register(participant.clone());

    info!(
        participant_id = %participant.id,
        name = %participant.name,
        "participant provisioned"
    );

    (
        StatusCode::CREATED,
        Json(AddParticipantResponse { actor: participant }),
    )
        .into_response()
}

/// Pick a display name for a participant being created.
///
/// `names` are consumed in creation order, not by pool position: the caller
/// cannot know how many it will need — that depends on what other owners have
/// already provisioned — so a caller offering two names for a two-participant
/// shortfall gets both used, whatever the resulting pool positions are.
///
/// The fallback numbers by pool position instead, so the label stays unique
/// across calls rather than restarting at 1 each time.
fn participant_name(names: &[String], taken: usize, pool_index: usize) -> String {
    names
        .get(taken)
        .filter(|n| !n.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| format!("Participant {}", pool_index + 1))
}

/// POST /participants/ensure
///
/// Bring the shared participant pool up to `total`, provisioning only the
/// shortfall. Every owner pairs with the same fixtures, so a second owner
/// asking for seven when seven already exist should get those seven rather
/// than another seven of its own.
///
/// The count-and-create is atomic inside the registry; doing it here — read the
/// count, then post the difference — would let two owners setting up at the
/// same moment each fill an empty pool.
pub async fn ensure(
    State(state): State<Arc<AppState>>,
    Json(req): Json<EnsureParticipantsRequest>,
) -> Response {
    let (timeout_secs, unpair_ack) = req.settings.resolve(&state.defaults);
    let names = req.names;
    let mut taken = 0usize;

    let EnsuredParticipants { created, participants } =
        state.actors.ensure_participants(req.total as usize, |pool_index| {
            let name = participant_name(&names, taken, pool_index);
            taken += 1;
            // `None`: a participant protects its own secret and never inherits
            // an owner's — see `provisioning::actor_secret_id`.
            provisioned_actor(Role::Participant, &name, &state.base_url, None)
        });

    // Spawning touches the arbiter and several maps, so it happens out here
    // rather than inside the registry lock.
    for participant in &created {
        spawn_provisioned(&state, participant, timeout_secs, unpair_ack);
    }

    info!(
        requested = req.total,
        created = created.len(),
        pool = participants.len(),
        "participant pool ensured"
    );

    (
        StatusCode::OK,
        Json(EnsureParticipantsResponse { created: created.len(), participants }),
    )
        .into_response()
}

/// POST /participants/:participant_id/toggle-status
///
/// Simulates the participant going offline/online. The role check matters:
/// `disabled_participants` is consulted by `deliver_message` for every actor,
/// so writing an owner's id into it would silently drop that owner's mail.
pub async fn toggle_status(
    State(state): State<Arc<AppState>>,
    Path(participant_id): Path<Uuid>,
    body: Option<Json<SetStatusRequest>>,
) -> Response {
    if let Err(response) = ensure_actor_role(&state, &participant_id, Role::Participant) {
        return response;
    }

    let want_disabled = match body {
        Some(Json(req)) => req.disabled,
        None => !state.disabled_participants.contains_key(&participant_id),
    };

    if want_disabled {
        state.disabled_participants.insert(participant_id, ());
    } else {
        state.disabled_participants.remove(&participant_id);
    }

    info!(
        participant_id = %participant_id,
        disabled = want_disabled,
        "participant status updated"
    );

    (
        StatusCode::OK,
        Json(ToggleStatusResponse { disabled: want_disabled }),
    )
        .into_response()
}

// ── Browser-published contacts ───────────────────────────────────────────────
//
// Contacts are scoped to a secret. Pairing binds both parties to one
// `secret_id`, and the responder's contact is minted by the protocol instance
// bound to it — so a node willing to help several owners publishes one contact
// per owner secret.

/// POST /participants/:participant_id/browser-contact
pub async fn post_browser_contact(
    State(state): State<Arc<AppState>>,
    Path(participant_id): Path<Uuid>,
    body: String,
) -> Response {
    if !state.actors.contains(&participant_id) {
        return not_found("actor not found");
    }

    state.browser_participant_contacts.insert(participant_id, body);
    info!(participant_id = %participant_id, "browser contact stored");

    StatusCode::OK.into_response()
}

/// GET /participants/:participant_id/browser-contact
pub async fn get_browser_contact(
    State(state): State<Arc<AppState>>,
    Path(participant_id): Path<Uuid>,
) -> Response {
    if !state.actors.contains(&participant_id) {
        return not_found("actor not found");
    }

    match state.browser_participant_contacts.get(&participant_id) {
        Some(contact) => (StatusCode::OK, contact.value().clone()).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

// ── Operator-driven channel linking ──────────────────────────────────────────
//
// A helper decides that a newly-paired channel belongs to an owner it already
// helps. That is an *authentication* step: nothing on the wire carries a
// trustworthy identity, so the protocol cannot infer it and neither can this
// backend. A real entity would link after a KYC flow; here an operator does it
// explicitly through these endpoints.

#[derive(Debug, Deserialize)]
pub struct LinkChannelsRequest {
    /// Channel to link *from* — typically the caller's own channel with this actor.
    pub channel_id: String,
    /// Existing channel the actor already holds for the same owner.
    pub link_to_channel_id: String,
}

#[derive(Debug, Serialize)]
pub struct ListChannelsResponse {
    pub channels: Vec<crate::actor::ChannelSummary>,
}

/// GET /participants/:participant_id/channels
///
/// Every channel this actor holds, so an operator can pick which one a newly
/// paired owner should be linked to.
pub async fn list_channels(
    State(state): State<Arc<AppState>>,
    Path(participant_id): Path<Uuid>,
) -> Response {
    if let Err(response) = ensure_actor_role(&state, &participant_id, Role::Participant) {
        return response;
    }

    let Some(addr) = provisioned_addr(&state, &participant_id) else {
        return not_found("participant has no backend protocol instance");
    };

    match addr.send(crate::actor::ListChannelsMsg).await {
        Ok(Ok(channels)) => {
            (StatusCode::OK, Json(ListChannelsResponse { channels })).into_response()
        }
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("list channels failed: {e}") })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("actor mailbox error: {e}") })),
        )
            .into_response(),
    }
}

/// POST /participants/:participant_id/link
pub async fn link_channels(
    State(state): State<Arc<AppState>>,
    Path(participant_id): Path<Uuid>,
    Json(req): Json<LinkChannelsRequest>,
) -> Response {
    if let Err(response) = ensure_actor_role(&state, &participant_id, Role::Participant) {
        return response;
    }

    let (Ok(channel_id), Ok(link_to_channel_id)) = (
        req.channel_id.parse::<u64>(),
        req.link_to_channel_id.parse::<u64>(),
    ) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "channel ids must be decimal u64 strings" })),
        )
            .into_response();
    };

    if channel_id == link_to_channel_id {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "cannot link a channel to itself" })),
        )
            .into_response();
    }

    let Some(addr) = provisioned_addr(&state, &participant_id) else {
        return not_found("participant has no backend protocol instance");
    };

    match addr
        .send(crate::actor::LinkChannelsMsg { channel_id, link_to_channel_id })
        .await
    {
        Ok(Ok(())) => {
            info!(
                participant_id = %participant_id,
                channel_id = channel_id,
                link_to_channel_id = link_to_channel_id,
                "operator linked channels"
            );
            (StatusCode::OK, Json(serde_json::json!({ "linked": true }))).into_response()
        }
        Ok(Err(e)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("link failed: {e}") })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": format!("actor mailbox error: {e}") })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::participant_name;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn offered_names_are_used_in_creation_order() {
        let offered = names(&["Ann", "Bo"]);

        // Pool positions 7 and 8, but the caller's first two names still apply:
        // it offered names for what it needs created, not for slots.
        assert_eq!(participant_name(&offered, 0, 7), "Ann");
        assert_eq!(participant_name(&offered, 1, 8), "Bo");
    }

    #[test]
    fn running_out_of_names_falls_back_to_the_pool_position() {
        // Numbered by pool position rather than by creation order, so the label
        // stays unique across calls instead of restarting at 1 each time.
        let offered = names(&["Ann"]);

        assert_eq!(participant_name(&offered, 1, 7), "Participant 8");
        assert_eq!(participant_name(&offered, 2, 8), "Participant 9");
    }

    #[test]
    fn no_names_at_all_is_fine() {
        assert_eq!(participant_name(&[], 0, 0), "Participant 1");
    }

    #[test]
    fn a_blank_name_falls_back_rather_than_rendering_an_empty_row() {
        let offered = names(&["", "   "]);

        assert_eq!(participant_name(&offered, 0, 0), "Participant 1");
        assert_eq!(participant_name(&offered, 1, 1), "Participant 2");
    }
}
