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
        AddHelperRequest, AddHelperResponse, EnsureHelpersRequest, EnsureHelpersResponse, Role,
        TransportBreakdown, TransportMode,
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
    /// Deprecated on the wire since SDK 0.0.3 and removed at 0.0.5, but still
    /// what a peer predating `supported_transports` reads, so a sender must
    /// keep it filled with the first entry of the list.
    pub transport_protocol: TransportProtocolDto,
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
    pub fn endpoints(&self) -> Vec<derec_proto::TransportProtocol> {
        if self.supported_transports.is_empty() {
            vec![self.transport_protocol.to_proto()]
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

    // The singular field mirrors the first entry of the list; the library
    // fills it that way on the wire, and a DTO that disagreed with it would
    // hand a pre-0.0.3 reader a different endpoint than a current one.
    #[allow(deprecated)]
    let singular = c
        .transport_protocol
        .as_ref()
        .map(TransportProtocolDto::from_proto);

    ContactMessageDto {
        channel_id: c.channel_id.to_string(),
        nonce: c.nonce.to_string(),
        transport_protocol: singular
            .or_else(|| supported_transports.first().cloned())
            .unwrap_or_else(|| TransportProtocolDto {
                uri: String::new(),
                protocol: String::from("https"),
            }),
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
pub async fn add(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AddHelperRequest>,
) -> Response {
    if !state.defaults.grpc_enabled && req.transport_mode != TransportMode::Http {
        // Not a silent downgrade: a helper advertising an endpoint nothing is
        // listening on pairs successfully and then black-holes every reply.
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "gRPC helper requested but grpc_enabled is false"
            })),
        )
            .into_response();
    }

    let (timeout_secs, unpair_ack) = req.settings.resolve(&state.defaults);

    // Every actor protects its own secret. Mirroring an owner's vault is an
    // extra protocol *instance* bound to that owner's secret, added on demand
    // when a replica-mode contact is minted — see `provisioning::actor_secret_id`.
    let helper = provisioned_actor(
        Role::Helper,
        &req.name,
        &state.base_url,
        &state.grpc_authority(),
        req.transport_mode,
    );

    spawn_provisioned(&state, &helper, timeout_secs, unpair_ack);
    state.actors.register(helper.clone());

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

/// Pick a display name for a helper being created.
///
/// `names` are consumed in creation order, not by pool position: the caller
/// cannot know how many it will need — that depends on what other owners have
/// already provisioned — so a caller offering two names for a two-helper
/// shortfall gets both used, whatever the resulting pool positions are.
///
/// The fallback numbers by pool position instead, so the label stays unique
/// across calls rather than restarting at 1 each time.
fn helper_name(names: &[String], taken: usize, pool_index: usize) -> String {
    names
        .get(taken)
        .filter(|n| !n.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| format!("Participant {}", pool_index + 1))
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
    Json(req): Json<EnsureHelpersRequest>,
) -> Response {
    let want = match req.transports {
        Some(breakdown) => {
            if breakdown.total() != req.total as usize {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "transports must sum to total"
                    })),
                )
                    .into_response();
            }
            if !state.defaults.grpc_enabled && (breakdown.grpc > 0 || breakdown.both > 0) {
                // Not a silent downgrade: a helper advertising an endpoint
                // nothing is listening on pairs successfully and then
                // black-holes every reply.
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "gRPC helpers requested but grpc_enabled is false"
                    })),
                )
                    .into_response();
            }
            breakdown
        }
        None => TransportBreakdown { http: req.total, grpc: 0, both: 0 },
    };

    let (timeout_secs, unpair_ack) = req.settings.resolve(&state.defaults);
    let names = req.names;

    let EnsuredParticipants { created, participants: helpers } =
        state
            .actors
            .ensure_participants_by_mode(want, |taken, pool_index, mode| {
                // Every actor protects its own secret — see
                // `provisioning::actor_secret_id`.
                provisioned_actor(
                    Role::Helper,
                    &helper_name(&names, taken, pool_index),
                    &state.base_url,
                    &state.grpc_authority(),
                    mode,
                )
            });

    // Spawning touches the arbiter and several maps, so it happens out here
    // rather than inside the registry lock.
    for helper in &created {
        spawn_provisioned(&state, helper, timeout_secs, unpair_ack);
    }

    info!(
        requested = req.total,
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
pub async fn toggle_status(
    State(state): State<Arc<AppState>>,
    Path(helper_id): Path<Uuid>,
    body: Option<Json<SetStatusRequest>>,
) -> Response {
    if let Err(response) = ensure_actor_role(&state, &helper_id, Role::Helper) {
        return response;
    }

    let want_disabled = match body {
        Some(Json(req)) => req.disabled,
        None => !state.disabled_helpers.contains_key(&helper_id),
    };

    if want_disabled {
        state.disabled_helpers.insert(helper_id, ());
    } else {
        state.disabled_helpers.remove(&helper_id);
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

// ── Browser-published contacts ───────────────────────────────────────────────
//
// Contacts are scoped to a secret. Pairing binds both parties to one
// `secret_id`, and the responder's contact is minted by the protocol instance
// bound to it — so a node willing to help several owners publishes one contact
// per owner secret.

/// POST /helpers/:helper_id/browser-contact
pub async fn post_browser_contact(
    State(state): State<Arc<AppState>>,
    Path(helper_id): Path<Uuid>,
    body: String,
) -> Response {
    if !state.actors.contains(&helper_id) {
        return not_found("actor not found");
    }

    state.browser_participant_contacts.insert(helper_id, body);
    info!(helper_id = %helper_id, "browser contact stored");

    StatusCode::OK.into_response()
}

/// GET /helpers/:helper_id/browser-contact
pub async fn get_browser_contact(
    State(state): State<Arc<AppState>>,
    Path(helper_id): Path<Uuid>,
) -> Response {
    if !state.actors.contains(&helper_id) {
        return not_found("actor not found");
    }

    match state.browser_participant_contacts.get(&helper_id) {
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

/// GET /helpers/:helper_id/channels
///
/// Every channel this actor holds, so an operator can pick which one a newly
/// paired owner should be linked to.
pub async fn list_channels(
    State(state): State<Arc<AppState>>,
    Path(helper_id): Path<Uuid>,
) -> Response {
    if let Err(response) = ensure_actor_role(&state, &helper_id, Role::Helper) {
        return response;
    }

    let Some(addr) = provisioned_addr(&state, &helper_id) else {
        return not_found("helper has no backend protocol instance");
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

/// POST /helpers/:helper_id/link
pub async fn link_channels(
    State(state): State<Arc<AppState>>,
    Path(helper_id): Path<Uuid>,
    Json(req): Json<LinkChannelsRequest>,
) -> Response {
    if let Err(response) = ensure_actor_role(&state, &helper_id, Role::Helper) {
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

    let Some(addr) = provisioned_addr(&state, &helper_id) else {
        return not_found("helper has no backend protocol instance");
    };

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
    use super::helper_name;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn offered_names_are_used_in_creation_order() {
        let offered = names(&["Ann", "Bo"]);

        // Pool positions 7 and 8, but the caller's first two names still apply:
        // it offered names for what it needs created, not for slots.
        assert_eq!(helper_name(&offered, 0, 7), "Ann");
        assert_eq!(helper_name(&offered, 1, 8), "Bo");
    }

    #[test]
    fn running_out_of_names_falls_back_to_the_pool_position() {
        // Numbered by pool position rather than by creation order, so the label
        // stays unique across calls instead of restarting at 1 each time.
        let offered = names(&["Ann"]);

        assert_eq!(helper_name(&offered, 1, 7), "Participant 8");
        assert_eq!(helper_name(&offered, 2, 8), "Participant 9");
    }

    #[test]
    fn no_names_at_all_is_fine() {
        assert_eq!(helper_name(&[], 0, 0), "Participant 1");
    }

    #[test]
    fn a_blank_name_falls_back_rather_than_rendering_an_empty_row() {
        let offered = names(&["", "   "]);

        assert_eq!(helper_name(&offered, 0, 0), "Participant 1");
        assert_eq!(helper_name(&offered, 1, 1), "Participant 2");
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
                &helper_name(&offered, taken, pool_index),
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
                transport_protocol: singular,
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
        fn the_dto_mirrors_the_first_endpoint_into_the_singular_field() {
            // A DTO whose singular field disagreed with the list would hand a
            // pre-0.0.3 reader a different endpoint than a current one.
            #[allow(deprecated)]
            let contact = derec_proto::ContactMessage {
                channel_id: 1,
                nonce: 7,
                transport_protocol: None,
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
            assert_eq!(dto.transport_protocol.uri, "grpcs://a.example:443");
            assert_eq!(dto.transport_protocol.protocol, "grpc");
        }
    }
}
