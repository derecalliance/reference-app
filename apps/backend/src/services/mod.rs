// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The node's rules: what each request is allowed to do and what it does.
//!
//! One service per entity, each a trait and its implementation. The HTTP
//! handlers hold them as `Arc<dyn …>` and each takes only the one it uses; the
//! services reach storage through [`crate::repositories`] and everything else
//! — the actor runtime, the gRPC router, the event log — through the ports in
//! [`ports`] and beside each service. Nothing here knows about HTTP.

pub mod actors;
pub mod configuration;
pub mod delivery;
pub mod diagnostics;
pub mod helpers;
pub mod owners;
pub mod ports;
#[cfg(test)]
mod test_fakes;

use crate::models::{NameError, SettingsError};
use crate::repositories::RepositoryError;
use ports::ActorCallError;

/// Why a request was refused. Every message is safe to show a caller: detail
/// that is not — a connection error, a row that would not decode — is logged
/// where the error is raised instead.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ServiceError {
    /// The request itself is wrong: a malformed value, a wrong kind of actor.
    #[error("{0}")]
    BadRequest(String),
    /// Refused by node policy: the relay will not dial that target.
    #[error("{0}")]
    Forbidden(String),
    /// Nothing is known about what was asked for.
    #[error("{0}")]
    NotFound(String),
    /// The request conflicts with the state it would act on.
    #[error("{0}")]
    Conflict(String),
    /// The request carries more than the node accepts.
    #[error("{0}")]
    PayloadTooLarge(String),
    /// Ours to fix: a store failed, or an invariant did not hold.
    #[error("{0}")]
    Internal(String),
    /// A peer this request had to reach could not be reached.
    #[error("{0}")]
    BadGateway(String),
    /// Transient or switched off here; worth retrying later or elsewhere.
    #[error("{0}")]
    Unavailable(String),
    /// The two sides of a channel derived different fingerprints: the
    /// man-in-the-middle case, which must reach the operator rather than be
    /// retried. A caller tells it apart from any other refusal by kind.
    #[error("fingerprint mismatch")]
    FingerprintMismatch,
    /// The relay is switched off on this node. Unlike other unavailability,
    /// no retry will turn it on.
    #[error("{0}")]
    RelayDisabled(String),
    /// The recipient's mailbox is at its limit: it has not polled for a while.
    #[error("{0}")]
    MailboxFull(String),
    /// A display name another participant already holds.
    #[error("{0}")]
    NameTaken(String),
}

impl ServiceError {
    /// An internal failure answered as `message`, with `source` logged rather
    /// than returned: a caller can do nothing with it, and it may name a host.
    pub fn internal(message: &str, source: impl std::fmt::Display) -> Self {
        tracing::error!(error = %source, "{message}");
        Self::Internal(message.to_owned())
    }

    /// Map a refused call into a provisioned actor, naming the operation in
    /// `context` (`"pairing"`, `"fingerprint"`) so the message says what
    /// failed.
    ///
    /// The split is by who can fix it: a contact or input the SDK refused is
    /// the caller's (400); a channel already paired is a state conflict (409);
    /// an actor busy with another call, or not running, is transient (503); a
    /// delivery the transport could not make is the peer's (502); anything
    /// else is ours (500).
    pub fn from_actor_call(context: &str, e: ActorCallError) -> Self {
        use derec_library::Error as E;

        match e {
            ActorCallError::NotRunning(reason) => {
                tracing::error!(error = %reason, "actor mailbox unavailable");
                Self::Unavailable("actor is not running; try again shortly".to_owned())
            }
            ActorCallError::Busy => {
                Self::Unavailable("actor is busy with another call; try again shortly".to_owned())
            }
            ActorCallError::PeerUnreachable => {
                Self::BadGateway(format!("{context} failed: the peer could not be reached"))
            }
            e @ ActorCallError::ReplicaLimitReached { .. } => Self::Conflict(e.to_string()),
            e @ ActorCallError::OwnSecret => {
                Self::BadRequest(format!("replica_for_owner_secret: {e}"))
            }
            ActorCallError::NotProvisioned => {
                Self::NotFound("helper has no backend protocol instance".to_owned())
            }
            ActorCallError::Protocol(
                e @ (E::Pairing(_)
                | E::InvalidInput(_)
                | E::Transport(_)
                | E::NoUsableEndpoint { .. }
                | E::ProtobufDecode(_)
                | E::RoleMismatch { .. }),
            ) => Self::BadRequest(format!("{context} rejected: {e}")),
            ActorCallError::Protocol(e @ E::ChannelAlreadyPaired { .. }) => {
                Self::Conflict(format!("{context} rejected: {e}"))
            }
            ActorCallError::Protocol(other) => {
                tracing::error!(context, error = %other, "protocol call failed");
                Self::Internal(format!("{context} failed"))
            }
        }
    }
}

/// A store failure is the node's, never the caller's: logged, and answered
/// without its detail.
impl From<RepositoryError> for ServiceError {
    fn from(e: RepositoryError) -> Self {
        match e {
            RepositoryError::MailboxFull { .. } => Self::MailboxFull(
                "the recipient's mailbox is full; it has not polled for a while".to_owned(),
            ),
            other => Self::internal("actor registry unavailable", other),
        }
    }
}

impl From<NameError> for ServiceError {
    fn from(e: NameError) -> Self {
        Self::BadRequest(e.to_string())
    }
}

impl From<SettingsError> for ServiceError {
    fn from(e: SettingsError) -> Self {
        Self::BadRequest(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_store_failure_is_answered_without_its_detail() {
        let error = ServiceError::from(RepositoryError::Corrupt("row 7 is garbage".to_owned()));

        assert_eq!(
            error,
            ServiceError::Internal("actor registry unavailable".to_owned())
        );
    }

    #[test]
    fn a_full_mailbox_is_transient() {
        let error = ServiceError::from(RepositoryError::MailboxFull {
            queued: 1000,
            bytes: 0,
        });

        assert!(matches!(error, ServiceError::MailboxFull(_)));
    }

    #[test]
    fn a_busy_actor_is_transient_rather_than_a_fault() {
        assert_eq!(
            ServiceError::from_actor_call("pairing", ActorCallError::Busy),
            ServiceError::Unavailable(
                "actor is busy with another call; try again shortly".to_owned()
            )
        );
    }

    #[test]
    fn an_unreachable_peer_is_a_bad_gateway_naming_the_operation() {
        assert_eq!(
            ServiceError::from_actor_call("pairing", ActorCallError::PeerUnreachable),
            ServiceError::BadGateway("pairing failed: the peer could not be reached".to_owned())
        );
    }

    #[test]
    fn input_the_protocol_refuses_is_the_callers() {
        let error = ServiceError::from_actor_call(
            "pairing",
            ActorCallError::Protocol(derec_library::Error::InvalidInput("bad contact")),
        );

        assert!(
            matches!(error, ServiceError::BadRequest(m) if m.starts_with("pairing rejected: "))
        );
    }

    #[test]
    fn any_other_protocol_failure_is_ours_and_says_only_what_failed() {
        let error = ServiceError::from_actor_call(
            "contact creation",
            ActorCallError::Protocol(derec_library::Error::Invariant("internal detail")),
        );

        assert_eq!(
            error,
            ServiceError::Internal("contact creation failed".to_owned())
        );
    }

    #[test]
    fn the_replica_limit_is_a_conflict_and_its_own_secret_a_bad_request() {
        assert!(matches!(
            ServiceError::from_actor_call("x", ActorCallError::ReplicaLimitReached { max: 16 }),
            ServiceError::Conflict(_)
        ));
        assert_eq!(
            ServiceError::from_actor_call("x", ActorCallError::OwnSecret),
            ServiceError::BadRequest(
                "replica_for_owner_secret: the secret named is this actor's own, not another owner's"
                    .to_owned()
            )
        );
    }
}
