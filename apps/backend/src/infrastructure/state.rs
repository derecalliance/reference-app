// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The application state, and how handlers draw one service from it.
//!
//! `#[derive(FromRef)]` gives every field its own `State` extractor: a handler
//! declares `State(actors): State<Arc<dyn ActorService>>` and gets that service
//! alone, never the whole state. A handler that asks for something the state
//! does not hold does not compile.

use std::sync::Arc;

use axum::extract::FromRef;

use crate::models::NodeConfig;
use crate::services::actors::ActorService;
use crate::services::configuration::ConfigurationService;
use crate::services::delivery::DeliveryService;
use crate::services::diagnostics::DiagnosticsService;
use crate::services::helpers::HelperService;
use crate::services::owners::OwnerService;

#[derive(Clone, FromRef)]
pub struct AppState {
    pub config: Arc<NodeConfig>,
    pub configuration: Arc<dyn ConfigurationService>,
    pub diagnostics: Arc<dyn DiagnosticsService>,
    pub owners: Arc<dyn OwnerService>,
    pub actors: Arc<dyn ActorService>,
    pub helpers: Arc<dyn HelperService>,
    pub delivery: Arc<dyn DeliveryService>,
}
