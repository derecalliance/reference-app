// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

use std::io::IsTerminal;

use tracing_subscriber::{fmt, prelude::*, EnvFilter};

use derec_backend::infrastructure::server;

#[tokio::main]
async fn main() {
    // Must come before anything reads the environment, including the
    // healthcheck, which resolves the port the same way the server does.
    dotenvy::dotenv().ok();

    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        std::process::exit(server::healthcheck().await);
    }

    init_tracing();

    if let Err(e) = server::run().await {
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
