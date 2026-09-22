use std::sync::Arc;

use tracing::{info, warn};
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

use derec_backend::build_router;
use derec_backend::config;
use derec_backend::state::AppState;

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    tracing_subscriber::registry()
        .with(fmt::layer())
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    // Unprefixed names are no longer read. Failing here beats a node that
    // quietly advertises `http://localhost:5000` to peers that cannot reach it.
    let legacy = config::legacy_env_in_use();
    if !legacy.is_empty() {
        for (old, new) in &legacy {
            eprintln!("configuration error: {old} is no longer read; use {new}");
        }
        std::process::exit(1);
    }

    let loaded = load_configuration();

    info!("\n{}", config::report(&loaded, &config::configured_path()));

    let base_url = format!(
        "{}:{}",
        loaded.settings.server.base_url, loaded.settings.server.port
    );
    let port = loaded.settings.server.port;

    // `base_url` is not just where this server listens — it is the address
    // stamped into every transport URI this node hands to a peer, and the
    // address that peer will post to. A loopback value works right up until a
    // second device joins, at which point the peer dutifully sends to its *own*
    // localhost and the pairing dies with nothing pointing at the cause.
    if base_url.contains("localhost") || base_url.contains("127.0.0.1") {
        warn!(
            base_url = %base_url,
            "BASE_URL is loopback — reachable only from this machine. Set it to \
             this host's LAN address (e.g. DEREC_BASE_URL=http://192.168.0.28) \
             before pairing from another device."
        );
    }

    let defaults = loaded.settings.defaults.clone();

    let http_client = reqwest::Client::new();

    // Actix actors are !Send, so they need their own single-threaded runtime.
    // We spin one up on a dedicated OS thread and hand back an arbiter handle
    // that Axum handlers can use to spawn actors from the Tokio thread pool.
    let shutdown = Arc::new(tokio::sync::Notify::new());
    let (arbiter_handle, arbiter_stopper) = {
        let shutdown = Arc::clone(&shutdown);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let system = actix_rt::System::new();
            system.block_on(async {
                let arbiter = actix_rt::Arbiter::new();
                let handle = arbiter.handle();
                tx.send((handle, arbiter)).expect("failed to send arbiter handle");
                // Keep the system alive until main() signals shutdown.
                shutdown.notified().await;
            });
        });
        rx.recv().expect("failed to receive arbiter handle")
    };

    let state = Arc::new(
        AppState::new(base_url.as_str(), defaults, http_client, arbiter_handle)
            .with_config(loaded),
    );

    // Bound synchronously, before `axum::serve` starts, so a taken port aborts
    // boot here rather than failing silently inside a detached task — the
    // exact black-hole the config validation elsewhere in this file works to
    // prevent: a helper advertising an endpoint nothing is listening on pairs
    // successfully and then black-holes every reply.
    if state.defaults.grpc_enabled {
        let grpc_port = state.defaults.grpc_port;
        let incoming = derec_backend::grpc::bind(grpc_port).unwrap_or_else(|e| {
            tracing::error!(port = grpc_port, error = %e, "failed to bind gRPC port");
            eprintln!("failed to bind gRPC listen port {grpc_port}: {e}");
            std::process::exit(1);
        });

        let grpc_state = Arc::clone(&state);
        tokio::spawn(async move {
            derec_backend::grpc::serve(grpc_state, incoming).await;
        });
    }

    let app = build_router(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("failed to bind to port");

    info!("server listening on {}", listener.local_addr().unwrap());
    info!("base URL: {base_url}");

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
            info!("shutting down");
        })
        .await
        .expect("server error");

    arbiter_stopper.stop();
    shutdown.notify_one();
}

/// Read the merged configuration.
///
/// No file is the ordinary case for a plain `docker run` with nothing mounted,
/// so that falls back to the environment and the built-in values. A file that
/// *is* there but cannot be read, parsed, or validated aborts the boot: silently
/// serving stock values would leave a developer debugging a config they believe
/// is in effect.
fn load_configuration() -> config::Loaded {
    let path = config::configured_path();

    match config::load(&path) {
        Ok(loaded) => loaded,
        Err(e) => {
            // `tracing` is already initialised, but a boot abort should also
            // reach a plain `docker logs` reader who has filtered the level.
            eprintln!("configuration error: {e}");
            std::process::exit(1);
        }
    }
}
