// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The business models: every data type the services take and return, the
//! ports and repositories exchange with them, and the configuration they read.
//!
//! One file per entity or concept — everything about actors in `actor.rs`,
//! every configuration type in `config.rs` — with the constants that constrain
//! a model beside it. The files are private and every type is re-exported
//! here, so callers write `crate::models::Actor`.
//!
//! Models depend on nothing above them. Wire shapes for the HTTP API live with
//! their routes, layer errors with their layer, and helpers with no business
//! meaning (the clock, serde helpers) in [`crate::utils`].

mod actor;
mod addressing;
mod channel;
mod config;
mod contact;
mod delivery;
mod diagnostics;
mod display_name;
mod envelope;
mod event;
mod helper;
mod owner;
mod protocol_settings;
mod routing;
mod transport;

pub use actor::{
    Actor, ActorListing, ActorSettings, InboxKind, NewActor, PlannedRegistration, Role,
};
pub use addressing::{Listener, OwnTarget};
pub use channel::ChannelSummary;
pub use config::{
    AllowedHost, ConfigOrigin, ConfigSource, DatabaseUrl, Defaults, FrontendConfig, LoadedConfig,
    NodeConfig, RelayAllowlist, ResolvedConfig, ServerSettings, Settings, DEFAULT_DATABASE_URL,
};
pub use contact::{ContactOptions, ContactRequest, PeerContact, UnpairedContact};
pub use delivery::{DispatchOutcome, LocalAttempt, RelayRefusal, RelayRequest, RelayTarget};
pub use diagnostics::{ActorSnapshot, GrpcStatus, NodeSnapshot};
pub use display_name::{DisplayName, NameError, MAX_NAME_CHARS};
pub use envelope::{EnvelopeError, EnvelopeMeta};
pub use event::{Carrier, Direction, Event, EventSnapshot, NewEvent, Outcome, EVENT_LOG_CAPACITY};
pub use helper::{AddHelper, EnsurePool, EnsuredPool, MAX_POOL_SIZE};
pub use owner::{RegisterOwner, RenamedOwner};
pub use protocol_settings::{
    AuthenticationMethod, ProtocolSettings, SettingsError, UnpairAck, MAX_PROTOCOL_TIMEOUT_SECS,
};
pub use routing::{Resolution, Route, Tier, SENDER_METADATA};
pub use transport::{Transport, TransportBreakdown, TransportMode, TransportProtocol};
