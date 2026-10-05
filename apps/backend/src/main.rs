// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::future::IntoFuture;
use std::io::IsTerminal;
use std::sync::Arc;
use std::time::Duration;

use tracing::{info, warn};
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

use derec_backend::build_router;
use derec_backend::config;
use derec_backend::db;
use derec_backend::state::AppState;

/// How long an outbound connection to a peer may take to establish.
///
/// Peers are other nodes and browsers' backends on the same machine or LAN,
/// where a connection either completes in milliseconds or is never going to:
/// five seconds absorbs a slow Wi-Fi or VPN hop without letting one powered-off
/// laptop stall the helper that is trying to reach it.
const OUTBOUND_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long one outbound DeRec delivery may take end to end.
///
/// A delivery is a single small protobuf envelope that the receiver queues and
/// acknowledges; it is never a long poll. Without a bound, a peer that accepts
/// the connection and then goes silent held the sending actor for the OS TCP
/// timeout — about 75 seconds — during which that helper answered nobody.
const OUTBOUND_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// How long in-flight requests get to finish after a shutdown signal.
///
/// Under Docker's 10-second stop timeout, with room to spare for the database
/// pool to close: past it, `docker stop` sends SIGKILL and the drain is lost
/// anyway. Every route here answers in milliseconds, so a request still open
/// after this long is stalled rather than slow.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// How long `derec-backend healthcheck` waits for `/health`. Under the
/// image's `HEALTHCHECK --timeout=3s`, so a hung server is reported as a
/// failed probe rather than as a probe Docker had to kill.
const HEALTHCHECK_TIMEOUT: Duration = Duration::from_secs(2);

/// Why the node could not start. Each message is meant to be enough to fix
/// the problem without reading code.
#[derive(Debug, thiserror::Error)]
enum StartupError {
    #[error("{0}")]
    LegacyEnv(String),
    #[error("configuration error: {0}")]
    Config(#[from] config::ConfigError),
    #[error("database error: {error}{}", hint_suffix(.hint))]
    Database {
        error: db::DbError,
        hint: Option<String>,
    },
    #[error("could not listen for {what} on 0.0.0.0:{port}: {source}. {hint}")]
    Bind {
        what: &'static str,
        port: u16,
        #[source]
        source: std::io::Error,
        hint: String,
    },
    #[error("could not build the outbound HTTP client: {0}")]
    HttpClient(#[source] reqwest::Error),
    #[error("the actor runtime thread failed to start")]
    ActorRuntime,
    #[error("the HTTP server stopped unexpectedly: {0}")]
    Serve(#[source] std::io::Error),
}

fn hint_suffix(hint: &Option<String>) -> String {
    hint.as_ref()
        .map(|hint| format!("\n  hint: {hint}"))
        .unwrap_or_default()
}

#[tokio::main]
async fn main() {
    // Must come before anything reads the environment, including the
    // healthcheck, which resolves the port the same way the server does.
    dotenvy::dotenv().ok();

    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        std::process::exit(healthcheck().await);
    }

    init_tracing();

    if let Err(e) = run().await {
        // `eprintln!` rather than `error!`: a boot abort must reach a
        // `docker logs` reader even with `RUST_LOG` filtering errors out.
        eprintln!("{e}");
        std::process::exit(1);
    }
}

/// Plain text when stdout is not a terminal, and whenever `NO_COLOR` is set.
///
/// `docker logs` and CI capture have no TTY, and ANSI escapes there arrive as
/// literal `[2m…[0m` noise around every field.
fn init_tracing() {
    let no_color = std::env::var_os("NO_COLOR").is_some_and(|value| !value.is_empty());
    let ansi = std::io::stdout().is_terminal() && !no_color;

    tracing_subscriber::registry()
        .with(fmt::layer().with_ansi(ansi))
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
}

async fn run() -> Result<(), StartupError> {
    // Unprefixed names are no longer read. Failing here beats a node that
    // quietly advertises `http://localhost:5000` to peers that cannot reach it.
    let legacy = config::legacy_env_in_use();
    if !legacy.is_empty() {
        let lines: Vec<String> = legacy
            .iter()
            .map(|(old, new)| format!("configuration error: {old} is no longer read; use {new}"))
            .collect();
        return Err(StartupError::LegacyEnv(lines.join("\n")));
    }

    let config_file = config::ConfigFile::from_env();
    let loaded = config::load(&config_file)?;
    info!("\n{}", config::report(&loaded, &config_file.path));

    let server = loaded.settings.server.clone();

    // Advertised, not listened on: `public_port` differs from `port` whenever
    // the node is published on another port (`docker run -p 8080:5000`), and
    // peers must be told the one they can actually reach.
    let base_url = format!("{}:{}", server.base_url, server.public_port);

    warn_about_exposure(server.port, &loaded.settings.defaults);

    // `base_url` is not just where this server listens — it is the address
    // stamped into every transport URI this node hands to a peer, and the
    // address that peer will post to. A loopback value works only for peers in
    // the same network namespace, and the failure surfaces far from the cause.
    if let Some(warning) = config::loopback_base_url_warning(&base_url, running_in_container()) {
        warn!(base_url = %base_url, "{warning}");
    }

    // The relay dials whatever a browser names when the allowlist is `*`; say
    // so once, beside the exposure warning above.
    if loaded.settings.server.relay_allowlist() == config::RelayAllowlist::Any {
        warn!(
            "relay_allowed_hosts is \"*\": POST /derec/relay will dial any host a caller \
             names. Keep it to a trusted network."
        );
    }

    // Both listeners are bound before anything else starts — before the
    // database, the actor runtime and recovery. A taken port used to surface
    // as a panic *after* recovery had respawned every actor and the gRPC
    // listener was already serving; now it is the first thing checked, and a
    // failure here releases whatever was bound on the way out.
    let http_listener = bind_http(server.port).await?;
    let grpc_incoming = if loaded.settings.defaults.grpc_enabled {
        Some(bind_grpc(loaded.settings.defaults.grpc_port)?)
    } else {
        None
    };

    let pool = db::connect(&server.database_url)
        .await
        .map_err(|error| StartupError::Database {
            hint: error.hint(&server.database_url),
            error,
        })?;

    info!(
        database = %db::redact_url(&db::resolve_url(&server.database_url)),
        "database ready"
    );

    // After "database ready", so the warning is the last word on the subject a
    // developer scrolling the logs will see rather than being buried above it.
    db::warn_if_ephemeral(&server.database_url);

    let http_client = reqwest::Client::builder()
        .connect_timeout(OUTBOUND_CONNECT_TIMEOUT)
        .timeout(OUTBOUND_REQUEST_TIMEOUT)
        .build()
        .map_err(StartupError::HttpClient)?;

    let defaults = loaded.settings.defaults.clone();
    let public_grpc_port = server.public_grpc_port;

    let (arbiter_handle, actor_runtime) = start_actor_runtime()?;

    let state = Arc::new(
        AppState::new(
            base_url.as_str(),
            defaults,
            http_client,
            arbiter_handle,
            pool,
        )
        .with_config(loaded)
        .with_public_grpc_port(public_grpc_port),
    );

    // Turn the persisted rows back into a running node.
    let recovered = derec_backend::recovery::recover(&state).await;
    if recovered.failed > 0 {
        warn!(
            failed = recovered.failed,
            "some actors could not be recovered; see the warnings above"
        );
    }

    if let Some(incoming) = grpc_incoming {
        let grpc_state = Arc::clone(&state);
        tokio::spawn(async move {
            derec_backend::grpc::serve(grpc_state, incoming).await;
        });
    }

    // Helpers re-advertised at a new address tell their paired peers so. Run
    // after both listeners are up — a peer answers by dialling the address it
    // was just told — and in the background, since one unreachable peer costs
    // a full request timeout. The HTTP listener is already bound, so an answer
    // arriving before `serve_until_stopped` below accepts it waits in the
    // listen backlog rather than being refused.
    if !recovered.announce.is_empty() {
        let announcing = Arc::clone(&state);
        let helpers = recovered.announce.clone();
        tokio::spawn(async move {
            derec_backend::recovery::announce_new_addresses(&announcing, &helpers).await;
        });
    }

    let app = build_router(state);

    match http_listener.local_addr() {
        Ok(addr) => info!("server listening on {addr}"),
        Err(_) => info!("server listening on port {}", server.port),
    }
    info!("base URL: {base_url}");

    let served = serve_until_stopped(http_listener, app).await;

    actor_runtime.stop();
    served
}

/// Serve until a shutdown signal, then drain for at most [`SHUTDOWN_GRACE`].
///
/// axum's graceful shutdown waits for every open connection with no upper
/// bound, so one stalled client kept `docker stop` waiting until Docker gave up
/// and SIGKILLed the process — the exact unclean stop the SIGTERM handling
/// below exists to avoid. The deadline only starts once the signal has
/// arrived; until then the server runs as long as it is wanted.
async fn serve_until_stopped(
    listener: tokio::net::TcpListener,
    app: axum::Router,
) -> Result<(), StartupError> {
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        shutdown_signal().await;
        // Nobody listening means the server already returned; nothing to do.
        let _ = stop_tx.send(true);
    });

    // The value only ever changes once, false to true, so "changed" is
    // "stopping". Both receivers exist before the signal task can send, so
    // neither can miss it.
    let mut drain_rx = stop_rx.clone();
    let server = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            // An error means the signal task is gone without sending, which
            // only happens if it died; never shut down on that.
            if drain_rx.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        })
        .into_future();

    let mut deadline_rx = stop_rx;
    let deadline = async move {
        if deadline_rx.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
        tokio::time::sleep(SHUTDOWN_GRACE).await;
    };

    tokio::select! {
        result = server => result.map_err(StartupError::Serve),
        () = deadline => {
            warn!(
                grace_secs = SHUTDOWN_GRACE.as_secs(),
                "requests still open after the shutdown grace period; closing them"
            );
            Ok(())
        }
    }
}

/// Bind the HTTP listener, or explain why it could not be bound.
async fn bind_http(port: u16) -> Result<tokio::net::TcpListener, StartupError> {
    tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|source| StartupError::Bind {
            what: "HTTP",
            port,
            hint: bind_hint(&source, port, "server.port / DEREC_PORT"),
            source,
        })
}

/// Bind the gRPC listener, or explain why it could not be bound.
///
/// Bound here, synchronously, rather than inside the task that serves it: a
/// helper advertising an endpoint nothing is listening on pairs successfully
/// and then black-holes every reply, which is exactly what an unobserved bind
/// failure in a detached task would produce.
fn bind_grpc(port: u16) -> Result<tonic::transport::server::TcpIncoming, StartupError> {
    derec_backend::grpc::bind(port).map_err(|source| StartupError::Bind {
        what: "gRPC",
        port,
        hint: format!(
            "{} Or turn the listener off with DEREC_GRPC_ENABLED=false.",
            bind_hint(&source, port, "defaults.grpc_port / DEREC_GRPC_PORT")
        ),
        source,
    })
}

/// What to do about a listener that could not be bound.
fn bind_hint(error: &std::io::Error, port: u16, setting: &str) -> String {
    match error.kind() {
        std::io::ErrorKind::AddrInUse => format!(
            "Another process is already listening on port {port} — often a second copy of \
             this server. Stop it, or pick a free port with {setting}. In Docker, a clash on \
             the host side is fixed by remapping instead (-p 8080:{port}) and setting \
             DEREC_PUBLIC_PORT/DEREC_PUBLIC_GRPC_PORT to the published port."
        ),
        std::io::ErrorKind::PermissionDenied => format!(
            "Ports below 1024 need extra privileges; pick a higher one with {setting}."
        ),
        _ => format!("Check that the port is valid and free, or change it with {setting}."),
    }
}

/// Whether this process runs in a container, as far as cheap evidence says:
/// Docker's and Podman's marker files. A miss only picks the less specific
/// loopback warning.
fn running_in_container() -> bool {
    ["/.dockerenv", "/run/.containerenv"]
        .iter()
        .any(|marker| std::path::Path::new(marker).exists())
}

/// Say once, loudly, what this node exposes.
///
/// It is a development tool and the user has chosen to keep it open — there is
/// no authentication, `GET /actors` returns every channel's shared key, CORS
/// admits any origin, and the listeners bind every interface. None of that is
/// changed here; the point is that nobody should find out by accident.
fn warn_about_exposure(port: u16, defaults: &config::Defaults) {
    let grpc = if defaults.grpc_enabled {
        format!(" and gRPC port {}", defaults.grpc_port)
    } else {
        String::new()
    };
    warn!(
        "This is a development tool with NO authentication. It listens on all interfaces \
         (HTTP port {port}{grpc}), allows cross-origin requests from any site, and serves \
         every channel's shared keys from GET /actors. Anyone who can reach it can read \
         and drive every vault on it. Run it only on a trusted machine or LAN; never expose \
         it to the internet."
    );
}

/// Run the actix system on its own OS thread and hand back an arbiter handle.
///
/// Actix actors are `!Send`, so they need their own single-threaded runtime;
/// Axum handlers spawn actors onto it from the Tokio pool through the handle.
fn start_actor_runtime() -> Result<(actix_rt::ArbiterHandle, ActorRuntime), StartupError> {
    let shutdown = Arc::new(tokio::sync::Notify::new());
    let (tx, rx) = std::sync::mpsc::channel();

    let thread_shutdown = Arc::clone(&shutdown);
    std::thread::spawn(move || {
        let system = actix_rt::System::new();
        system.block_on(async {
            let arbiter = actix_rt::Arbiter::new();
            // A failed send means `start_actor_runtime` already gave up
            // waiting, so there is nobody left to tell.
            if tx.send((arbiter.handle(), arbiter)).is_err() {
                return;
            }
            // Keep the system alive until main() signals shutdown.
            thread_shutdown.notified().await;
        });
    });

    let (handle, arbiter) = rx.recv().map_err(|_| StartupError::ActorRuntime)?;
    Ok((handle, ActorRuntime { arbiter, shutdown }))
}

/// What it takes to stop the actor runtime started by [`start_actor_runtime`].
struct ActorRuntime {
    arbiter: actix_rt::Arbiter,
    shutdown: Arc<tokio::sync::Notify>,
}

impl ActorRuntime {
    fn stop(self) {
        self.arbiter.stop();
        // `notify_one` stores a permit if the thread is not waiting yet, so the
        // stop cannot be missed.
        self.shutdown.notify_one();
    }
}

/// Resolve on the first shutdown signal, whichever arrives.
///
/// SIGINT alone was enough under `cargo run`, where Ctrl-C is how a developer
/// stops it. `docker stop` sends **SIGTERM**, which nothing handled — so every
/// stop waited out the full grace period and was then SIGKILLed.
///
/// That was untidy before and is a correctness problem now: a SIGKILL closes
/// the database pool mid-write instead of draining it. Before persistence, the
/// state a killed process lost was going to be lost anyway.
///
/// SIGTERM is Unix-only in `tokio::signal`, which is fine — the container is
/// Linux — but the code still has to compile elsewhere, hence the `cfg`.
async fn shutdown_signal() {
    let interrupt = async {
        tokio::signal::ctrl_c().await.ok();
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(e) => {
                // Losing the SIGTERM arm is not fatal — SIGINT still works —
                // but it silently restores the old `docker stop` behaviour, so
                // it is worth saying out loud.
                warn!(error = %e, "could not listen for SIGTERM; docker stop will not drain");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = interrupt => info!("shutting down on SIGINT"),
        () = terminate => info!("shutting down on SIGTERM"),
    }
}

/// `derec-backend healthcheck`: exit 0 if this node's `/health` answers.
///
/// The image's `HEALTHCHECK` runs this instead of `curl
/// http://localhost:${DEREC_PORT}/health`, which only knew the port when it
/// came from that one variable — a port set in the config file, or left at
/// its default with the variable unset, probed the wrong address. Loading the
/// same configuration the server loads is the only way to agree with it.
///
/// Quiet on success, one line on stderr on failure: Docker keeps the output
/// of the last few probes in `docker inspect`, which is where it gets read.
async fn healthcheck() -> i32 {
    let port = match config::load(&config::ConfigFile::from_env()) {
        Ok(loaded) => loaded.settings.server.port,
        Err(e) => {
            eprintln!("healthcheck: {e}");
            return 1;
        }
    };

    let client = match reqwest::Client::builder()
        .timeout(HEALTHCHECK_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(e) => {
            eprintln!("healthcheck: {e}");
            return 1;
        }
    };

    let url = format!("http://127.0.0.1:{port}/health");
    match client.get(&url).send().await {
        Ok(response) if response.status().is_success() => 0,
        Ok(response) => {
            eprintln!("healthcheck: {url} answered {}", response.status());
            1
        }
        Err(e) => {
            eprintln!("healthcheck: {url} is not answering: {e}");
            1
        }
    }
}
