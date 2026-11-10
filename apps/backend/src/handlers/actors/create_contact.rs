use std::sync::Arc;

use axum::{
    extract::State,
    http::header,
    response::{IntoResponse, Response},
    Extension,
};
use uuid::Uuid;

use super::dtos::{ContactMessageDto, ContactModeQuery};
use crate::handlers::errors::ApiError;
use crate::handlers::extractors::{ApiPath, ApiQuery, ResponseFormat};
use crate::handlers::response::{ApiResponse, ProtobufResponse};
use crate::middlewares::request_id::RequestId;
use crate::services::actors::ActorService;

/// `POST /api/v1/actors/{actor_id}/contact` — has a provisioned actor mint a
/// contact message.
///
/// A browser actor mints its own (`400`); replica mode is selected by
/// `replica_for_owner_secret`, and refused for the actor's own secret (`400`)
/// and beyond the replica-instance limit (`409`).
///
/// The contact is the JSON envelope by default, or the encoded protobuf
/// `ContactMessage` as `application/octet-stream` when `Accept` ranks that
/// above JSON — what a backend consumer hands straight to its SDK.
#[tracing::instrument(skip(actors, request_id))]
pub async fn create_contact(
    State(actors): State<Arc<dyn ActorService>>,
    Extension(request_id): Extension<RequestId>,
    format: ResponseFormat,
    ApiPath(actor_id): ApiPath<Uuid>,
    ApiQuery(query): ApiQuery<ContactModeQuery>,
) -> Result<Response, ApiError> {
    let contact = actors.create_contact(actor_id, query.into()).await?;
    let body = match format {
        ResponseFormat::Json => {
            ApiResponse::ok(ContactMessageDto::from(&contact), request_id).into_response()
        }
        ResponseFormat::Protobuf => ProtobufResponse(contact).into_response(),
    };
    // The body depends on `Accept`, so a cache must key on it.
    Ok(([(header::VARY, "accept")], body).into_response())
}
