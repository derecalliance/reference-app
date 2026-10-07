// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Browser-run owners: registering a tab, reclaiming an owner, renaming one.

use std::sync::Arc;

use async_trait::async_trait;
use tracing::info;
use uuid::Uuid;

use super::ports::InboxDirectory;
use super::ServiceError;
use crate::models::{
    Actor, ActorSettings, DisplayName, NodeConfig, RegisterOwner, RenamedOwner, Role,
    TransportMode,
};
use crate::repositories::actors::ActorRepository;

#[async_trait]
pub trait OwnerService: Send + Sync {
    /// Register the calling browser context as an owner, or let it claim an
    /// existing one, and give it a mailbox to poll.
    async fn register(&self, request: RegisterOwner) -> Result<Actor, ServiceError>;

    /// Rename a browser-managed owner. An id naming no actor, or a helper, is
    /// not found: there is no owner by that id to rename.
    async fn rename(&self, owner_id: Uuid, name: &str) -> Result<RenamedOwner, ServiceError>;
}

pub struct OwnerServiceImpl {
    config: Arc<NodeConfig>,
    actors: Arc<dyn ActorRepository>,
    inboxes: Arc<dyn InboxDirectory>,
}

impl OwnerServiceImpl {
    pub fn new(
        config: Arc<NodeConfig>,
        actors: Arc<dyn ActorRepository>,
        inboxes: Arc<dyn InboxDirectory>,
    ) -> Self {
        Self {
            config,
            actors,
            inboxes,
        }
    }

    async fn claim(&self, actor_id: Uuid) -> Result<Actor, ServiceError> {
        match self.actors.get(&actor_id).await? {
            Some(actor) if actor.role == Role::Owner => {
                info!(
                    actor_id = %actor.id,
                    name = %actor.name,
                    "owner actor reclaimed in recovery mode"
                );
                Ok(actor)
            }
            _ => Err(ServiceError::NotFound(
                "claim_actor_id is not a registered owner actor".to_owned(),
            )),
        }
    }

    async fn mint(&self, name: &str) -> Result<Actor, ServiceError> {
        let name = DisplayName::try_from(name)?;
        let actor = Actor::mint(
            Role::Owner,
            name.as_str(),
            &self.config.base_url,
            &self.config.grpc_authority(),
            TransportMode::Http,
        );
        // A browser-run actor's protocol settings live in the page; these are
        // stored so the row is well-formed and are never read back.
        let defaults = &self.config.defaults;
        let settings = ActorSettings::fresh(defaults.protocol_timeout_secs, defaults.unpair_ack);
        self.actors.register(actor.clone(), settings).await?;
        info!(actor_id = %actor.id, name = %actor.name, "owner registered");
        Ok(actor)
    }
}

#[async_trait]
impl OwnerService for OwnerServiceImpl {
    async fn register(&self, request: RegisterOwner) -> Result<Actor, ServiceError> {
        let actor = match request.claim_actor_id {
            Some(actor_id) => self.claim(actor_id).await?,
            None => self.mint(&request.name).await?,
        };

        // Idempotent: a claimed actor keeps the mailbox it already has.
        self.inboxes.register_browser(actor.id);
        Ok(actor)
    }

    async fn rename(&self, owner_id: Uuid, name: &str) -> Result<RenamedOwner, ServiceError> {
        let name = String::from(DisplayName::try_from(name)?);

        if !self.actors.rename(&owner_id, Role::Owner, &name).await? {
            return Err(ServiceError::NotFound(
                "no owner actor with this id".to_owned(),
            ));
        }

        info!(actor_id = %owner_id, name = %name, "owner renamed");
        Ok(RenamedOwner { id: owner_id, name })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Defaults;
    use crate::models::InboxKind;
    use crate::services::test_fakes::{FakeActorRepository, FakeInboxes};

    struct Fixture {
        actors: Arc<FakeActorRepository>,
        inboxes: Arc<FakeInboxes>,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                actors: Arc::new(FakeActorRepository::default()),
                inboxes: Arc::new(FakeInboxes::default()),
            }
        }

        fn service(&self) -> OwnerServiceImpl {
            OwnerServiceImpl::new(
                Arc::new(NodeConfig::new(
                    "http://localhost:5000",
                    Defaults::default(),
                )),
                self.actors.clone(),
                self.inboxes.clone(),
            )
        }
    }

    fn register(name: &str) -> RegisterOwner {
        RegisterOwner {
            name: name.to_owned(),
            claim_actor_id: None,
        }
    }

    #[tokio::test]
    async fn a_new_owner_is_registered_trimmed_and_given_a_mailbox() {
        let fixture = Fixture::new();

        let owner = fixture
            .service()
            .register(register("  Alice "))
            .await
            .expect("registers");

        assert_eq!(owner.name, "Alice");
        assert_eq!(owner.role, Role::Owner);
        assert_eq!(fixture.actors.all_actors().len(), 1);
        assert_eq!(fixture.inboxes.kind(&owner.id), Some(InboxKind::Browser));
    }

    #[tokio::test]
    async fn a_blank_name_is_refused_before_anything_is_stored() {
        let fixture = Fixture::new();

        let error = fixture
            .service()
            .register(register("   "))
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::BadRequest("name must not be empty".to_owned())
        );
        assert!(fixture.actors.all_actors().is_empty());
    }

    #[tokio::test]
    async fn a_claim_hands_back_the_existing_owner_and_ignores_the_name() {
        let fixture = Fixture::new();
        let alice = fixture
            .service()
            .register(register("Alice"))
            .await
            .expect("registers");

        let claimed = fixture
            .service()
            .register(RegisterOwner {
                name: String::new(),
                claim_actor_id: Some(alice.id),
            })
            .await
            .expect("claims");

        assert_eq!(claimed.id, alice.id);
        assert_eq!(claimed.name, "Alice");
        assert_eq!(
            fixture.actors.all_actors().len(),
            1,
            "a claim mints nothing"
        );
    }

    #[tokio::test]
    async fn a_claim_naming_a_helper_is_not_found() {
        let fixture = Fixture::new();
        let helper = Actor::mint(Role::Helper, "Alex", "http://h", "h:1", TransportMode::Http);
        fixture.actors.insert(helper.clone());

        let error = fixture
            .service()
            .register(RegisterOwner {
                name: String::new(),
                claim_actor_id: Some(helper.id),
            })
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::NotFound("claim_actor_id is not a registered owner actor".to_owned())
        );
    }

    #[tokio::test]
    async fn renaming_answers_the_trimmed_name() {
        let fixture = Fixture::new();
        let alice = fixture
            .service()
            .register(register("Alice"))
            .await
            .expect("registers");

        let renamed = fixture
            .service()
            .rename(alice.id, " Alicia ")
            .await
            .expect("renames");

        assert_eq!(
            renamed,
            RenamedOwner {
                id: alice.id,
                name: "Alicia".to_owned()
            }
        );
    }

    #[tokio::test]
    async fn renaming_a_helper_is_not_found() {
        let fixture = Fixture::new();
        let helper = Actor::mint(Role::Helper, "Alex", "http://h", "h:1", TransportMode::Http);
        fixture.actors.insert(helper.clone());

        let error = fixture
            .service()
            .rename(helper.id, "Bob")
            .await
            .expect_err("refused");

        assert_eq!(
            error,
            ServiceError::NotFound("no owner actor with this id".to_owned())
        );
    }

    #[tokio::test]
    async fn a_store_failure_is_an_internal_error() {
        let fixture = Fixture::new();
        fixture.actors.fail();

        let error = fixture
            .service()
            .register(register("Alice"))
            .await
            .expect_err("fails");

        assert_eq!(
            error,
            ServiceError::Internal("actor registry unavailable".to_owned())
        );
    }
}
