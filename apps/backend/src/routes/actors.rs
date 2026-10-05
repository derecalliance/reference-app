// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::sync::Arc;

use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use derec_library::protocol::{ChannelStatus, DeRecFlow};
use tracing::info;
use uuid::Uuid;

use crate::{
    actor::{CreateContactMsg, EnsureReplicaError, EnsureReplicaInstanceMsg, StartFlowMsg},
    models::{Actor, ActorWithStatus, ListActorsResponse, Role},
    routes::actor_guard::ensure_actor_exists,
    routes::api_error::{ApiError, ApiJson, ApiPath, ApiQuery},
    routes::helpers::{ContactMessageDto, contact_to_dto},
    sql::{channel::SqlChannelStore, secret::SqlSecretStore},
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
    /// When set, mint the contact from the instance bound to this owner's
    /// secret rather than from the helper's own instance — a replica-mode
    /// pairing. Decimal string: a `u64` exceeds JavaScript's exact integer
    /// range, so it never travels as a JSON number.
    #[serde(default)]
    pub replica_for_owner_secret: Option<String>,
}

impl ContactModeQuery {
    fn contact_mode(&self) -> Result<derec_proto::ContactMode, ApiError> {
        match self.contact_mode.as_deref() {
            None | Some("inline_keys") => Ok(derec_proto::ContactMode::InlineKeys),
            Some("hashed_keys") => Ok(derec_proto::ContactMode::HashedKeys),
            Some("no_keys") => Ok(derec_proto::ContactMode::NoKeys),
            Some(other) => Err(ApiError::bad_request(format!(
                "unknown contact mode `{other}` — expected `inline_keys`, `hashed_keys` or `no_keys`"
            ))),
        }
    }

    /// Parse the mirrored owner's secret id, if one was supplied.
    ///
    /// Absent means "no replica pairing" and is a legitimate `None`. Present
    /// but empty (`?replica_for_owner_secret=`) is not the same thing — a
    /// client that built the query string from an unpopulated value would
    /// otherwise silently mint an ordinary contact instead of a replica one —
    /// so, like `contact_mode()` above, any value present that isn't a valid
    /// non-zero `u64` is rejected rather than treated as absent. Zero is
    /// refused because no SDK mints it: it is the proto3 default, so it can
    /// only mean a field the caller forgot to fill.
    fn replica_for_owner_secret(&self) -> Result<Option<u64>, ApiError> {
        match self.replica_for_owner_secret.as_deref() {
            None => Ok(None),
            Some(raw) => match raw.parse::<u64>() {
                Ok(0) | Err(_) => Err(ApiError::bad_request(
                    "replica_for_owner_secret must be a non-zero u64 as a decimal string",
                )),
                Ok(secret) => Ok(Some(secret)),
            },
        }
    }
}

impl PairRoleQuery {
    fn sender_kind(&self) -> Result<derec_proto::SenderKind, ApiError> {
        match self.role.as_deref() {
            None | Some("helper") => Ok(derec_proto::SenderKind::Helper),
            Some("owner") => Ok(derec_proto::SenderKind::Owner),
            Some(other) => Err(ApiError::bad_request(format!(
                "unknown pairing role `{other}` — expected `owner` or `helper`"
            ))),
        }
    }
}

/// GET /actors
///
/// Every actor registered on this server, enriched with live pairing status, in
/// registration order. This is how a browser context discovers its peers.
pub async fn list(State(state): State<Arc<AppState>>) -> Response {
    let roster = match state.actors.all().await {
        Ok(roster) => roster,
        Err(e) => return crate::routes::actor_guard::registry_unavailable(e),
    };
    let actors = enrich_actors(&state, &roster).await;

    (StatusCode::OK, Json(ListActorsResponse { actors })).into_response()
}

/// Decorate a roster snapshot with the pairing state held outside the registry.
pub(crate) async fn enrich_actors(state: &AppState, actors: &[Actor]) -> Vec<ActorWithStatus> {
    let mut result = Vec::with_capacity(actors.len());

    for a in actors {
        // A registry failure degrades the enrichment rather than failing the
        // roster: the actor list itself is what the front end polls to render,
        // and losing the whole page because a status lookup hiccuped is worse
        // than rendering one row without its channel.
        let (channel_id, shared_key) = primary_channel(state, a).await;

        let disabled = if state
            .disabled_helpers
            .is_disabled(&a.id)
            .await
            .unwrap_or(false)
        {
            Some(true)
        } else {
            None
        };

        let is_browser_managed = state.is_browser_managed(&a.id);
        let browser_managed = is_browser_managed.then_some(true);
        let last_polled_at = is_browser_managed.then(|| {
            state
                .mailbox_polls
                .get(&a.id)
                .map(|at| crate::timestamp::rfc3339_from_unix_ms(*at.value()))
        });

        result.push(ActorWithStatus {
            actor: a.clone(),
            channel_id,
            shared_key,
            disabled,
            browser_managed,
            last_polled_at,
        });
    }

    result
}

/// The one channel the roster reports for `actor`, and its shared key.
///
/// A helper may hold several channels at once — paired with one owner,
/// pending with another — and the roster row shows one. Which one used to be
/// "the last appended to the index", and the index is rebuilt in store order
/// on restart, so the same helper could show its paired channel before a
/// restart and a pending one (with no key) after. The choice is now made from
/// the stored records, the same before and after:
///
/// 1. a `Paired` channel over any other status;
/// 2. among those, the most recently created;
/// 3. ties broken by the higher channel id.
///
/// Only channels in the `helper_channels` index are candidates: the index is
/// written when a pairing *completes*, which is the moment the roster has
/// always started showing a channel.
///
/// Reads the stores directly rather than asking the actor, so polling the
/// roster never competes with protocol traffic for the actor's instances.
async fn primary_channel(state: &AppState, actor: &Actor) -> (Option<String>, Option<String>) {
    let Some(indexed) = state
        .helper_channels
        .get(&actor.id)
        .map(|entry| entry.value().clone())
    else {
        return (None, None);
    };
    if indexed.is_empty() {
        return (None, None);
    }

    let store = SqlChannelStore::new(state.pool.clone(), actor.id.to_string());
    let records = match store.helper_records_all_instances().await {
        Ok(records) => records,
        Err(e) => {
            tracing::warn!(actor_id = %actor.id, error = %e, "channel store unreadable for the roster");
            Vec::new()
        }
    };

    let chosen = records
        .iter()
        .filter(|(_, h)| indexed.iter().any(|id| *id == h.channel_id.0.to_string()))
        .max_by_key(|(_, h)| (h.status == ChannelStatus::Paired, h.created_at, h.channel_id.0));

    let Some((secret_id, record)) = chosen else {
        // Indexed but not (or not readably) stored. Still deterministic: the
        // numerically highest id the index holds.
        let fallback = indexed
            .iter()
            .filter_map(|id| id.parse::<u64>().ok())
            .max()
            .map(|id| id.to_string());
        return (fallback, None);
    };

    let channel_id = record.channel_id.0;
    // Only helpers carry one, and only once the instance holding the channel
    // actually has its key.
    let shared_key = match actor.role {
        Role::Helper => SqlSecretStore::new(state.pool.clone(), actor.id.to_string())
            .load_shared_key(*secret_id, channel_id)
            .await
            .ok()
            .flatten()
            .map(|k| URL_SAFE_NO_PAD.encode(&k[..])),
        Role::Owner => None,
    };

    (Some(channel_id.to_string()), shared_key)
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
            ActorInbox::Browser => None,
        })
}

/// POST /actors/:actor_id/contact
///
/// Unified endpoint for creating a contact message for any provisioned actor.
/// All message exchange between parties must flow through the actor's transport
/// URI (mailbox).
///
/// Role is not checked — the `ActorInbox` match below is what rejects a browser
/// actor, and `replica_for_owner_secret` is what selects replica mode. Replica
/// mode is refused for the actor's own secret, and beyond
/// [`crate::actor::MAX_REPLICA_INSTANCES`] mirrored owners (`409`).
pub async fn create_contact(
    State(state): State<Arc<AppState>>,
    ApiPath(actor_id): ApiPath<Uuid>,
    ApiQuery(query): ApiQuery<ContactModeQuery>,
) -> Response {
    let actor = match ensure_actor_exists(&state, &actor_id).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };

    let Some(addr) = provisioned_addr(&state, &actor_id) else {
        return ApiError::bad_request("browser-managed actors generate their own contacts")
            .into_response();
    };

    let contact_mode = match query.contact_mode() {
        Ok(mode) => mode,
        Err(e) => return e.into_response(),
    };

    let replica_for_owner_secret = match query.replica_for_owner_secret() {
        Ok(value) => value,
        Err(e) => return e.into_response(),
    };

    // The instance must exist before a contact can be minted from it. This is
    // idempotent, so a second replica pairing with the same owner reuses the
    // instance and its shares rather than resetting them.
    if let Some(owner_secret) = replica_for_owner_secret {
        match addr
            .send(EnsureReplicaInstanceMsg {
                owner_secret_id: owner_secret,
            })
            .await
        {
            Ok(Ok(_created)) => {}
            Ok(Err(e @ EnsureReplicaError::LimitReached { .. })) => {
                return ApiError::conflict(e.to_string()).into_response();
            }
            Ok(Err(e @ EnsureReplicaError::OwnSecret)) => {
                return ApiError::bad_request(format!("replica_for_owner_secret: {e}"))
                    .into_response();
            }
            Ok(Err(EnsureReplicaError::Build(e))) => {
                return ApiError::from_protocol("replica instance creation", &e).into_response();
            }
            Err(e) => return ApiError::actor_unavailable(e).into_response(),
        }
    }

    // The PrePair round-trip that HashedKeys and NoKeys need is auto-accepted
    // by these actors, and the fingerprint confirmation NoKeys then requires is
    // driven by the operator through the fingerprint endpoints — so an
    // unattended fixture can serve all three modes.
    let msg = CreateContactMsg {
        contact_mode,
        nonce: query.nonce,
        replica_for_owner_secret,
        attempt: 0,
    };

    match addr.send(msg).await {
        Ok(Ok(contact)) => {
            // The first message on a new contact arrives on an id no store has
            // seen, so gRPC ingress needs a placeholder route for it. Pins
            // expire, and are capped per actor — see `routing::PIN_TTL`.
            if crate::provisioning::advertises_grpc(&actor) {
                state.channel_router.pin(contact.channel_id, actor_id);
            }
            let dto = contact_to_dto(&contact);
            info!(
                actor_id = %actor_id,
                channel_id = %dto.channel_id,
                "actor contact created"
            );
            (StatusCode::OK, Json(dto)).into_response()
        }
        Ok(Err(e)) => ApiError::from_protocol("contact creation", &e).into_response(),
        Err(e) => ApiError::actor_unavailable(e).into_response(),
    }
}

/// POST /actors/:actor_id/start-pairing
///
/// Has a backend-managed actor initiate pairing using the provided contact.
/// The caller supplies the peer's contact; this endpoint triggers the actor
/// to call `protocol.start(Pairing { kind, contact })` and answers
/// `{"channel_id": "…"}` — the transient pairing id, which the handshake
/// rotates to a long-term one when it completes.
///
/// A contact the SDK refuses is `400`, not `500`: it is the caller's input.
pub async fn start_pairing(
    State(state): State<Arc<AppState>>,
    ApiPath(actor_id): ApiPath<Uuid>,
    ApiQuery(role): ApiQuery<PairRoleQuery>,
    ApiJson(req): ApiJson<ContactMessageDto>,
) -> Response {
    let sender_kind = match role.sender_kind() {
        Ok(k) => k,
        Err(e) => return e.into_response(),
    };

    let actor = match ensure_actor_exists(&state, &actor_id).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };

    let Some(addr) = provisioned_addr(&state, &actor_id) else {
        return ApiError::bad_request("browser-managed actors initiate pairing themselves")
            .into_response();
    };

    let contact = match contact_from_dto(&req) {
        Ok(contact) => contact,
        Err(e) => return e.into_response(),
    };
    let channel_id = contact.channel_id;

    let flow = DeRecFlow::Pairing {
        kind: sender_kind,
        contact,
        // The provisioned actor doesn't carry an app-level label for the
        // initiator; the peer's `communication_info` arrives on the wire
        // with the pair-request and is what the responder side stores.
        peer_communication_info: std::collections::HashMap::new(),
    };

    // The response arrives on the id the *peer* minted, so a gRPC-reachable
    // actor must be routable on it before the request goes out — pinning
    // after `start` returns would race a fast reply. Everything that can be
    // refused without the SDK has been by now, and the pin is a claim
    // *alongside* any other actor's on the same id, never instead of it: when
    // the peer is another actor on this node, it keeps its route. Taken back
    // below if the flow does not start.
    let pinned = crate::provisioning::advertises_grpc(&actor);
    if pinned {
        state.channel_router.pin(channel_id, actor_id);
    }
    let unpin = || {
        if pinned {
            state.channel_router.unpin(channel_id, actor_id);
        }
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
                None => {
                    unpin();
                    tracing::error!(actor_id = %actor_id, "pairing emitted no PairingStarted event");
                    ApiError::internal("pairing did not start").into_response()
                }
            }
        }
        Ok(Err(e)) => {
            unpin();
            ApiError::from_protocol("pairing", &e).into_response()
        }
        Err(e) => {
            unpin();
            ApiError::actor_unavailable(e).into_response()
        }
    }
}

/// Turn a caller-supplied contact into the SDK's `ContactMessage`, refusing
/// anything malformed before the SDK sees it.
fn contact_from_dto(req: &ContactMessageDto) -> Result<derec_proto::ContactMessage, ApiError> {
    let channel_id: u64 = req
        .channel_id
        .parse()
        .map_err(|_| ApiError::bad_request("invalid channel_id: expected a decimal u64 string"))?;
    let nonce: u64 = req
        .nonce
        .parse()
        .map_err(|_| ApiError::bad_request("invalid nonce: expected a decimal u64 string"))?;

    // Key material is absent under HashedKeys / NoKeys, so decode only what
    // the initiator actually sent.
    let decode_opt = |field: &Option<String>| -> Result<Option<Vec<u8>>, ApiError> {
        field
            .as_deref()
            .map(|v| {
                URL_SAFE_NO_PAD
                    .decode(v)
                    .map_err(|_| ApiError::bad_request("invalid contact key material"))
            })
            .transpose()
    };
    let mlkem_encapsulation_key = decode_opt(&req.mlkem_encapsulation_key)?;
    let ecies_public_key = decode_opt(&req.ecies_public_key)?;
    let contact_binding_hash = decode_opt(&req.contact_binding_hash)?;

    // The peer advertises every endpoint it serves — in `supported_transports`,
    // or, from a peer predating the list, in the singular field alone.
    let supported_transports = req.endpoints();
    if supported_transports.is_empty() {
        return Err(ApiError::bad_request(
            "the contact advertises no endpoint: set `supported_transports`",
        ));
    }

    let contact = derec_proto::ContactMessage {
        channel_id,
        nonce,
        supported_transports,
        contact_mode: req.contact_mode,
        mlkem_encapsulation_key,
        ecies_public_key,
        contact_binding_hash,
        timestamp: None,
    };
    Ok(contact)
}

// ── Fingerprint confirmation ────────────────────────────────────────────────
//
// The channel is named explicitly rather than inferred from the actor. A
// `NoKeys` pairing — and every replica-mode pairing — can happen on any
// provisioned actor and on any of its channels, and one actor may hold several
// at once, so there is nothing an actor id alone could resolve to.
//
// Which of the actor's protocol instances answers is resolved from the channel
// id, not assumed to be the actor's own: a replica-mode channel lives on the
// instance bound to the mirrored owner's secret, and only that instance holds
// the channel's shared key. See `ProvisionedActor::owning_secret_for`.

#[derive(Debug, Deserialize)]
pub struct ChannelQueryParam {
    pub channel_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ConfirmFingerprintBody {
    pub channel_id: String,
    pub fingerprint: String,
}

/// Resolve a provisioned actor and a channel id it holds.
///
/// A channel the actor holds no record of is `404` here, before any protocol
/// call: the SDK would otherwise answer "channel has no shared key — not yet
/// paired", which reads as an internal fault for what is a wrong id.
async fn provisioned_channel(
    state: &AppState,
    actor_id: &Uuid,
    channel_id: &str,
) -> Result<(actix::Addr<crate::actor::ProvisionedActor>, u64), Response> {
    ensure_actor_exists(state, actor_id).await?;

    let addr = provisioned_addr(state, actor_id).ok_or_else(|| {
        ApiError::bad_request("browser-managed actors derive their own fingerprints")
            .into_response()
    })?;

    let parsed = channel_id.parse::<u64>().map_err(|_| {
        ApiError::bad_request(format!("channel_id `{channel_id}` is not a u64")).into_response()
    })?;

    let store = SqlChannelStore::new(state.pool.clone(), actor_id.to_string());
    match store.holds_channel(parsed, None).await {
        Ok(true) => {}
        Ok(false) => {
            return Err(ApiError::not_found(format!(
                "this actor holds no channel {parsed}; it may not have paired yet"
            ))
            .into_response());
        }
        Err(e) => {
            tracing::error!(actor_id = %actor_id, error = %e, "channel store unreadable");
            return Err(ApiError::internal("channel store unavailable").into_response());
        }
    }

    Ok((addr, parsed))
}

/// GET /actors/:actor_id/fingerprint?channel_id=…
///
/// The actor's own fingerprint for `channel_id`, for out-of-band comparison.
/// Both sides derive the same value from the shared key.
pub async fn get_fingerprint(
    State(state): State<Arc<AppState>>,
    ApiPath(actor_id): ApiPath<Uuid>,
    ApiQuery(query): ApiQuery<ChannelQueryParam>,
) -> Response {
    let (addr, channel_id) = match provisioned_channel(&state, &actor_id, &query.channel_id).await {
        Ok(pair) => pair,
        Err(response) => return response,
    };

    match addr.send(crate::actor::GetFingerprintMsg { channel_id }).await {
        Ok(Ok(fingerprint)) => (
            StatusCode::OK,
            Json(serde_json::json!({ "fingerprint": fingerprint })),
        )
            .into_response(),
        Ok(Err(e)) => fingerprint_error(&e).into_response(),
        Err(e) => ApiError::actor_unavailable(e).into_response(),
    }
}

/// POST /actors/:actor_id/confirm-fingerprint
///
/// Promotes the actor's side of the channel from `Pending` to `Paired`, and
/// answers `{"confirmed": true}`.
///
/// A mismatch answers `400 {"error":"fingerprint mismatch"}` and leaves the
/// channel `Pending` — that is the man-in-the-middle case, where the two sides
/// derived different shared keys, and it must reach the operator rather than be
/// retried.
pub async fn confirm_fingerprint(
    State(state): State<Arc<AppState>>,
    ApiPath(actor_id): ApiPath<Uuid>,
    ApiJson(body): ApiJson<ConfirmFingerprintBody>,
) -> Response {
    let (addr, channel_id) = match provisioned_channel(&state, &actor_id, &body.channel_id).await {
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
        Ok(Ok(false)) => ApiError::bad_request("fingerprint mismatch").into_response(),
        Ok(Err(e)) => fingerprint_error(&e).into_response(),
        Err(e) => ApiError::actor_unavailable(e).into_response(),
    }
}

/// A fingerprint call on a channel the actor does hold, refused by the SDK.
///
/// The one input error left once [`provisioned_channel`] has checked the
/// channel exists is a channel whose key has not arrived yet — a pairing still
/// in its handshake. That is a state the caller can wait out (`409`), not a
/// fault.
fn fingerprint_error(e: &derec_library::Error) -> ApiError {
    match e {
        derec_library::Error::InvalidInput(reason) => {
            ApiError::conflict(format!("channel is not ready for a fingerprint: {reason}"))
        }
        other => ApiError::from_protocol("fingerprint", other),
    }
}
