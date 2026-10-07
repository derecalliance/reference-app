// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Protocol settings an actor is provisioned with, and the app-level
//! authentication policy carried beside them.

use serde::{Deserialize, Serialize};

/// How the app decides that two pairing channels belong to the same user.
///
/// This is an **app-level** concern (the DeRec protocol is identity-blind). The
/// backend never acts on it — it only carries it as an operator-supplied
/// default for the front end.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthenticationMethod {
    /// Helper manually links channels (the in-modal "accept + link" flow).
    #[default]
    User,
    /// Reserved for a future automatic-linking mode; not yet implemented.
    Application,
}

/// Protocol-level acknowledgement policy for the unpair flow. Mirrors
/// `derec_library::protocol::UnpairAck`; supplied per provisioning request by
/// the node that provisions the actor.
///
/// - `Required` (default): the initiator keeps local state until the peer
///   ACKs or the timeout elapses.
/// - `NotRequired`: fire-and-forget — state drops immediately on
///   `start(Unpair)`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UnpairAck {
    #[default]
    Required,
    NotRequired,
}

impl UnpairAck {
    /// Convert to the lib's enum for protocol builder consumption.
    pub fn to_library(self) -> derec_library::protocol::UnpairAck {
        match self {
            UnpairAck::Required => derec_library::protocol::UnpairAck::Required,
            UnpairAck::NotRequired => derec_library::protocol::UnpairAck::NotRequired,
        }
    }
}

/// The longest a requested protocol timeout may be, in seconds: one day.
///
/// The value is the replay window — how stale an inbound envelope may be and
/// still be accepted — so anything beyond a day is a typo, not a setting.
pub const MAX_PROTOCOL_TIMEOUT_SECS: u32 = 86_400;

/// Protocol settings a provisioning request carries for the actor it mints.
///
/// The front end owns configuration, so these travel with each request rather
/// than being read from server state. Both are optional: a caller that omits
/// them gets the operator-supplied defaults.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProtocolSettings {
    pub protocol_timeout_secs: Option<u32>,
    pub unpair_ack: Option<UnpairAck>,
}

/// Why requested protocol settings were refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SettingsError {
    #[error("protocol_timeout_secs must be between 1 and {MAX_PROTOCOL_TIMEOUT_SECS}")]
    TimeoutOutOfRange,
}

impl ProtocolSettings {
    /// Reject settings no actor can usefully run with.
    ///
    /// Zero is the case that matters: as a replay window it refuses every
    /// inbound message, so the actor pairs with nothing and says nothing about
    /// why. Only the request's own values are checked — the operator defaults
    /// they fall back to are validated when the configuration is loaded.
    pub fn validate(&self) -> Result<(), SettingsError> {
        match self.protocol_timeout_secs {
            Some(secs) if secs == 0 || secs > MAX_PROTOCOL_TIMEOUT_SECS => {
                Err(SettingsError::TimeoutOutOfRange)
            }
            _ => Ok(()),
        }
    }

    /// Fill the unset fields from the operator-supplied defaults.
    pub fn resolve(
        self,
        default_timeout_secs: u32,
        default_unpair_ack: UnpairAck,
    ) -> (u32, UnpairAck) {
        (
            self.protocol_timeout_secs.unwrap_or(default_timeout_secs),
            self.unpair_ack.unwrap_or(default_unpair_ack),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zero_timeout_is_refused_because_it_would_refuse_every_message() {
        let settings = ProtocolSettings {
            protocol_timeout_secs: Some(0),
            unpair_ack: None,
        };

        assert_eq!(settings.validate(), Err(SettingsError::TimeoutOutOfRange));
    }

    #[test]
    fn a_timeout_beyond_a_day_is_refused() {
        let settings = ProtocolSettings {
            protocol_timeout_secs: Some(MAX_PROTOCOL_TIMEOUT_SECS + 1),
            unpair_ack: None,
        };

        assert!(settings.validate().is_err());
    }

    #[test]
    fn omitted_settings_resolve_to_the_defaults() {
        let resolved = ProtocolSettings::default().resolve(300, UnpairAck::NotRequired);

        assert_eq!(resolved, (300, UnpairAck::NotRequired));
    }

    #[test]
    fn given_settings_win_over_the_defaults() {
        let settings = ProtocolSettings {
            protocol_timeout_secs: Some(60),
            unpair_ack: Some(UnpairAck::Required),
        };

        assert_eq!(
            settings.resolve(300, UnpairAck::NotRequired),
            (60, UnpairAck::Required)
        );
    }

    #[test]
    fn the_refusal_names_the_field_and_the_range() {
        assert_eq!(
            SettingsError::TimeoutOutOfRange.to_string(),
            "protocol_timeout_secs must be between 1 and 86400"
        );
    }
}
