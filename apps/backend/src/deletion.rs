//! Erasing a provisioned participant.
//!
//! Provisioning spreads a participant across three places: rows in every store
//! table, a running actor, and a handful of in-memory routing handles. Removing
//! it from the registry alone would leave an actor still ticking against stores
//! that still hold its channels — reachable over gRPC by channel id, and back
//! in the pool count on the next restart. So deletion has to unwind all three,
//! and in an order that cannot resurrect what it has already removed.

use std::sync::Arc;

use tracing::{info, warn};
use uuid::Uuid;

use crate::registry::RegistryError;
use crate::state::{ActorInbox, AppState};

/// Every table keyed by `actor_id`, in an order safe to delete in.
///
/// `actors` is deliberately absent — it is removed last and separately, so a
/// failure partway through leaves the participant still registered and
/// therefore still visible, rather than a registry entry whose data is gone.
const ACTOR_SCOPED_TABLES: &[&str] = &[
    "channel_links",
    "channels",
    "secrets",
    "user_secrets",
    "shares",
    "state_items",
    "actor_channels",
    "disabled_helpers",
    "participant_contacts",
    "mailbox",
];

/// Remove a provisioned participant and everything provisioning created for it.
///
/// The caller is responsible for checking the actor exists and is a helper;
/// this is the erasure itself.
///
/// Ordering matters and is not arbitrary:
///
/// 1. **Stop the actor first.** While it runs, its tick writes to the very
///    tables step 3 clears.
/// 2. **Drop the live handles.** Nothing new can be routed to it once the inbox
///    and channel routes are gone.
/// 3. **Delete the data**, then the registry row last, so an error partway
///    leaves the participant listed rather than silently hollow.
///
/// A channel the owner already holds is *not* cleaned up on the owner's side —
/// it cannot be, since that lives in the owner's browser. From there a deleted
/// participant looks exactly like one that went offline and stopped answering,
/// which is a state the protocol already has an answer for: the owner unpairs.
pub async fn delete_participant(state: &Arc<AppState>, actor_id: Uuid) -> Result<(), RegistryError> {
    // 1. Stop the actor before anything else reads or writes on its behalf.
    if let Some((_, inbox)) = state.actor_inboxes.remove(&actor_id) {
        match inbox {
            ActorInbox::Provisioned(addr) => addr.do_send(crate::actor::ShutdownMsg),
            // A browser-managed participant is driven by a page, not by us.
            // Dropping the sender is all there is to stop.
            ActorInbox::Browser(_) => {}
        }
    }
    state.browser_receivers.remove(&actor_id);

    // 2. Drop the routing handles. gRPC ingress resolves by channel id, so a
    //    stale route would hand messages to an actor that no longer exists.
    let channel_ids = state.helper_channels.remove(&actor_id).map(|(_, v)| v).unwrap_or_default();
    for channel_id in &channel_ids {
        if let Ok(id) = channel_id.parse::<u64>() {
            state.channel_router.remove(id);
        }
    }

    // 3. Erase the data, then stop listing the participant.
    let id = actor_id.to_string();
    for table in ACTOR_SCOPED_TABLES {
        // Table names come from the constant above, never from a caller.
        let sql = format!("DELETE FROM {table} WHERE actor_id = $1");
        sqlx::query(&sql)
            .bind(&id)
            .execute(&state.pool)
            .await
            .map_err(RegistryError::new)?;
    }

    state.actors.remove(&actor_id).await?;

    info!(
        actor_id = %actor_id,
        channels = channel_ids.len(),
        "participant deleted"
    );
    if !channel_ids.is_empty() {
        // Worth a line: any owner paired over these keeps a channel that will
        // now go unanswered, and that is the documented behaviour rather than
        // an oversight.
        warn!(
            actor_id = %actor_id,
            channels = channel_ids.len(),
            "deleted participant had live channels; peers will see it as unreachable"
        );
    }
    Ok(())
}
