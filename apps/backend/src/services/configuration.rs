// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! What this node was configured with, for the front end and for debugging.

use std::sync::Arc;

use crate::models::{FrontendConfig, NodeConfig, ResolvedConfig};

pub trait ConfigurationService: Send + Sync {
    /// Starting values for the front-end setup wizard. Defaults only — the
    /// values a node actually runs with are whatever the front end sends on
    /// its provisioning requests.
    fn frontend(&self) -> FrontendConfig;

    /// The configuration pass this node booted from.
    ///
    /// This reports the loaded settings, not the defaults [`Self::frontend`]
    /// serves. They are the same values in the binary — boot builds one from
    /// the other — and in a test fixture both are the built-in defaults.
    /// Reporting the loaded one keeps this an honest account of the
    /// configuration pass rather than of whatever state was later constructed.
    fn resolved(&self) -> ResolvedConfig;
}

pub struct ConfigurationServiceImpl {
    config: Arc<NodeConfig>,
}

impl ConfigurationServiceImpl {
    pub fn new(config: Arc<NodeConfig>) -> Self {
        Self { config }
    }
}

impl ConfigurationService for ConfigurationServiceImpl {
    fn frontend(&self) -> FrontendConfig {
        FrontendConfig::from(self.config.as_ref())
    }

    fn resolved(&self) -> ResolvedConfig {
        ResolvedConfig::from(&self.config.loaded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Defaults, LoadedConfig};

    fn service(database_url: &str) -> ConfigurationServiceImpl {
        let mut loaded = LoadedConfig::default();
        loaded.settings.server.database_url = database_url.to_owned();
        let defaults = Defaults {
            grpc_port: 6000,
            ..Defaults::default()
        };
        let config = NodeConfig::new("http://localhost:5000", defaults).with_loaded(loaded);
        ConfigurationServiceImpl::new(Arc::new(config))
    }

    #[test]
    fn the_front_end_gets_the_defaults_the_node_was_built_with() {
        let frontend = service("sqlite::memory:").frontend();

        assert_eq!(frontend.defaults.grpc_port, 6000);
    }

    #[test]
    fn an_in_memory_database_is_reported_as_ephemeral() {
        assert!(service("sqlite::memory:").frontend().database_ephemeral);
    }

    #[test]
    fn the_resolved_database_url_never_carries_its_password() {
        let resolved = service("postgres://derec:hunter2@db.example:5432/derec").resolved();

        assert!(
            !resolved.settings.server.database_url.contains("hunter2"),
            "{}",
            resolved.settings.server.database_url
        );
    }
}
