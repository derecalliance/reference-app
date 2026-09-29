//! The conformance suite against the stores that already work.
//!
//! This is the proving run. If these pass, the suite is known to describe real
//! behaviour rather than whatever a new implementation happens to do — which is
//! what makes it worth anything when the SQL stores point it at a database.

use derec_backend::conformance;
use derec_backend::stores::{
    InMemoryChannelStore, InMemorySecretStore, InMemoryShareStore, InMemoryStateStore,
    InMemoryUserSecretStore,
};
use derec_library::protocol::StateItem;
use derec_library::types::ChannelId;

/// A distinct `PendingVerification` item per `n`.
///
/// The variant is arbitrary — the suite cares only that the key varies with
/// `n` and that every item shares one `StateKind`, so `load_all` has something
/// to filter. `VerifyShareRequestMessage` is a prost message and derives
/// `Default`.
fn state_item(n: u64) -> StateItem {
    StateItem::PendingVerification {
        channel_id: ChannelId(n),
        request: derec_proto::VerifyShareRequestMessage::default(),
    }
}

#[tokio::test]
async fn the_in_memory_channel_store_conforms() {
    let mut store = InMemoryChannelStore::default();
    conformance::channel_store_conforms(&mut store).await;
}

#[tokio::test]
async fn the_in_memory_share_store_conforms() {
    let mut store = InMemoryShareStore::default();
    conformance::share_store_conforms(&mut store).await;
}

#[tokio::test]
async fn the_in_memory_user_secret_store_conforms() {
    let mut store = InMemoryUserSecretStore::default();
    conformance::user_secret_store_conforms(&mut store).await;
}

#[tokio::test]
async fn the_in_memory_secret_store_conforms() {
    let mut store = InMemorySecretStore::default();
    conformance::secret_store_conforms(&mut store).await;
}

#[tokio::test]
async fn the_in_memory_state_store_conforms() {
    let mut store = InMemoryStateStore::default();
    conformance::state_store_conforms(&mut store, state_item).await;
}
