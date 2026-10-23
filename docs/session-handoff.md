# Session handoff — 2026-10-07

Local, untracked. Read this, then continue from "Next steps". Do not commit it.

## Update — 2026-10-08 (resumed session): steps 1–4 DONE

- **SQLite bug fixed** (`infrastructure/db.rs`): the idle/lifetime fix was already in HEAD; the real cause was sqlx's `test_before_acquire` ping — a future dropped during that await (actor stopped by `ShutdownMsg`, or a client hang-up) drops the checked-out connection, i.e. the whole in-memory DB. Ephemeral pools now set `test_before_acquire(false)`. Regression test `an_ephemeral_pool_survives_an_acquire_cancelled_mid_flight` (failed before, passes after).
- **CHANGELOG + Help 14** updated for the published image / `--build` / `compose.build.yaml` / `DEREC_IMAGE` / `publish-image.sh`.
- **Rust floor 1.88 → 1.89** (Dockerfile, Cargo.toml, README, CONTRIBUTING, Help 14): the image build failed on 1.88 (`aes` 0.9.3, `enum-ordinalize` 4.4.2 via the SDK, `uuid` 1.27). SDK item 5 added to `docs/sdk-0.0.8-handoff.md`.
- **Verified:** backend 537 passed, clippy + fmt clean; web tsc/eslint clean, 1209 unit, vite build; e2e 80 passed / 4 skipped / 0 failed; multi-vault + qr-scan ×10 = 80/80.
- **Docker e2e:** `publish-image.sh --local` pushed amd64+arm64 to `localhost:5055` (`derec-registry` container). `~/derec-demo/docker-compose.yml` (project `derec-demo`, postgres) is up on :5000/:50051; smoke tests passed.
- Remaining: step 5 (user commits). Stop the demo with `cd ~/derec-demo && docker compose down` (`-v` erases it); stop the registry with `docker rm -f derec-registry`.

## Update — 2026-10-08 (later): release tooling for GHCR

- Version is now **0.0.8-alpha.1**, declared in `apps/backend/Cargo.toml`; `scripts/version.sh` (show / check / set) keeps every copy in step; AGENTS.md rule updated.
- `scripts/publish-image.sh` rewritten: preflight (clean tree, tag `v<version>` on HEAD and on origin, GHCR login, builder platforms, version not yet published) → plan → confirm → build with labels, index annotations, SBOM and provenance → verify. Pre-releases never move `latest`. Rehearsed with `--local`: OK.
- `docs/DOCKER.md` is the image reference (every setting + default, env files, compose); README/CONTRIBUTING/Help 14 point to it. `.dockerignore` now excludes `*.db` files.
- `~/derec-demo` runs `localhost:5055/...:0.0.8-alpha.1`.
- User publishes: commit → `git tag -a v0.0.8-alpha.1` → push tag → `docker login ghcr.io` → `scripts/publish-image.sh`.

## Ground rules (also in auto-memory)

- **Never commit, stage, stash or reset.** The user commits (`git commit -s`, DCO). Part of the working tree is **already staged by the user** — leave the index alone.
- **The boundary is the SDK.** Fix app (web/backend) bugs without asking; never modify `../lib-derec`. SDK findings go into `docs/sdk-0.0.8-handoff.md` (untracked).
- **Nothing leaves this machine** except the user's own pushes: no Artifacts/uploads; screenshots stay in scratch and get deleted.
- Stop processes **only by PID** or `lsof -ti` on your own ports — never `pkill`/`killall` by name.
- Backend architecture rules are in CLAUDE.md (handlers → one service; services/repositories behind traits; models one file per entity; `/api/v1` + envelope). Every user-visible change updates `CHANGELOG.md` (AGENTS.md "Changing this repository").

## Where things stand

Branch `main`, synced with `origin/main` at `aa9ffad` (PR #8 merged). Everything below is **uncommitted** in the working tree.

1. **Released SDK 0.0.8 switch — done and verified.** Registry `derec-library`/`derec-proto` 0.0.8 and `@derec-alliance/web` 0.0.8 (release tag identical to the tree QA'd); app version bumped to 0.0.8 everywhere AGENTS.md lists. Verified: backend 514, web 1195 unit, full e2e 78 passed / 4 skipped, npm audit 0. A QA pass found no regressions incl. 0.0.7→0.0.8 upgrade with existing data and mixed 0.0.7/0.0.8 nodes.
2. **Three app bugs from that QA — done and verified** (restore of a vault with a replica on a new device; Replicas tab empty after restore; refused-fingerprint helper counted as a round recipient). CHANGELOG + Help 04/06 updated.
3. **Backend fixes — done (agent-verified, not yet re-verified by me after later edits):**
   - gRPC-mode replicas: channel claims now carry a `side` (`endpoint` / `mirror`); delivery ranks bound endpoint > bound mirror > pin, ties refused. `/api/v1/debug/state` routes show `side`. Docs: ARCHITECTURE.md, AGENTS.md, openapi.yaml updated.
   - Flaky `helper_auto_confirm::the_tick_backstop…` made deterministic (drives the tick).
   - `cargo fmt` on the whole crate (formatting-only diff across ~50 files).
   - Agent result: 536 tests, clippy clean, `cargo fmt --check` clean.
4. **Web fixes — done (agent-verified: tsc/eslint clean, 1209 unit tests, full e2e 80 passed / 4 skipped / 0 failed; not yet re-verified by me):**
   - Add Secret lists exactly the publish targets (`publishTargets` in `ownerPairing.ts`, shared with OwnerPage's count).
   - Server defaults retry with backoff until the first real answer (`vault/serverDefaultsLoader.ts`; `fromServer` on `ServerDefaultsResult`); replay window and `unpair_ack` stay until a vault restarts, with a Console note.
   - **qr-scan flake: real app race fixed** (StrictMode double-mount; `startQrScan` returns its session immediately so the discarded one can be stopped) + a deterministic e2e test.
   - **multi-vault flake: NOT reproduced** in ~48 runs; phases wrapped in `test.step` so the next failure names the phase. Still open.
   - New `e2e/bfcache.spec.ts` (real Chrome bfcache restore, on the setup screen — Chrome won't cache a page with a running vault).
   - **SDK-handoff item 3 was an APP bug, fixed:** `keepList` now also lists rounds the library still holds open (`openSharingRoundVersions` in `stores.ts`); `docs/sdk-0.0.8-handoff.md` item 3 rewritten (incl. an SDK API gap: `verify_fingerprint` returns only a bool, so the round it starts is invisible).
   - Help 04/11/13/16 and CHANGELOG updated.
   - **New backend bug it saw once under load (unfixed):** right after the participants e2e spec deleted a helper (`DELETE /api/v1/helpers/{id}`), every request failed with `no such table: actors` — the single connection to the in-memory SQLite DB was dropped and reopened empty, failing all 47 later tests. Investigate in `infrastructure/db.rs` (in-memory pool settings: max/min connections, idle timeout, `test_before_acquire`) and the deletion path (`repositories/participant_data.rs`).
5. **Docker publishing (manual) + compose-from-image — written, not yet exercised end to end:**
   - `examples/compose.sqlite.yaml` / `compose.postgres.yaml` use `image: ${DEREC_IMAGE:-ghcr.io/derecalliance/reference-app}:0.0.8` — no `build:`.
   - New root `compose.postgres.yaml` (includes the example); root `compose.yaml` includes the SQLite one.
   - New `compose.build.yaml` override: builds from the checkout, tagged `derec/reference-app:dev` (use only with the root compose files).
   - `start.sh`: pulls by default; `--build` builds; falls back to building when the pull fails (until the image is published).
   - New `scripts/publish-image.sh`: multi-arch (`linux/amd64,linux/arm64`) buildx build with OCI labels, pushes `<version>` + `latest` to `ghcr.io/derecalliance/reference-app`; `--local` starts a `registry:2` container `derec-registry` on **localhost:5055** (5555 is taken by an emulator) and pushes there; `--dry-run`, `--no-latest`, `--image`, `--platforms`.
   - Docs updated: README (no-clone `docker run`, start.sh `--build`, compose section), CONTRIBUTING ("Publishing the image" with local rehearsal), examples/README.md.
   - **Still to do:** CHANGELOG entry for the published image / compose-from-image / `--build` / publish script; Help topic `14-running-the-app.md` (image pull, `--build`, `compose.build.yaml`, local registry).

Nothing DeRec is running now (demo container stopped; ports 5000/50051 free).

## Next steps (in order)

1. **Fix the in-memory SQLite connection-drop bug** (point 4, last bullet) with a test, and keep an eye on the multi-vault flake (point 4).
2. **Add the CHANGELOG entry and Help topic 14** for point 5.
3. **Full verification:** backend `cargo test --all-targets --no-fail-fast`, `cargo clippy --all-targets`, `cargo fmt --check`; web `npx tsc -b`, `npx eslint .`, `npx vitest run`, `npx vite build`; full e2e `cd apps/web && npx playwright test` (own ports 5100/5180/50151; expect 78+ passed, 4 skipped, 0 failed). Run the two previously-flaky e2e tests repeatedly.
4. **The user's real Docker e2e test (they asked for this):**
   1. `scripts/publish-image.sh --local` (amd64 is emulated on this Apple Silicon Mac — slow; run in background). Check `docker buildx imagetools inspect localhost:5055/derecalliance/reference-app:0.0.8` lists both platforms.
   2. Write a **standalone, user-style** compose file outside the repo, e.g. `~/derec-demo/docker-compose.yml`: `image: localhost:5055/derecalliance/reference-app:0.0.8` (no build), `postgres:17-alpine` with a healthcheck the node `depends_on` (`condition: service_healthy`), `DEREC_DATABASE_URL=postgres://derec:<pw>@postgres:5432/derec`, named volumes, ports 5000:5000 and 50051:50051, `DEREC_PUBLIC_PORT`/`DEREC_PUBLIC_GRPC_PORT`, a commented `DEREC_BASE_URL=http://<LAN IP>` for phones.
   3. `docker compose up -d` there (plain compose, no start.sh); smoke-test: `/health`, UI at `/`, `/api/v1/config` envelope, `/api/v1/debug/config` shows the redacted postgres URL, `POST /api/v1/helpers/ensure` provisions. Then hand it to the user to read the file and play.
5. Report everything to the user, including the commit guidance: include all new untracked files (`compose.build.yaml`, `compose.postgres.yaml`, `scripts/`, new tests/sources), exclude `docs/sdk-0.0.8-handoff.md` and this file.

## Open threads for later (user parked them)

- **Tunnel for a public demo (Tailscale recommended, or ngrok):** needs a compose override so `DEREC_BASE_URL` can be `https://…` (today compose sets `http://${LAN_IP}` with top precedence) and a `start.sh --public-url https://…` flag setting public port 443. ngrok free plans break the UI (browser-warning interstitial); gRPC can't share the HTTP tunnel host.
- **Major dependency upgrades** (separate small branches): web — MUI 7→9, TypeScript 5.9→7, ESLint 9→10, Vitest 4→5, jsdom 26→29, @types/node 24→26; backend — sqlx 0.8→0.9 and reqwest 0.12→0.13 (TLS feature rename), tower-http 0.6→0.7, base64 0.22→0.23, rand 0.8→0.10, toml 0.8→1.x.
- **CI** (none yet beyond the Pages deploy and DCO).
- **SDK handoff** `docs/sdk-0.0.8-handoff.md`: items 1 (wrong replica_id → generic Invariant), 2 (recovery not targetable), 3 (pending web-agent investigation), 4 (restore takeover rule).

## Housekeeping the user can do

Scratch folders the agents could not delete (permission denied): `/private/tmp/claude-501/-Users-facutherock-repositories-derec-reference-app/f98f1cab-4f0a-4c6a-9de6-8d6a62edd344/scratchpad/` (includes `qa8/` Chrome profiles + a failed release build, `fix8/`, `be-fixes/`, `diag/`, `refs/`, `layering-b/`, `models/` logs). Safe to `rm -rf`. The local Docker volumes `derec-data` (old manual container) and `derec_derec-data` / `derec_derec-pgdata` (start.sh) may hold stale test data.
