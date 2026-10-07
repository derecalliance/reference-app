// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use serde::Serialize;

use crate::models::{Defaults, FrontendConfig};

/// What `GET /api/v1/config` answers: the operator's defaults, plus the facts
/// about this node the front end cannot work out for itself.
///
/// `Defaults` is flattened rather than nested so the result stays the flat
/// object the front end decodes.
#[derive(Debug, Serialize)]
pub struct ConfigResponse {
    #[serde(flatten)]
    pub defaults: Defaults,
    /// True when this node's database is in-memory, so everything is lost when
    /// the process stops. The front end surfaces it so a developer learns this
    /// before losing a vault to it rather than afterwards.
    pub database_ephemeral: bool,
}

impl From<FrontendConfig> for ConfigResponse {
    fn from(config: FrontendConfig) -> Self {
        Self {
            defaults: config.defaults,
            database_ephemeral: config.database_ephemeral,
        }
    }
}
