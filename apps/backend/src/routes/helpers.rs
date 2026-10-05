// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{
    Json,
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use tracing::info;
use uuid::Uuid;

use crate::{
    models::{
        Actor, AddHelperRequest, AddHelperResponse, EnsureHelpersRequest, EnsureHelpersResponse,
        Role, TransportBreakdown, TransportMode, validate_display_name,
    },
    provisioning::{provisioned_actor, spawn_provisioned},
    registry::actors::{NameTaken, names_match},
    routes::actor_guard::{ensure_actor_role, not_found},
    routes::actors::provisioned_addr,
    routes::api_error::{ApiBytes, ApiError, ApiJson, ApiPath},
    sql::channel::SqlChannelStore,
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
    /// The singular endpoint the SDK removed at 0.0.6. Never written any more;
    /// read only as a fallback, so a contact pasted from an older build of this
    /// app still pairs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport_protocol: Option<TransportProtocolDto>,
    /// Every endpoint the sender serves, in the sender's own preference order.
    /// Defaulted so a contact produced by an older peer still deserializes;
    /// [`ContactMessageDto::endpoints`] falls back to the singular field.
    #[serde(default)]
    pub supported_transports: Vec<TransportProtocolDto>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransportProtocolDto {
    pub uri: String,
    /// Lowercase name of the `Protocol` discriminant: `"https"` or `"grpc"`.
    /// An unrecognised value is read as HTTPS, matching protobuf's treatment
    /// of an unknown enum value on the wire.
    pub protocol: String,
}

impl TransportProtocolDto {
    pub fn from_proto(t: &derec_proto::TransportProtocol) -> Self {
        let protocol = match derec_proto::Protocol::try_from(t.protocol) {
            Ok(derec_proto::Protocol::Grpc) => "grpc",
            _ => "https",
        };
        Self {
            uri: t.uri.clone(),
            protocol: protocol.to_owned(),
        }
    }

    pub fn to_proto(&self) -> derec_proto::TransportProtocol {
        let protocol = match self.protocol.as_str() {
            "grpc" => derec_proto::Protocol::Grpc,
            _ => derec_proto::Protocol::Https,
        };
        derec_proto::TransportProtocol {
            uri: self.uri.clone(),
            protocol: protocol as i32,
        }
    }
}

impl ContactMessageDto {
    /// The endpoints this contact advertises, preferring the list and falling
    /// back to the deprecated singular field for a peer that predates it.
    ///
    /// Empty when the contact names no endpoint at all, which a caller must
    /// refuse: there is nowhere to send the pairing request.
    pub fn endpoints(&self) -> Vec<derec_proto::TransportProtocol> {
        if self.supported_transports.is_empty() {
            self.transport_protocol
                .iter()
                .map(TransportProtocolDto::to_proto)
                .collect()
        } else {
            self.supported_transports
                .iter()
                .map(TransportProtocolDto::to_proto)
                .collect()
        }
    }
}

pub fn contact_to_dto(c: &derec_proto::ContactMessage) -> ContactMessageDto {
    let supported_transports: Vec<TransportProtocolDto> = c
        .supported_transports
        .iter()
        .map(TransportProtocolDto::from_proto)
        .collect();

    ContactMessageDto {
        channel_id: c.channel_id.to_string(),
        nonce: c.nonce.to_string(),
        transport_protocol: None,
        supported_transports,
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

/// POST /helpers
///
/// Provisions one backend-run helper. The caller supplies the protocol
/// settings the new actor should run with — the front end owns configuration,
/// so there is no server-held policy to inherit. Omitted settings fall back to
/// the operator-supplied defaults served at `GET /config`.
///
/// Registered before it is spawned: a running actor nothing lists is an orphan
/// that ticks against the database until the process ends, while a listed
/// actor that failed to start is a row this handler can take back.
pub async fn add(
    State(state): State<Arc<AppState>>,
    ApiJson(req): ApiJson<AddHelperRequest>,
) -> Response {
    let name = match validate_display_name(&req.name, "name") {
        Ok(name) => name,
        Err(message) => return ApiError::bad_request(message).into_response(),
    };
    if let Err(message) = req.settings.validate() {
        return ApiError::bad_request(message).into_response();
    }

    if !state.defaults.grpc_enabled && req.transport_mode != TransportMode::Http {
        // Not a silent downgrade: a helper advertising an endpoint nothing is
        // listening on pairs successfully and then black-holes every reply.
        return ApiError::bad_request("gRPC helper requested but grpc_enabled is false")
            .into_response();
    }

    let (timeout_secs, unpair_ack) = req.settings.resolve(&state.defaults);

    // Every actor protects its own secret. Mirroring an owner's vault is an
    // extra protocol *instance* bound to that owner's secret, added on demand
    // when a replica-mode contact is minted — see `provisioning::actor_secret_id`.
    let helper = provisioned_actor(
        Role::Helper,
        &name,
        &state.base_url,
        &state.grpc_authority(),
        req.transport_mode,
    );

    // Minted here rather than inside `spawn_provisioned`, so the value stored
    // is the value the actor runs with — a respawn reads it back rather than
    // inventing a new one, which would make this helper a stranger to every
    // replica group holding its old id.
    let settings = crate::registry::actors::ActorSettings {
        replica_id: rand::random::<u64>(),
        timeout_secs,
        unpair_ack,
    };

    match state
        .actors
        .register_helper(helper.clone(), settings.clone())
        .await
    {
        Ok(Ok(())) => {}
        Ok(Err(NameTaken)) => {
            return ApiError::conflict(format!(
                "a helper named \"{name}\" already exists; choose another name"
            ))
            .into_response();
        }
        Err(e) => return crate::routes::actor_guard::registry_unavailable(e),
    }

    if let Err(e) = spawn_provisioned(&state, &helper, &settings) {
        // Take the row back, so the pool does not list a helper nobody runs.
        // If that fails too the row stays, and the next boot's recovery tries
        // to spawn it again — logged either way.
        if let Err(remove) = state.actors.remove(&helper.id).await {
            tracing::error!(
                helper_id = %helper.id,
                error = %remove,
                "could not unregister a helper that failed to start"
            );
        }
        tracing::error!(helper_id = %helper.id, error = %e, "helper failed to start");
        return ApiError::internal("helper could not be started").into_response();
    }

    info!(
        helper_id = %helper.id,
        name = %helper.name,
        "helper provisioned"
    );

    (
        StatusCode::CREATED,
        Json(AddHelperResponse { actor: helper }),
    )
        .into_response()
}

/// Pick a display name for a helper being created, unique within `pool`.
///
/// `names` are consumed in creation order, not by pool position: the caller
/// cannot know how many it will need — that depends on what other owners have
/// already provisioned — so a caller offering two names for a two-helper
/// shortfall gets both used, whatever the resulting pool positions are.
///
/// The name offered for this creation is used unless a helper already has it
/// (see [`names_match`]); then the next offered name nobody holds is used
/// instead. That keeps a wizard that always offers the same names working
/// against a pool that already holds some of them — and keeps `POST
/// /helpers/ensure` from minting the duplicates `POST /helpers` refuses. A
/// blank entry still means "number this one".
///
/// The fallback numbers by pool position, so the label stays unique across
/// calls rather than restarting at 1 each time, and moves past any number a
/// helper already carries. Offered names have already been checked by
/// [`validate_offered_names`]; this only trims them.
fn helper_name(names: &[String], taken: usize, pool_index: usize, pool: &[Actor]) -> String {
    let in_use = |candidate: &str| pool.iter().any(|a| names_match(&a.name, candidate));

    let offered = names.get(taken).map(|n| n.trim()).filter(|n| !n.is_empty());
    if offered.is_some() {
        let free = names
            .iter()
            .skip(taken)
            .map(|n| n.trim())
            .filter(|n| !n.is_empty())
            .find(|n| !in_use(n));
        if let Some(name) = free {
            return name.to_owned();
        }
    }

    // Terminates: `pool` is finite, so some number past it is free.
    let mut number = pool_index + 1;
    loop {
        let label = format!("Participant {number}");
        if !in_use(&label) {
            return label;
        }
        number += 1;
    }
}

/// Refuse an offered name that would be refused on `POST /helpers`.
///
/// A blank entry is allowed — it means "number this one" — but a name that is
/// too long, or carries control characters, is a caller error rather than
/// something to truncate silently.
fn validate_offered_names(names: &[String]) -> Result<(), String> {
    for (i, name) in names.iter().enumerate() {
        if name.trim().is_empty() {
            continue;
        }
        validate_display_name(name, &format!("names[{i}]"))?;
    }
    Ok(())
}

/// POST /helpers/ensure
///
/// Bring the shared helper pool up to `total`, provisioning only the
/// shortfall. Every owner pairs with the same fixtures, so a second owner
/// asking for seven when seven already exist should get those seven rather
/// than another seven of its own.
///
/// The count-and-create is atomic inside the registry; doing it here — read the
/// count, then post the difference — would let two owners setting up at the
/// same moment each fill an empty pool.
pub async fn ensure(
    State(state): State<Arc<AppState>>,
    ApiJson(req): ApiJson<EnsureHelpersRequest>,
) -> Response {
    // `MAX_POOL_SIZE` is `u8::MAX`, so the conversion is the whole check.
    let Ok(total) = u8::try_from(req.total) else {
        return ApiError::bad_request(format!(
            "total must be at most {} (got {})",
            crate::models::MAX_POOL_SIZE,
            req.total
        ))
        .into_response();
    };
    if let Err(message) = validate_offered_names(&req.names) {
        return ApiError::bad_request(message).into_response();
    }
    if let Err(message) = req.settings.validate() {
        return ApiError::bad_request(message).into_response();
    }

    let want = match req.transports {
        Some(breakdown) => {
            if breakdown.total() != total as usize {
                return ApiError::bad_request("transports must sum to total").into_response();
            }
            if !state.defaults.grpc_enabled && (breakdown.grpc > 0 || breakdown.both > 0) {
                // Not a silent downgrade: a helper advertising an endpoint
                // nothing is listening on pairs successfully and then
                // black-holes every reply.
                return ApiError::bad_request("gRPC helpers requested but grpc_enabled is false")
                    .into_response();
            }
            breakdown
        }
        None => TransportBreakdown { http: total, grpc: 0, both: 0 },
    };

    let (timeout_secs, unpair_ack) = req.settings.resolve(&state.defaults);
    let names = req.names;

    let ensured = state
            .actors
            .ensure_participants_by_mode(want, |taken, pool_index, mode, pool| {
                // Every actor protects its own secret — see
                // `provisioning::actor_secret_id`.
                let actor = provisioned_actor(
                    Role::Helper,
                    &helper_name(&names, taken, pool_index, pool),
                    &state.base_url,
                    &state.grpc_authority(),
                    mode,
                );
                // Minted with the actor and stored in the same transaction, so
                // the row a respawn reads back is the one this helper ran with.
                let settings = crate::registry::actors::ActorSettings {
                    replica_id: rand::random::<u64>(),
                    timeout_secs,
                    unpair_ack,
                };
                (actor, settings)
            })
            .await;

    let EnsuredParticipants { created, participants: mut helpers } = match ensured {
        Ok(ensured) => ensured,
        Err(e) => return crate::routes::actor_guard::registry_unavailable(e),
    };

    // Spawning touches the arbiter and several maps, so it happens out here
    // rather than inside the registry transaction.
    let mut started = 0usize;
    for helper in &created {
        // Read back rather than re-minted, so the running actor and its row
        // agree on `replica_id`.
        let spawned = match state.actors.settings(&helper.id).await {
            Ok(Some(stored)) => spawn_provisioned(&state, helper, &stored).map_err(|e| e.to_string()),
            Ok(None) => Err("no stored settings for a just-created helper".to_owned()),
            Err(e) => Err(e.to_string()),
        };

        match spawned {
            Ok(()) => started += 1,
            Err(reason) => {
                // Unlisted again rather than left as a row nothing runs; the
                // next `ensure` sees the shortfall and creates a replacement.
                tracing::error!(helper_id = %helper.id, reason = %reason, "helper failed to start");
                if let Err(e) = state.actors.remove(&helper.id).await {
                    tracing::error!(
                        helper_id = %helper.id,
                        error = %e,
                        "could not unregister a helper that failed to start"
                    );
                }
                helpers.retain(|h| h.id != helper.id);
            }
        }
    }

    if started < created.len() {
        return ApiError::internal(format!(
            "{} of {} new helpers could not be started",
            created.len() - started,
            created.len()
        ))
        .into_response();
    }

    info!(
        requested = total,
        created = created.len(),
        pool = helpers.len(),
        "helper pool ensured"
    );

    (
        StatusCode::OK,
        Json(EnsureHelpersResponse { created: created.len(), helpers }),
    )
        .into_response()
}

/// POST /helpers/:helper_id/toggle-status
///
/// Simulates the helper going offline/online. The role check matters:
/// `disabled_helpers` is consulted by `deliver_message` for every actor,
/// so writing an owner's id into it would silently drop that owner's mail.
///
/// The body is optional, and its absence means "toggle". Absence is decided
/// the way Axum decides it for an optional JSON body: **no `Content-Type`
/// header**. A request that does send `Content-Type: application/json` must
/// carry `{"disabled": bool}` — an empty or malformed body is `400`, a wrong
/// shape `422`, and any other content type `415`.
pub async fn toggle_status(
    State(state): State<Arc<AppState>>,
    ApiPath(helper_id): ApiPath<Uuid>,
    body: Option<ApiJson<SetStatusRequest>>,
) -> Response {
    if let Err(response) = ensure_actor_role(&state, &helper_id, Role::Helper).await {
        return response;
    }

    let currently = match state.disabled_helpers.is_disabled(&helper_id).await {
        Ok(current) => current,
        Err(e) => return crate::routes::actor_guard::registry_unavailable(e),
    };

    // No body means "toggle".
    let want_disabled = match body {
        Some(ApiJson(req)) => req.disabled,
        None => !currently,
    };

    if let Err(e) = state
        .disabled_helpers
        .set_disabled(&helper_id, want_disabled)
        .await
    {
        return crate::routes::actor_guard::registry_unavailable(e);
    }

    info!(
        helper_id = %helper_id,
        disabled = want_disabled,
        "helper status updated"
    );

    (
        StatusCode::OK,
        Json(ToggleStatusResponse { disabled: want_disabled }),
    )
        .into_response()
}

/// DELETE /helpers/:helper_id
///
/// Erase a provisioned participant: its actor, its stores and its registry
/// entry. The pool is server-wide, so this affects every owner using it — and
/// an owner paired with it keeps its channel, which from then on behaves like a
/// peer that has gone offline. Unpairing from the owner's side is how that row
/// is cleared; the backend cannot reach into a browser to do it.
pub async fn delete(
    State(state): State<Arc<AppState>>,
    ApiPath(helper_id): ApiPath<Uuid>,
) -> Response {
    // Guards both that it exists and that it is ours to delete: a
    // browser-managed actor belongs to the page driving it.
    if let Err(response) = ensure_actor_role(&state, &helper_id, Role::Helper).await {
        return response;
    }

    match crate::deletion::delete_participant(&state, helper_id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => crate::routes::actor_guard::registry_unavailable(e),
    }
}

// ── Browser-published contacts ───────────────────────────────────────────────
//
// Contacts are scoped to a secret. Pairing binds both parties to one
// `secret_id`, and the responder's contact is minted by the protocol instance
// bound to it — so a node willing to help several owners publishes one contact
// per owner secret.
//
// The backend stores the page's serialized contact and hands it back byte for
// byte: it is the browser's format, and re-encoding it here would make this
// endpoint a second owner of that shape. What it does check is that the body
// is a JSON object of a contact's size, so `GET` can honestly answer
// `application/json`.

/// The largest contact a browser may publish, in bytes. An inline-keys contact
/// — the largest mode, carrying an ML-KEM-768 key — is under 3 KiB as JSON.
const MAX_CONTACT_BYTES: usize = 16 * 1024;

/// POST /helpers/:helper_id/browser-contact
pub async fn post_browser_contact(
    State(state): State<Arc<AppState>>,
    ApiPath(helper_id): ApiPath<Uuid>,
    ApiBytes(body): ApiBytes,
) -> Response {
    match state.actors.contains(&helper_id).await {
        Ok(false) => return not_found("actor not found"),
        Err(e) => return crate::routes::actor_guard::registry_unavailable(e),
        Ok(true) => {}
    }

    if body.len() > MAX_CONTACT_BYTES {
        return ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("a contact may be at most {MAX_CONTACT_BYTES} bytes"),
        )
        .into_response();
    }
    let contact = match std::str::from_utf8(&body) {
        Ok(text)
            if serde_json::from_str::<serde_json::Value>(text)
                .is_ok_and(|value| value.is_object()) =>
        {
            text
        }
        _ => {
            return ApiError::bad_request("the contact must be a JSON object").into_response();
        }
    };

    if let Err(e) = state
        .browser_participant_contacts
        .put(&helper_id, contact)
        .await
    {
        return crate::routes::actor_guard::registry_unavailable(e);
    }
    info!(helper_id = %helper_id, "browser contact stored");

    StatusCode::OK.into_response()
}

/// GET /helpers/:helper_id/browser-contact
///
/// The stored contact exactly as it was posted, as `application/json`.
pub async fn get_browser_contact(
    State(state): State<Arc<AppState>>,
    ApiPath(helper_id): ApiPath<Uuid>,
) -> Response {
    match state.actors.contains(&helper_id).await {
        Ok(false) => return not_found("actor not found"),
        Err(e) => return crate::routes::actor_guard::registry_unavailable(e),
        Ok(true) => {}
    }

    match state.browser_participant_contacts.get(&helper_id).await {
        Ok(Some(contact)) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            contact,
        )
            .into_response(),
        Ok(None) => not_found("this actor has not published a contact"),
        Err(e) => crate::routes::actor_guard::registry_unavailable(e),
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

/// GET /helpers/:helper_id/channels
///
/// Every channel this actor holds, so an operator can pick which one a newly
/// paired owner should be linked to.
pub async fn list_channels(
    State(state): State<Arc<AppState>>,
    ApiPath(helper_id): ApiPath<Uuid>,
) -> Response {
    if let Err(response) = ensure_actor_role(&state, &helper_id, Role::Helper).await {
        return response;
    }

    let Some(addr) = provisioned_addr(&state, &helper_id) else {
        return not_found("helper has no backend protocol instance");
    };

    match addr.send(crate::actor::ListChannelsMsg).await {
        Ok(Ok(channels)) => {
            (StatusCode::OK, Json(ListChannelsResponse { channels })).into_response()
        }
        Ok(Err(e)) => ApiError::from_protocol("listing channels", &e).into_response(),
        Err(e) => ApiError::actor_unavailable(e).into_response(),
    }
}

/// POST /helpers/:helper_id/link
///
/// Both channels must be helper channels this actor holds on its own instance
/// — the one linking acts on. Naming one it does not hold is `404`: linking it
/// anyway would write a link to nothing, which `linked_channels` then reports
/// as a real channel when the helper looks for shares.
pub async fn link_channels(
    State(state): State<Arc<AppState>>,
    ApiPath(helper_id): ApiPath<Uuid>,
    ApiJson(req): ApiJson<LinkChannelsRequest>,
) -> Response {
    let helper = match ensure_actor_role(&state, &helper_id, Role::Helper).await {
        Ok(helper) => helper,
        Err(response) => return response,
    };

    let (Ok(channel_id), Ok(link_to_channel_id)) = (
        req.channel_id.parse::<u64>(),
        req.link_to_channel_id.parse::<u64>(),
    ) else {
        return ApiError::bad_request("channel ids must be decimal u64 strings").into_response();
    };

    if channel_id == link_to_channel_id {
        return ApiError::bad_request("cannot link a channel to itself").into_response();
    }

    let Some(addr) = provisioned_addr(&state, &helper_id) else {
        return not_found("helper has no backend protocol instance");
    };

    let Ok(own_secret) = helper.secret_id.parse::<u64>() else {
        tracing::error!(helper_id = %helper_id, "helper has an unparseable secret_id");
        return ApiError::internal("helper record is unreadable").into_response();
    };
    let store = SqlChannelStore::new(state.pool.clone(), helper_id.to_string());
    for (field, id) in [("channel_id", channel_id), ("link_to_channel_id", link_to_channel_id)] {
        match store.holds_channel(id, Some(own_secret)).await {
            Ok(true) => {}
            Ok(false) => {
                return not_found(&format!("this helper holds no channel {id} (`{field}`)"));
            }
            Err(e) => {
                tracing::error!(helper_id = %helper_id, error = %e, "channel store unreadable");
                return ApiError::internal("channel store unavailable").into_response();
            }
        }
    }

    match addr
        .send(crate::actor::LinkChannelsMsg { channel_id, link_to_channel_id })
        .await
    {
        Ok(Ok(())) => {
            info!(
                helper_id = %helper_id,
                channel_id = channel_id,
                link_to_channel_id = link_to_channel_id,
                "operator linked channels"
            );
            (StatusCode::OK, Json(serde_json::json!({ "linked": true }))).into_response()
        }
        Ok(Err(e)) => ApiError::from_protocol("linking", &e).into_response(),
        Err(e) => ApiError::actor_unavailable(e).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::helper_name;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    fn pool_named(v: &[&str]) -> Vec<crate::models::Actor> {
        v.iter()
            .map(|name| {
                crate::provisioning::provisioned_actor(
                    crate::models::Role::Helper,
                    name,
                    "http://localhost:5000",
                    "localhost:50051",
                    crate::models::TransportMode::Http,
                )
            })
            .collect()
    }

    #[test]
    fn offered_names_are_used_in_creation_order() {
        let offered = names(&["Ann", "Bo"]);

        // Pool positions 7 and 8, but the caller's first two names still apply:
        // it offered names for what it needs created, not for slots.
        assert_eq!(helper_name(&offered, 0, 7, &[]), "Ann");
        assert_eq!(helper_name(&offered, 1, 8, &[]), "Bo");
    }

    #[test]
    fn running_out_of_names_falls_back_to_the_pool_position() {
        // Numbered by pool position rather than by creation order, so the label
        // stays unique across calls instead of restarting at 1 each time.
        let offered = names(&["Ann"]);

        assert_eq!(helper_name(&offered, 1, 7, &[]), "Participant 8");
        assert_eq!(helper_name(&offered, 2, 8, &[]), "Participant 9");
    }

    #[test]
    fn no_names_at_all_is_fine() {
        assert_eq!(helper_name(&[], 0, 0, &[]), "Participant 1");
    }

    #[test]
    fn a_blank_name_falls_back_rather_than_rendering_an_empty_row() {
        let offered = names(&["", "   "]);

        assert_eq!(helper_name(&offered, 0, 0, &[]), "Participant 1");
        assert_eq!(helper_name(&offered, 1, 1, &[]), "Participant 2");
    }

    #[test]
    fn an_offered_name_the_pool_already_has_is_skipped_for_the_next_free_one() {
        // A wizard offering the same names every time, against a pool that
        // already holds the first of them, case aside.
        let offered = names(&["Alex", "Richard", "Bob"]);
        let pool = pool_named(&["alex"]);

        assert_eq!(helper_name(&offered, 0, 1, &pool), "Richard");
    }

    #[test]
    fn when_every_offered_name_is_taken_the_fallback_is_used() {
        let offered = names(&["Alex"]);
        let pool = pool_named(&["Alex"]);

        assert_eq!(helper_name(&offered, 0, 1, &pool), "Participant 2");
    }

    #[test]
    fn the_numbered_fallback_moves_past_a_number_already_in_use() {
        // A helper someone named "Participant 3" by hand.
        let pool = pool_named(&["Ann", "Bo", "Participant 3"]);

        assert_eq!(helper_name(&[], 0, 2, &pool), "Participant 4");
    }

    #[test]
    fn a_mixed_mode_shortfall_names_every_new_helper_distinctly() {
        // Reproduces the wizard's "1 http, 1 grpc, 1 both" request against an
        // empty pool: `ensure_participants_by_mode` runs a separate `existing
        // .. target` loop per mode, so a caller wiring `helper_name` off that
        // loop's own index (as `ensure` used to) calls it with the same index
        // three times and mints three helpers named identically.
        use crate::models::{Role, TransportBreakdown};
        use crate::provisioning::provisioned_actor;
        use crate::state::ActorRegistry;

        let registry = ActorRegistry::default();
        let offered: Vec<String> = Vec::new();

        let want = TransportBreakdown { http: 1, grpc: 1, both: 1 };
        let result = registry.ensure_participants_by_mode(want, |taken, pool_index, mode| {
            provisioned_actor(
                Role::Helper,
                &helper_name(&offered, taken, pool_index, &[]),
                "http://localhost:5000",
                "localhost:50051",
                mode,
            )
        });

        let mut created_names: Vec<String> =
            result.created.iter().map(|a| a.name.clone()).collect();
        assert_eq!(created_names.len(), 3);

        created_names.sort();
        created_names.dedup();
        assert_eq!(
            created_names.len(),
            3,
            "every helper in a mixed-mode shortfall must get a distinct fallback name"
        );
    }

    // ── Contact endpoints ──────────────────────────────────────────────────
    //
    // `transportProtocol` is deprecated in favour of `supportedTransports` and
    // goes away at SDK 0.0.5, so this seam has to read both: the list from a
    // current peer, the singular field from one that predates it.

    mod contact_endpoints {
        use super::super::{ContactMessageDto, TransportProtocolDto, contact_to_dto};

        fn dto(
            singular: TransportProtocolDto,
            list: Vec<TransportProtocolDto>,
        ) -> ContactMessageDto {
            ContactMessageDto {
                channel_id: "18446744073709551615".to_owned(),
                nonce: "7".to_owned(),
                transport_protocol: Some(singular),
                supported_transports: list,
                contact_mode: 0,
                mlkem_encapsulation_key: None,
                ecies_public_key: None,
                contact_binding_hash: None,
            }
        }

        fn tp(uri: &str, protocol: &str) -> TransportProtocolDto {
            TransportProtocolDto {
                uri: uri.to_owned(),
                protocol: protocol.to_owned(),
            }
        }

        #[test]
        fn the_list_wins_when_present() {
            let endpoints = dto(
                tp("https://a.example", "https"),
                vec![tp("https://a.example", "https"), tp("grpcs://a.example:443", "grpc")],
            )
            .endpoints();

            assert_eq!(endpoints.len(), 2);
            assert_eq!(endpoints[0].uri, "https://a.example");
            assert_eq!(endpoints[1].protocol, derec_proto::Protocol::Grpc as i32);
        }

        #[test]
        fn an_empty_list_falls_back_to_the_deprecated_singular_field() {
            let endpoints = dto(tp("https://a.example", "https"), Vec::new()).endpoints();

            assert_eq!(endpoints.len(), 1);
            assert_eq!(endpoints[0].uri, "https://a.example");
            assert_eq!(endpoints[0].protocol, derec_proto::Protocol::Https as i32);
        }

        #[test]
        fn an_unknown_protocol_name_reads_as_https_like_an_unknown_enum_on_the_wire() {
            let endpoints = dto(tp("ws://a.example", "websocket"), Vec::new()).endpoints();

            assert_eq!(endpoints[0].protocol, derec_proto::Protocol::Https as i32);
        }

        #[test]
        fn the_dto_carries_the_endpoint_list_and_no_singular_field() {
            // SDK 0.0.6 removed the singular endpoint from the protocol; the
            // DTO stops writing it too, and every endpoint travels in the list.
            let contact = derec_proto::ContactMessage {
                channel_id: 1,
                nonce: 7,
                supported_transports: vec![
                    derec_proto::TransportProtocol {
                        uri: "grpcs://a.example:443".to_owned(),
                        protocol: derec_proto::Protocol::Grpc as i32,
                    },
                    derec_proto::TransportProtocol {
                        uri: "https://a.example".to_owned(),
                        protocol: derec_proto::Protocol::Https as i32,
                    },
                ],
                contact_mode: 0,
                mlkem_encapsulation_key: None,
                ecies_public_key: None,
                contact_binding_hash: None,
                timestamp: None,
            };

            let dto = contact_to_dto(&contact);

            assert_eq!(dto.supported_transports.len(), 2);
            assert_eq!(dto.supported_transports[0].uri, "grpcs://a.example:443");
            assert_eq!(dto.supported_transports[0].protocol, "grpc");
            assert!(dto.transport_protocol.is_none());
        }

        #[test]
        fn a_contact_with_only_the_list_deserializes() {
            // What a creator past the deprecation sends: the proto says
            // reading the singular field directly is now wrong, so a contact
            // without it must still be accepted.
            let json = r#"{
                "channel_id": "1",
                "nonce": "7",
                "supported_transports": [{ "uri": "grpc://a:1", "protocol": "grpc" }]
            }"#;

            let dto: ContactMessageDto = serde_json::from_str(json).expect("deserializes");

            assert!(dto.transport_protocol.is_none());
            assert_eq!(dto.endpoints().len(), 1);
            assert_eq!(dto.endpoints()[0].uri, "grpc://a:1");
        }

        #[test]
        fn a_contact_naming_no_endpoint_has_none_to_offer() {
            let json = r#"{ "channel_id": "1", "nonce": "7" }"#;

            let dto: ContactMessageDto = serde_json::from_str(json).expect("deserializes");

            assert!(dto.endpoints().is_empty(), "the caller must refuse this contact");
        }
    }

    mod offered_names {
        use super::super::validate_offered_names;

        #[test]
        fn blank_entries_are_allowed_and_mean_number_this_one() {
            assert!(validate_offered_names(&["".to_owned(), "  ".to_owned()]).is_ok());
        }

        #[test]
        fn an_over_long_name_is_refused_and_named() {
            let long = "x".repeat(crate::models::MAX_NAME_CHARS + 1);
            let error = validate_offered_names(&["ok".to_owned(), long])
                .expect_err("an over-long name is refused");

            assert!(error.contains("names[1]"), "{error}");
        }
    }
}
