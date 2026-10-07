# Actor Model Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `Role::Replica` as an actor kind, so a replica is a *pairing mode* any helper can serve, and align the HTTP surface with the two-node design that follows.

**Architecture:** Plan 1 gave each actor a map of protocol instances keyed by `secret_id`, plus `EnsureReplicaInstanceMsg` and `CreateContactMsg::replica_for_owner_secret` — the machinery that makes a replica an instance rather than an actor. Nothing routes to it yet. This plan adds that route, migrates the front end onto it, then deletes the separate replica actor kind, the `/replicas` endpoints and the replica state maps. It also drops the `{role}` path segment from transport URIs and renames `/participants` to `/helpers`, both of which the node split in plan 4 requires.

**Tech Stack:** Rust, Axum, Actix actors, `derec-library` 0.0.2; React + TypeScript + Vite, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-01-node-separation-admin-ui-design.md`

## Phase Roadmap

Plan 2 of 5. Each produces working software on its own.

| # | Plan | Status |
|---|---|---|
| 1 | Per-secret protocol instances | complete (11 commits, e2e 39/39) |
| 2 | **Actor model cleanup** (this document) | in progress |
| 3 | Persistence + supervision — `sqlx` (SQLite/Postgres), `Supervisor` | not started |
| 4 | Node separation — two nodes, three modes, owner independence, two-entry FE | not started |
| 5 | Admin UI — auth, panels, config domains, message tap, inspection, wizard slimming | not started |

## Global Constraints

- **The protocol is immutable.** No changes to `derec-library`, `derec-proto`, the protobufs, or `../lib-derec` (read-only reference).
- **Verify SDK facts against the pinned published versions**, not `../lib-derec` (on `feature/grpc_support`, may diverge). Authoritative: `~/.cargo/registry/src/*/derec-library-0.0.2/`.
- **Replica functionality is not being removed.** Only the backend-provisioned *replica actor kind* goes. Owner-device-to-owner-device replica flows stay exactly as they are.
- **Every task must leave working software.** The new capability lands before the old one is deleted, never the reverse.
- Backend tests: `cargo test --manifest-path apps/backend/Cargo.toml` — baseline **74 passing, 5 suites**.
- Frontend unit tests: `cd apps/web && npx vitest run`.
- E2E: `cd apps/web && npx playwright test` — baseline **39 passing**. `pairing.spec.ts:35` is a known pre-existing flake (owner-side mailbox poll stall); re-run once before treating it as a regression.
- No `unwrap()` / `expect()` in production Rust paths. Test code may use them.
- Stage only the files each task touches. `docs/` is untracked and is NOT to be committed by an implementer.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/backend/src/models.rs` | actor DTOs, `Role` | **modify** — drop `Role::Replica`, `path_segment`, `from_path_segment`, `AddReplicaRequest/Response`; rename participant DTOs to helper |
| `apps/backend/src/routes/derec.rs` | transport relay | **modify** — `/derec/{actor_id}`, no role segment |
| `apps/backend/src/routes/participants.rs` | provisioned-helper endpoints | **rename** → `routes/helpers.rs` |
| `apps/backend/src/routes/actors.rs` | contact minting | **modify** — accept `replica_for_owner_secret` |
| `apps/backend/src/routes/replicas.rs` | provisioned replica actors | **delete** (388 lines) |
| `apps/backend/src/state.rs` | registries | **modify** — drop `replica_channels`, `replica_confirmed`, `disabled_replicas` |
| `apps/backend/src/provisioning.rs` | actor minting | **modify** — drop the replica branch of `actor_secret_id`, drop the role segment from transport URIs |
| `apps/backend/src/main.rs` / `lib.rs` | routing table | **modify** — new paths, drop replica routes |
| `apps/web/src/api.ts` | backend client | **modify** — `/helpers`, replica-mode contact, drop `/replicas` calls |
| `apps/web/src/derecApi.ts` | mailbox polling | **modify** — drop the role segment |
| `apps/web/src/replicaFlows.ts` | replica flows | **modify** — provisioned-replica creation becomes replica-mode pairing against a helper |
| `apps/web/src/OwnerPage.tsx` | owner dashboard | **modify** — the "PROVISIONED REPLICAS" rail becomes a replica-mode pairing action |
| `apps/web/e2e/replicas.spec.ts` | replica e2e | **modify** — drive the new flow |

`routes/participants.rs` → `routes/helpers.rs` is a rename rather than an edit-in-place so the module name matches the vocabulary the rest of the system now uses.

---

## Task 1: Drop the role segment from transport paths

**Files:**
- Modify: `apps/backend/src/routes/derec.rs`, `apps/backend/src/provisioning.rs`, `apps/backend/src/main.rs`, `apps/backend/src/models.rs`
- Modify: `apps/web/src/derecApi.ts`, `apps/web/src/api.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: transport URIs of the form `{base_url}/derec/{actor_id}`; routes `POST /derec/{actor_id}` and `GET /derec/{actor_id}/mailbox`. `Role::path_segment` and `Role::from_path_segment` no longer exist.

The `{role}` segment exists only because owners, participants and replicas shared one server-wide namespace. Actor ids are UUIDs, so the segment carries no routing information — it is a redundant check that plan 4's node split makes actively wrong.

- [ ] **Step 1: Change the route table**

In `apps/backend/src/main.rs` (or `lib.rs`, wherever `build_router` lives), replace:

```rust
        .route("/derec/{role}/{actor_id}", post(routes::derec::deliver_message))
        .route(
            "/derec/{role}/{actor_id}/mailbox",
            get(routes::derec::poll_mailbox),
        )
```

with:

```rust
        .route("/derec/{actor_id}", post(routes::derec::deliver_message))
        .route("/derec/{actor_id}/mailbox", get(routes::derec::poll_mailbox))
```

- [ ] **Step 2: Simplify the handlers**

In `apps/backend/src/routes/derec.rs`, `deliver_message` currently extracts `Path((role, actor_id))` and checks the role against the registry. Replace the extractor and drop the role check — the actor id alone identifies the actor:

```rust
pub async fn deliver_message(
    State(state): State<Arc<AppState>>,
    Path(actor_id): Path<Uuid>,
    body: Bytes,
) -> Response {
    if state.actors.get(&actor_id).is_none() {
        return not_found("actor not found");
    }
```

Do the same for `poll_mailbox`: `Path(actor_id): Path<Uuid>`, and delete its `Role::from_path_segment(&role).is_none()` guard and the `unknown_role()` helper, which becomes unused.

Keep every other line of both handlers — the disabled-actor check, the inbox dispatch, the logging, the base64url encoding.

- [ ] **Step 3: Mint URIs without the segment**

In `apps/backend/src/provisioning.rs`, in `provisioned_actor`:

```rust
            uri: format!("{base_url}/derec/{actor_id}"),
```

- [ ] **Step 4: Delete the now-unused Role methods**

In `apps/backend/src/models.rs`, delete `Role::path_segment` and `Role::from_path_segment` and the whole `impl Role` block if nothing else remains in it.

- [ ] **Step 5: Fix the round-trip test**

`apps/backend/src/provisioning.rs` has `a_transport_uri_carries_the_role_segment_and_actor_id`, which asserts the very thing being removed. Replace it:

```rust
    #[test]
    fn a_transport_uri_is_the_base_url_plus_the_actor_id() {
        // The URI is what peers post to, and `deliver_message` parses the id
        // back out of it, so the two must agree on the shape. There is no role
        // segment: an actor id is a UUID and identifies the actor by itself.
        let actor = provisioned_actor(Role::Participant, "test", "http://localhost:5000", None);

        assert_eq!(
            actor.transport.uri,
            format!("http://localhost:5000/derec/{}", actor.id)
        );
    }
```

- [ ] **Step 6: Update the front end**

`apps/web/src/derecApi.ts:37-40` — drop the `role` parameter:

```ts
export async function pollMailbox(actorId: string): Promise<Uint8Array[]> {
  const res = await fetch(`${API_BASE}/derec/${actorId}/mailbox`)
```

Update every caller. Run `grep -rn "pollMailbox" apps/web/src` to find them and drop the now-extra argument at each site.

- [ ] **Step 7: Run the backend suite**

Run: `cargo test --manifest-path apps/backend/Cargo.toml`
Expected: 74 passing (the replaced test keeps the count the same).

- [ ] **Step 8: Run the frontend unit tests and typecheck**

Run: `cd apps/web && npx tsc -b && npx vitest run`
Expected: typecheck clean, unit tests pass.

- [ ] **Step 9: Run e2e**

Run: `cd apps/web && npx playwright test`
Expected: 39 passing. Transport URIs changed shape, so a pairing failure here means a caller was missed.

- [ ] **Step 10: STOP for review**

---

## Task 2: Rename participants to helpers

**Files:**
- Rename: `apps/backend/src/routes/participants.rs` → `apps/backend/src/routes/helpers.rs`
- Modify: `apps/backend/src/routes/mod.rs`, `apps/backend/src/main.rs`/`lib.rs`, `apps/backend/src/models.rs`, `apps/backend/src/state.rs`
- Modify: `apps/web/src/api.ts`

**Interfaces:**
- Consumes: Task 1's route table.
- Produces: `POST /helpers`, `POST /helpers/ensure`, `POST /helpers/{id}/toggle-status`, `GET /helpers/{id}/channels`, `POST /helpers/{id}/link`, `POST|GET /helpers/{id}/browser-contact`. Rust types `AddHelperRequest`, `AddHelperResponse`, `EnsureHelpersRequest`, `EnsureHelpersResponse`. TypeScript `apiEnsureHelpers`, `apiAddHelper`, `apiLinkHelperChannels`.

`Role::Participant` stays as the enum variant for now — renaming the variant touches the actor model that Task 5 is about to change, and doing both at once makes the Task 5 diff unreadable. The *vocabulary* on the wire and in module names moves to "helper" here; the enum follows in Task 5.

- [ ] **Step 1: Rename the module**

```bash
git mv apps/backend/src/routes/participants.rs apps/backend/src/routes/helpers.rs
```

In `apps/backend/src/routes/mod.rs`, change `pub mod participants;` to `pub mod helpers;`.

- [ ] **Step 2: Rename the routes**

In the route table, replace every `/participants` path with `/helpers` and every `routes::participants::` with `routes::helpers::`:

```rust
        .route("/helpers", post(routes::helpers::add))
        .route("/helpers/ensure", post(routes::helpers::ensure))
        .route(
            "/helpers/{helper_id}/toggle-status",
            post(routes::helpers::toggle_status),
        )
        .route("/helpers/{helper_id}/channels", get(routes::helpers::list_channels))
        .route("/helpers/{helper_id}/link", post(routes::helpers::link_channels))
        .route(
            "/helpers/{helper_id}/browser-contact",
            post(routes::helpers::post_browser_contact).get(routes::helpers::get_browser_contact),
        )
```

- [ ] **Step 3: Rename the DTOs**

In `apps/backend/src/models.rs`: `AddParticipantRequest` → `AddHelperRequest`, `AddParticipantResponse` → `AddHelperResponse`, `EnsureParticipantsRequest` → `EnsureHelpersRequest`, `EnsureParticipantsResponse` → `EnsureHelpersResponse`. Rename the `participants` field on the ensure response to `helpers`.

In `apps/backend/src/state.rs`, rename `participant_channels` → `helper_channels` and `disabled_participants` → `disabled_helpers`, and update every reference. `grep -rn "participant_channels\|disabled_participants" apps/backend/src` finds them all.

Rename the `Path` extractor bindings and local variables inside `helpers.rs` to match (`participant_id` → `helper_id`), and update the doc comments so they read as helper vocabulary rather than participant vocabulary.

- [ ] **Step 4: Update the front end client**

In `apps/web/src/api.ts`, rename the three functions and their paths:

- `apiEnsureParticipants` → `apiEnsureHelpers`, path `/helpers/ensure`
- `apiAddParticipant` → `apiAddHelper`, path `/helpers`
- the link call's path → `/helpers/${encodeURIComponent(helperId)}/link`

and the response field `participants` → `helpers` on the ensure response type.

Update every caller: `grep -rn "apiEnsureParticipants\|apiAddParticipant\|apiLinkParticipant" apps/web/src apps/web/e2e`.

Leave user-visible copy alone in this task — the UI still says "participants" to the user and changing that is a separate, cosmetic decision. Only the API surface and identifiers move.

- [ ] **Step 5: Verify no stale references**

Run: `grep -rn "/participants" apps/backend/src apps/web/src apps/web/e2e`
Expected: no output.

Run: `grep -rn "routes::participants" apps/backend/src`
Expected: no output.

- [ ] **Step 6: Run all three suites**

Run: `cargo test --manifest-path apps/backend/Cargo.toml` — 74 passing.
Run: `cd apps/web && npx tsc -b && npx vitest run` — clean.
Run: `cd apps/web && npx playwright test` — 39 passing.

- [ ] **Step 7: STOP for review**

---

## Task 3: A route that mints a replica-mode contact

**Files:**
- Modify: `apps/backend/src/routes/actors.rs`
- Test: `apps/backend/tests/replica_contact.rs` (create)

**Interfaces:**
- Consumes: `CreateContactMsg::replica_for_owner_secret` and `EnsureReplicaInstanceMsg` (both from plan 1).
- Produces: `POST /actors/{actor_id}/contact` accepts an optional query parameter `replica_for_owner_secret` (a `u64` as a decimal string). When present, the helper ensures an instance bound to that secret and mints the contact from it.

This is the task that makes "any helper can be a replica" real. Plan 1 built the actor-side machinery and deliberately left it unreachable; this connects it.

**Why a decimal string, and why the secret rather than the owner's actor id:** a `u64` exceeds JavaScript's exact integer range, which is why `Actor::secret_id` is already serialised as a string. And the owner already knows its own `secret_id` from `POST /owners`, whereas in plan 4 the helper node will not know owner actors at all — resolving an actor id server-side would work today and break then.

- [ ] **Step 1: Extend the query type**

In `apps/backend/src/routes/actors.rs`, the contact handler takes `Query(query): Query<ContactModeQuery>`. Add the field:

```rust
    /// When set, mint the contact from the instance bound to this owner's
    /// secret rather than from the helper's own instance — a replica-mode
    /// pairing. Decimal string: a `u64` exceeds JavaScript's exact integer
    /// range, so it never travels as a JSON number.
    #[serde(default)]
    replica_for_owner_secret: Option<String>,
```

and a parser beside the existing `contact_mode()` helper:

```rust
    /// Parse the mirrored owner's secret id, if one was supplied.
    fn replica_for_owner_secret(&self) -> Result<Option<u64>, Response> {
        match self.replica_for_owner_secret.as_deref() {
            None | Some("") => Ok(None),
            Some(raw) => raw.parse::<u64>().map(Some).map_err(|_| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": "replica_for_owner_secret must be a u64 as a decimal string"
                    })),
                )
                    .into_response()
            }),
        }
    }
```

- [ ] **Step 2: Ensure the instance, then mint from it**

In `create_contact`, after `contact_mode` is resolved and before the `CreateContactMsg` is sent:

```rust
    let replica_for_owner_secret = match query.replica_for_owner_secret() {
        Ok(value) => value,
        Err(response) => return response,
    };

    // The instance must exist before a contact can be minted from it. This is
    // idempotent, so a second replica pairing with the same owner reuses the
    // instance and its shares rather than resetting them.
    if let Some(owner_secret) = replica_for_owner_secret {
        match addr.send(EnsureReplicaInstanceMsg { owner_secret_id: owner_secret }).await {
            Ok(Ok(_created)) => {}
            Ok(Err(e)) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "error": format!("replica instance creation failed: {e}")
                    })),
                )
                    .into_response();
            }
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "error": format!("actor unavailable: {e}") })),
                )
                    .into_response();
            }
        }
    }

    let msg = CreateContactMsg {
        contact_mode,
        nonce: query.nonce,
        replica_for_owner_secret,
    };
```

Import `EnsureReplicaInstanceMsg` alongside the existing `CreateContactMsg` import.

- [ ] **Step 3: Write the integration test**

Create `apps/backend/tests/replica_contact.rs`:

```rust
//! A helper mints a replica-mode contact from an instance bound to the named
//! owner's secret — the route-level half of "any helper can be a replica".

use std::collections::HashMap;

use actix::prelude::*;
use derec_backend::actor::{
    build_protocol, InstanceForChannelMsg, ListInstanceSecretsMsg, ProtocolConfig,
    ProvisionedActor, CreateContactMsg,
};
use derec_backend::models::{Role, UnpairAck};

const OWN_SECRET: u64 = 0xA1;
const ALICE_SECRET: u64 = 0x7F;

fn config(secret_id: u64) -> ProtocolConfig {
    ProtocolConfig {
        secret_id,
        transport_uri: "http://localhost:5000/derec/00000000-0000-0000-0000-000000000001"
            .to_owned(),
        communication_info: HashMap::from([("name".to_owned(), "Alex".to_owned())]),
        timeout_secs: 300,
        unpair_ack: UnpairAck::Required,
        threshold: 2,
        keep_versions_count: 3,
        replica_id: Some(0xAB),
        http_client: reqwest::Client::new(),
    }
}

fn spawn() -> Addr<ProvisionedActor> {
    let cfg = config(OWN_SECRET);
    let protocol = build_protocol(&cfg).expect("protocol builds");
    let state = derec_backend::test_support::app_state();
    ProvisionedActor::new(protocol, cfg, uuid::Uuid::new_v4(), Role::Participant, state).start()
}

#[actix_rt::test]
async fn a_replica_mode_contact_is_minted_from_the_owners_instance() {
    let addr = spawn();

    addr.send(derec_backend::actor::EnsureReplicaInstanceMsg {
        owner_secret_id: ALICE_SECRET,
    })
    .await
    .expect("actor alive")
    .expect("instance creation succeeds");

    let contact = addr
        .send(CreateContactMsg {
            contact_mode: derec_proto::ContactMode::InlineKeys,
            nonce: None,
            replica_for_owner_secret: Some(ALICE_SECRET),
        })
        .await
        .expect("actor alive")
        .expect("contact minted");

    // The decisive assertion: the minted channel routes to the replica
    // instance, not the helper's own. If it resolved to OWN_SECRET the peer's
    // reply would be handed to the wrong vault.
    let owner = addr
        .send(InstanceForChannelMsg { channel_id: contact.channel_id })
        .await
        .expect("actor alive");

    assert_eq!(owner, Some(ALICE_SECRET));
}

#[actix_rt::test]
async fn an_ordinary_contact_still_mints_from_the_own_instance() {
    let addr = spawn();

    let contact = addr
        .send(CreateContactMsg {
            contact_mode: derec_proto::ContactMode::InlineKeys,
            nonce: None,
            replica_for_owner_secret: None,
        })
        .await
        .expect("actor alive")
        .expect("contact minted");

    let owner = addr
        .send(InstanceForChannelMsg { channel_id: contact.channel_id })
        .await
        .expect("actor alive");

    assert_eq!(owner, Some(OWN_SECRET));
    assert_eq!(
        addr.send(ListInstanceSecretsMsg).await.expect("actor alive"),
        vec![OWN_SECRET],
        "an ordinary contact must not create a second instance"
    );
}
```

`InstanceForChannelMsg` and `ListInstanceSecretsMsg` were added in plan 1; read `apps/backend/src/actor.rs` for their exact shapes before writing against them.

- [ ] **Step 4: Run the new test**

Run: `cargo test --manifest-path apps/backend/Cargo.toml --test replica_contact`
Expected: 2 passing.

- [ ] **Step 5: Verify the route end to end with curl**

Start the backend (`cargo run --manifest-path apps/backend/Cargo.toml`), then:

```bash
HELPER=$(curl -s -X POST localhost:5000/helpers -H 'content-type: application/json' \
  -d '{"name":"Alex"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
curl -s "localhost:5000/actors/$HELPER/contact?contact_mode=inline_keys&replica_for_owner_secret=127"
```

Expected: a JSON contact message, HTTP 200. Then confirm a bad value is rejected:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "localhost:5000/actors/$HELPER/contact?contact_mode=inline_keys&replica_for_owner_secret=abc"
```

Expected: `400`.

- [ ] **Step 6: Run the full backend suite**

Run: `cargo test --manifest-path apps/backend/Cargo.toml`
Expected: 76 passing (74 + 2 new).

- [ ] **Step 7: STOP for review**

---

## Task 4: Migrate the front end onto replica-mode pairing

**Files:**
- Modify: `apps/web/src/api.ts`, `apps/web/src/replicaFlows.ts`, `apps/web/src/OwnerPage.tsx`

**Interfaces:**
- Consumes: Task 3's `replica_for_owner_secret` query parameter.
- Produces: `apiCreateReplicaContact(helperId: string, ownerSecretId: string, mode: ContactMode, nonce?: number): Promise<ContactMessageDto>` in `api.ts`. `apiAddReplica` and the `/replicas` client functions still exist after this task and are deleted in Task 5.

Both paths exist at the end of this task. That is deliberate: the front end moves onto the new one and is verified working before anything is deleted.

- [ ] **Step 1: Add the client function**

In `apps/web/src/api.ts`, beside the existing contact function:

```ts
/**
 * Mint a contact from a helper's instance for *this owner's* vault, so pairing
 * against it produces a replica rather than a helper relationship.
 *
 * `ownerSecretId` is the owner's own `secret_id` as returned by `POST /owners`,
 * carried as a decimal string because a `u64` exceeds JavaScript's exact
 * integer range.
 */
export async function apiCreateReplicaContact(
  helperId: string,
  ownerSecretId: string,
  mode: ContactMode,
  nonce?: number,
): Promise<ContactMessageDto> {
  const params = new URLSearchParams({
    contact_mode: mode,
    replica_for_owner_secret: ownerSecretId,
  })
  if (nonce !== undefined) params.set('nonce', String(nonce))

  const res = await request(
    `/actors/${encodeURIComponent(helperId)}/contact?${params.toString()}`,
    { method: 'POST' },
  )
  if (!res.ok) {
    throw new Error(await errorMessage(res, `replica contact failed: ${res.status}`))
  }
  return res.json() as Promise<ContactMessageDto>
}
```

Match `ContactMode` and `ContactMessageDto` to the names already used by the existing contact function in this file — read it first rather than assuming.

- [ ] **Step 2: Read the existing replica pairing entry point and record it**

`apiAddReplica` has exactly one caller: `handleAddReplica` at `apps/web/src/OwnerPage.tsx:6536`, which today reads

```ts
  /** Provision a backend-hosted replica of this owner's vault. */
  async function handleAddReplica(name: string): Promise<void> {
    await apiAddReplica(name, owner.ownerId, provisioningSettings)
    await refreshRosterSnapshot()
  }
```

Pairing against that provisioned replica is a *separate* action further down the same section (the function whose doc comment begins "Start a replica handshake against a provisioned replica" — it drives `pairReplica` and resolves the wire kind through `senderKindFor`).

Before changing anything, read that pairing function and `replicaFlows.ts`'s `pairReplica`, and **write their exact signatures into your report**. The rewiring in Step 3 composes them, and the plan deliberately does not guess at names it has not read.

If the pairing entry point turns out to require a provisioned-replica actor id rather than a contact — that is, if it cannot be pointed at an arbitrary helper's contact — **stop and report NEEDS_CONTEXT** with what you found. That would mean this task needs a different decomposition, and inventing one mid-task is how the last plan shipped a Critical defect.

- [ ] **Step 3: Rewire replica creation onto a helper**

Replace `handleAddReplica` so it mints a replica-mode contact from an available helper and runs the existing pairing against it. Exactly two things come from Step 2's reading — the pairing call and the roster the helper is selected from. Everything else below is fixed:

```ts
  /**
   * Pair a helper from the provisioned pool as a replica of this owner's vault.
   *
   * There is no such thing as a provisioned *replica* any more: a replica is a
   * pairing mode, and the counterparty is an ordinary helper that gains a
   * protocol instance bound to this owner's secret when the contact is minted.
   */
  async function handleAddReplica(name: string): Promise<void> {
    const helper = availableHelperForReplica()
    if (!helper) {
      reportError('Add replica', new Error('No available helper to pair as a replica'))
      return
    }

    const contact = await apiCreateReplicaContact(
      helper.id,
      owner.secretId,
      toContactMode(DEFAULT_CONTACT_MODE),
      humanNonce(),
    )

    await <the pairing call recorded in Step 2>(contact, helper, name)
    await refreshRosterSnapshot()
  }
```

`owner.secretId` already exists on the owner state (`types.ts:14`; `stores.ts` partitions its keys under it). `toContactMode`, `DEFAULT_CONTACT_MODE`, `humanNonce` and `reportError` are already imported in this file.

Define `availableHelperForReplica()` beside `handleAddReplica` — it picks a provisioned helper that is not already paired to this owner, from the same roster snapshot the "PROVISIONED PARTICIPANTS" rail renders:

```ts
  /** A provisioned helper not already paired with this owner, or null. */
  function availableHelperForReplica(): BEActorWithStatus | null {
    return (
      rosterSnapshot.find(actor => actor.role === 'participant' && !actor.channel_id) ?? null
    )
  }
```

Match `rosterSnapshot` and the `role` literal to what this component actually holds — read the "PROVISIONED PARTICIPANTS" rail's data source first. After Task 5 the role literal becomes `'helper'`; leave it as whatever is correct *now* and let Task 5's rename sweep it.

- [ ] **Step 4: Update the rail's copy**

The "PROVISIONED REPLICAS" rail currently reads "None yet. A replica mirrors this vault to another device once both confirm a shared code." That is still true, but the `+ Add` button no longer provisions a replica — it pairs a helper in replica mode. Adjust the copy so it does not promise a separate pool. Keep it short; this is not a redesign.

- [ ] **Step 5: Typecheck and run unit tests**

Run: `cd apps/web && npx tsc -b && npx vitest run`
Expected: clean.

- [ ] **Step 6: Run the replica e2e**

Run: `cd apps/web && npx playwright test e2e/replicas.spec.ts`
Expected: passing. This is the task's real gate — the replica flows must work against a helper counterparty exactly as they did against a replica actor.

If the spec asserts on UI copy that Step 4 changed, update those assertions. **Do not weaken an assertion to make it pass** — if a behavioural assertion now fails, that is this task breaking replica pairing, not the test being wrong. Report it rather than relaxing it.

- [ ] **Step 7: Run the full e2e suite**

Run: `cd apps/web && npx playwright test`
Expected: 39 passing.

- [ ] **Step 8: STOP for review**

Report the signatures you recorded in Step 2, whether `availableHelperForReplica` had to differ from the sketch, and the e2e result.

---

## Task 5: Delete the replica actor kind

**Files:**
- Delete: `apps/backend/src/routes/replicas.rs`
- Modify: `apps/backend/src/models.rs`, `apps/backend/src/state.rs`, `apps/backend/src/provisioning.rs`, `apps/backend/src/actor.rs`, `apps/backend/src/routes/mod.rs`, the route table
- Modify: `apps/web/src/api.ts`

**Interfaces:**
- Consumes: Task 4's migrated front end — nothing calls `/replicas` any more.
- Produces: `Role` has exactly two variants, `Owner` and `Helper`. No `/replicas` routes. `AppState` has no replica maps.

- [ ] **Step 1: Confirm nothing still calls the old surface**

Run: `grep -rn "apiAddReplica\|apiGetReplicaFingerprint\|apiConfirmReplicaFingerprint\|apiToggleReplica" apps/web/src apps/web/e2e`
Expected: matches only inside `api.ts` (the definitions themselves). Any other match means Task 4 is incomplete — stop and report rather than deleting a function still in use.

- [ ] **Step 2: Delete the backend replica surface**

```bash
git rm apps/backend/src/routes/replicas.rs
```

Remove `pub mod replicas;` from `routes/mod.rs` and the four `/replicas...` routes from the route table.

- [ ] **Step 3: Collapse the Role enum**

In `apps/backend/src/models.rs`, rename `Role::Participant` to `Role::Helper` and delete `Role::Replica`:

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Owner,
    Helper,
}
```

Delete `AddReplicaRequest` and `AddReplicaResponse`. On `ActorWithStatus`, delete the `replica_confirmed` field and its doc comment.

`grep -rn "Role::Participant\|Role::Replica" apps/backend/src` finds every site to update.

- [ ] **Step 4: Drop the replica state maps**

In `apps/backend/src/state.rs`, delete the `replica_channels`, `replica_confirmed` and `disabled_replicas` fields and their initialisers in `AppState::new`.

In `apps/backend/src/actor.rs`, `handle_events` reads `replica_channels` in its `PairingCompleted` and `Unpaired` arms and matches on `self.role`. With one provisioned role the match collapses — a provisioned actor records its channels in `helper_channels` regardless of whether the pairing was helper-mode or replica-mode, because the *instance* is what distinguishes them now, not the actor.

In `apps/backend/src/routes/derec.rs`, the delivery guard reads both `disabled_participants` and `disabled_replicas`; it now reads only `disabled_helpers`.

- [ ] **Step 5: Simplify secret-id assignment**

In `apps/backend/src/provisioning.rs`, `actor_secret_id` exists solely to give a replica its owner's secret. With no replica actors, every actor gets its own:

```rust
/// Every actor protects its own secret. A replica relationship no longer
/// changes this: it is an extra protocol *instance* bound to the mirrored
/// owner's secret, added on demand by `EnsureReplicaInstanceMsg`, not a
/// different actor with a different identity.
fn actor_secret_id() -> u64 {
    rand::random::<u64>()
}
```

Update `provisioned_actor`'s signature to drop the `owner_secret_id` parameter, and update its call sites.

Delete the three tests that assert the replica branch — `replica_inherits_the_owner_secret_id`, `replica_without_a_known_owner_falls_back_to_a_fresh_id`, and the replica case inside `non_replicas_get_their_own_secret_id` — and replace the last with:

```rust
    #[test]
    fn every_actor_gets_its_own_freshly_drawn_secret_id() {
        let first = actor_secret_id();
        let second = actor_secret_id();

        assert_ne!(first, 0);
        assert_ne!(first, second, "each actor must get a fresh id");
    }
```

- [ ] **Step 6: Delete the front end replica client**

In `apps/web/src/api.ts`, delete `apiAddReplica`, `apiGetReplicaFingerprint`, `apiConfirmReplicaFingerprint`, `apiToggleReplicaStatus`, `AddReplicaResponse`, and the comment block introducing them.

- [ ] **Step 7: Verify the surface is gone**

Run: `grep -rn "Role::Replica\|/replicas\|replica_channels\|disabled_replicas\|replica_confirmed" apps/backend/src apps/web/src`
Expected: no output.

- [ ] **Step 8: Run all three suites**

Run: `cargo test --manifest-path apps/backend/Cargo.toml` — expect 76 minus the deleted replica tests, plus the replacement; report the number.
Run: `cd apps/web && npx tsc -b && npx vitest run` — clean.
Run: `cd apps/web && npx playwright test` — 39 passing.

- [ ] **Step 9: STOP for review**

---

## Task 6: Update the documentation this plan makes wrong

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `apps/backend/config.example.toml`

**Interfaces:**
- Consumes: the finished state of Tasks 1-5.
- Produces: documentation that matches the code.

- [ ] **Step 1: Correct `CLAUDE.md`**

Its Backend responsibilities section says "Actor registry: one flat, server-wide list of actors (owners, participants, replicas)". Replicas are no longer an actor kind and participants are now helpers. Rewrite that bullet, and the paragraph about provisioned participants being a shared pool, in the current vocabulary.

Do **not** yet describe the two-node split — that is plan 4's change, and documenting it before it exists would be worse than the current staleness.

- [ ] **Step 2: Correct `README.md`**

Update any endpoint paths and the "owners, participants, replicas" vocabulary. `grep -n "participant\|replica" README.md` finds the passages.

- [ ] **Step 3: Correct `config.example.toml`**

`participant_count`, `pre_paired_count`, `min_participants` and `recommended_participants` are config keys the front end reads; **do not rename them** in this task — that is a config-compatibility change belonging with plan 5's config work. Only update prose that calls them replicas or describes a replica pool.

- [ ] **Step 4: Verify**

Run: `grep -rn "replicas" CLAUDE.md README.md`
Expected: only occurrences describing replica *pairing*, none describing a provisioned replica actor kind.

- [ ] **Step 5: STOP for review**

---

## Definition of Done

- [ ] `cargo test` passes in `apps/backend`
- [ ] `npx tsc -b && npx vitest run` clean in `apps/web`
- [ ] `npx playwright test` passes at 39
- [ ] `grep -rn "Role::Replica\|/replicas\|/participants" apps/backend/src apps/web/src` returns nothing
- [ ] Transport URIs are `{base_url}/derec/{actor_id}` with no role segment
- [ ] A helper can be paired in replica mode via `POST /actors/{id}/contact?replica_for_owner_secret=…`
- [ ] `cargo build` emits no new warnings
- [ ] `CLAUDE.md` no longer describes replicas as an actor kind

## Notes for the next plan

Plan 3 (persistence + supervision) inherits a two-variant `Role` and a single provisioned actor kind, which is what makes the spec's uniformity constraint — no table or column may distinguish a provisioned actor from a real one — expressible at all. It also inherits `helper_channels` as the only per-actor channel index.
