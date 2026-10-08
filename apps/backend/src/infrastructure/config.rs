// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! How this node is configured: a TOML file underneath `DEREC_*` environment
//! variables, underneath nothing but the built-in defaults.
//!
//! The app ships as a Docker image, so a developer who wants different starting
//! values should not have to edit code or retype them in the setup wizard on
//! every run. The server reads the file once at boot, merges the environment
//! over it, validates the result, and prints where every value came from.
//!
//! Two tables, with different weight:
//!
//! - `[server]` is how this node runs — addresses, ports, storage. Enforced.
//! - `[defaults]` is mostly the setup wizard's starting values, served from
//!   `GET /api/v1/config`. Those are defaults only: protocol settings travel on each
//!   provisioning request, so the values a vault actually runs with are
//!   whatever the front end sent. Three keys are the exception and are
//!   enforced by this process — `grpc_enabled` and `grpc_port` decide whether
//!   and where the gRPC listener runs, and `grpc_relay_enabled` decides whether
//!   the backend dials gRPC on a browser's behalf.
//!
//! Precedence, lowest first: built-in defaults < the file < environment
//! variables. The image's own values (static assets, database path, config
//! path) are *built-in defaults* compiled into its binary rather than
//! environment presets, so a mounted file can still change them.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use figment::{
    providers::{Format, Toml},
    value::{Dict, Map, Value},
    Figment, Metadata, Profile, Provider,
};
use serde::Deserialize;

// The configuration's data types live in `models` so services can read them
// without depending on this loader.
use crate::models::{
    AuthenticationMethod, ConfigOrigin, ConfigSource, DatabaseUrl, Defaults, LoadedConfig,
    RelayAllowlist, ServerSettings, Settings, UnpairAck, DEFAULT_DATABASE_URL,
};

/// Where to look for the config file when `DEREC_CONFIG_PATH` is unset.
///
/// `config.toml` in the working directory for a `cargo run`. The image builds
/// with `DEREC_BUILTIN_CONFIG_PATH=/etc/derec/config.toml`, so a file mounted
/// there is read with no variable to set. A compile-time value rather than an
/// `ENV` in the image: an environment preset would outrank the file, which is
/// exactly the precedence inversion this module exists to avoid.
const DEFAULT_CONFIG_PATH: &str = match option_env!("DEREC_BUILTIN_CONFIG_PATH") {
    Some(path) => path,
    None => "config.toml",
};

/// The built-in `static_dir`. Empty — no UI — for a `cargo run` beside Vite;
/// the image compiles in `/app/static` via `DEREC_BUILTIN_STATIC_DIR`, for the
/// same reason as [`DEFAULT_CONFIG_PATH`].
const DEFAULT_STATIC_DIR: &str = match option_env!("DEREC_BUILTIN_STATIC_DIR") {
    Some(dir) => dir,
    None => "",
};

/// Environment variable naming the config file.
const CONFIG_PATH_ENV: &str = "DEREC_CONFIG_PATH";

/// Prefix every configuration variable carries.
const ENV_PREFIX: &str = "DEREC_";

/// `DEREC_*` variables that are not configuration keys, so they are neither
/// read as settings nor warned about as unknown.
///
/// `DEREC_DATA_DIR` belongs to the image's entrypoint: it names the directory
/// the entrypoint hands to the runtime user before dropping root. The server
/// itself never reads it.
const RESERVED_ENV: &[&str] = &[CONFIG_PATH_ENV, "DEREC_DATA_DIR"];

/// The name the environment provider reports in figment metadata, which is how
/// an extraction error is traced back to a variable rather than to the file.
const ENV_PROVIDER_NAME: &str = "environment";

/// The shape a setting's value must take, so an environment string is parsed
/// by what the key *is* rather than by what the text looks like.
///
/// Guessing from the text is what made `DEREC_STATIC_DIR=2024` arrive as a
/// number and `DEREC_BASE_URL=true` as a boolean, both then rejected by serde
/// with an error about types the developer never chose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Bool,
    /// An unsigned integer no larger than `max`.
    Uint {
        max: u64,
    },
}

const U8: Kind = Kind::Uint {
    max: u8::MAX as u64,
};
const U16: Kind = Kind::Uint {
    max: u16::MAX as u64,
};
const U32: Kind = Kind::Uint {
    max: u32::MAX as u64,
};

/// One setting: the variable that sets it, where it lives in the file, and the
/// shape its value takes.
#[derive(Debug)]
struct EnvKey {
    variable: &'static str,
    path: &'static str,
    kind: Kind,
}

const fn key(variable: &'static str, path: &'static str, kind: Kind) -> EnvKey {
    EnvKey {
        variable,
        path,
        kind,
    }
}

/// Every setting, in the order the boot banner lists them.
///
/// Full names, not suffixes: [`ConfigSource::Env`] carries one of these straight into
/// the boot banner and into `/debug/config`, and a `&'static str` cannot be
/// assembled from a prefix at runtime without leaking.
///
/// Names are deliberately flat: the table a key lives in does not appear, so a
/// compose file reads as `DEREC_PARTICIPANT_COUNT` rather than
/// `DEREC_DEFAULTS__PARTICIPANT_COUNT`. Keys are unique across both tables,
/// which `the_env_namespace_has_no_collisions` enforces.
const ENV_KEYS: &[EnvKey] = &[
    key("DEREC_BASE_URL", "server.base_url", Kind::Text),
    key("DEREC_PORT", "server.port", U16),
    key("DEREC_DATABASE_URL", "server.database_url", Kind::Text),
    key("DEREC_STATIC_DIR", "server.static_dir", Kind::Text),
    key("DEREC_PUBLIC_PORT", "server.public_port", U16),
    key("DEREC_PUBLIC_GRPC_PORT", "server.public_grpc_port", U16),
    key(
        "DEREC_RELAY_ALLOWED_HOSTS",
        "server.relay_allowed_hosts",
        Kind::Text,
    ),
    key("DEREC_PARTICIPANT_COUNT", "defaults.participant_count", U8),
    key("DEREC_PRE_PAIRED_COUNT", "defaults.pre_paired_count", U8),
    key("DEREC_MIN_PARTICIPANTS", "defaults.min_participants", U8),
    key(
        "DEREC_RECOMMENDED_PARTICIPANTS",
        "defaults.recommended_participants",
        U8,
    ),
    key(
        "DEREC_PROTOCOL_TIMEOUT_SECS",
        "defaults.protocol_timeout_secs",
        U32,
    ),
    key(
        "DEREC_AUTHENTICATION_METHOD",
        "defaults.authentication_method",
        Kind::Text,
    ),
    key("DEREC_UNPAIR_ACK", "defaults.unpair_ack", Kind::Text),
    key(
        "DEREC_AUTO_ACCEPT_UNPAIR_REQUESTS",
        "defaults.auto_accept_unpair_requests",
        Kind::Bool,
    ),
    key(
        "DEREC_AUTO_ACCEPT_STORE_SHARE_REQUESTS",
        "defaults.auto_accept_store_share_requests",
        Kind::Bool,
    ),
    key(
        "DEREC_AUTO_ACCEPT_VERIFY_SHARE_REQUESTS",
        "defaults.auto_accept_verify_share_requests",
        Kind::Bool,
    ),
    key("DEREC_GRPC_ENABLED", "defaults.grpc_enabled", Kind::Bool),
    key("DEREC_GRPC_PORT", "defaults.grpc_port", U16),
    key(
        "DEREC_GRPC_RELAY_ENABLED",
        "defaults.grpc_relay_enabled",
        Kind::Bool,
    ),
    key(
        "DEREC_HELPER_TRANSPORTS_HTTP",
        "defaults.helper_transports.http",
        U8,
    ),
    key(
        "DEREC_HELPER_TRANSPORTS_GRPC",
        "defaults.helper_transports.grpc",
        U8,
    ),
    key(
        "DEREC_HELPER_TRANSPORTS_BOTH",
        "defaults.helper_transports.both",
        U8,
    ),
];

/// The three keys of the transport breakdown, named together by every check
/// that involves its sum.
const HELPER_TRANSPORTS: [&str; 3] = [
    "defaults.helper_transports.http",
    "defaults.helper_transports.grpc",
    "defaults.helper_transports.both",
];

/// Unprefixed names this app used to read, and what replaced them.
const LEGACY_ENV: &[(&str, &str)] = &[
    ("BASE_URL", "DEREC_BASE_URL"),
    ("PORT", "DEREC_PORT"),
    ("STATIC_DIR", "DEREC_STATIC_DIR"),
];

/// Legacy variables that are set while their replacement is not.
///
/// Set both and nothing is reported: that is a migrated environment keeping the
/// old name around for something else.
pub fn legacy_env_in_use() -> Vec<(&'static str, &'static str)> {
    LEGACY_ENV
        .iter()
        .filter(|(old, new)| std::env::var_os(old).is_some() && std::env::var_os(new).is_none())
        .copied()
        .collect()
}

/// The merged configuration tree as written, before unset fields are resolved.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    #[serde(default)]
    server: RawServer,
    #[serde(default)]
    defaults: RawDefaults,
}

/// Process settings, before unset fields are resolved.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawServer {
    base_url: Option<String>,
    port: Option<u16>,
    database_url: Option<String>,
    static_dir: Option<String>,
    public_port: Option<u16>,
    public_grpc_port: Option<u16>,
    relay_allowed_hosts: Option<String>,
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self {
            base_url: "http://localhost".to_owned(),
            port: 5000,
            public_port: 5000,
            public_grpc_port: Defaults::default().grpc_port,
            database_url: DEFAULT_DATABASE_URL.to_owned(),
            static_dir: DEFAULT_STATIC_DIR.to_owned(),
            relay_allowed_hosts: String::new(),
        }
    }
}

impl ServerSettings {
    /// `grpc_port` is the resolved listener from `[defaults]`, which an unset
    /// `public_grpc_port` follows.
    fn resolve(raw: RawServer, grpc_port: u16) -> Self {
        let base = Self::default();
        let port = raw.port.unwrap_or(base.port);
        Self {
            base_url: raw
                .base_url
                .map(|url| normalize_base_url(&url))
                .unwrap_or(base.base_url),
            port,
            public_port: raw.public_port.unwrap_or(port),
            public_grpc_port: raw.public_grpc_port.unwrap_or(grpc_port),
            database_url: raw.database_url.unwrap_or(base.database_url),
            static_dir: raw.static_dir.unwrap_or(base.static_dir),
            relay_allowed_hosts: raw
                .relay_allowed_hosts
                .map(|hosts| hosts.trim().to_owned())
                .unwrap_or(base.relay_allowed_hosts),
        }
    }

    fn validate(&self) -> Result<(), Violation> {
        if self.port == 0 {
            return Err(Violation::new(
                "port must be greater than 0",
                &["server.port"],
            ));
        }
        if self.public_port == 0 {
            return Err(Violation::new(
                "public_port must be greater than 0",
                &["server.public_port"],
            ));
        }
        if self.public_grpc_port == 0 {
            return Err(Violation::new(
                "public_grpc_port must be greater than 0",
                &["server.public_grpc_port"],
            ));
        }
        validate_base_url(&self.base_url)
            .map_err(|message| Violation::new(message, &["server.base_url"]))?;
        if self.database_url.trim().is_empty() {
            return Err(Violation::new(
                "database_url must not be empty",
                &["server.database_url"],
            ));
        }
        RelayAllowlist::parse(&self.relay_allowed_hosts)
            .map_err(|message| Violation::new(message, &["server.relay_allowed_hosts"]))?;
        Ok(())
    }
}

/// Settle the harmless spelling differences in a `base_url`, so every URI
/// built from it is in the one form the rest of the node compares against.
///
/// - A trailing slash is dropped; left in, it would advertise
///   `http://host/:5000/derec/…`.
/// - The scheme and host are lowercased. Both are case-insensitive, so
///   `HTTP://LOCALHOST` is a fine thing to type — but it used to pass boot
///   validation (the URL parser lowercases internally) and then be stamped
///   verbatim into every transport URI, where the SDK's scheme match refused
///   `HTTP://…` and provisioning failed with a 500.
///
/// Anything that is not `scheme://rest` is returned trimmed and otherwise
/// untouched, for [`validate_base_url`] to refuse with its own message.
fn normalize_base_url(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    match trimmed.split_once("://") {
        // The whole remainder is the authority: a path is refused by
        // validation, so there is nothing case-sensitive here to preserve.
        Some((scheme, authority)) => format!(
            "{}://{}",
            scheme.to_ascii_lowercase(),
            authority.to_ascii_lowercase()
        ),
        None => trimmed.to_owned(),
    }
}

/// Check that `base_url` is something a port can be appended to.
///
/// Every advertised URI is `{base_url}:{public_port}/derec/<id>`, so anything
/// beyond a scheme and a host produces an address nothing can dial — and the
/// failure would only surface later, as a peer that pairs and then never
/// answers. Each rejection names the setting that does what was attempted.
fn validate_base_url(base_url: &str) -> Result<(), String> {
    if base_url.is_empty() {
        return Err("base_url must not be empty".to_owned());
    }
    // Checked on the text before the URL parser sees it, because the parser
    // forgives exactly the spellings that matter here: it drops a default
    // port (`http://host:80` reads back with no port, yet the text with
    // `:{public_port}` appended is `http://host:80:5000`), drops an empty one
    // (`http://host:`), drops an empty user name (`http://@host`), and repairs
    // `http:/host` into `http://host` — all of which then boot and advertise
    // an address nothing can dial.
    let Some((_, authority)) = base_url.split_once("://") else {
        return Err(format!(
            "base_url must be a scheme and host, like http://192.168.0.28 (got {base_url:?})"
        ));
    };
    if authority.contains(['/', '?', '#']) {
        return Err(format!(
            "base_url must be a scheme and host only, with no path (got {base_url:?})"
        ));
    }
    if authority.contains('@') {
        return Err(format!(
            "base_url must not include a user name or password (got {base_url:?})"
        ));
    }
    // A bracketed IPv6 literal carries colons of its own; only one after the
    // closing bracket introduces a port.
    let after_host = match authority.strip_prefix('[') {
        Some(rest) => rest.split_once(']').map_or("", |(_, after)| after),
        None => authority,
    };
    if after_host.contains(':') {
        return Err(format!(
            "base_url must not include a port, not even an empty or default one (got \
             {base_url:?}); set the port peers dial with public_port (DEREC_PUBLIC_PORT)"
        ));
    }
    let url = reqwest::Url::parse(base_url).map_err(|_| {
        format!("base_url must be a scheme and host, like http://192.168.0.28 (got {base_url:?})")
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!(
            "base_url must start with http:// or https:// (got {base_url:?})"
        ));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(format!("base_url has no host (got {base_url:?})"));
    }
    // Every advertised URI is built from this, so credentials here would be
    // handed to every peer — and are never what a node's address needs.
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!(
            "base_url must not include a user name or password (got {base_url:?})"
        ));
    }
    if url.port().is_some() {
        return Err(format!(
            "base_url must not include a port (got {base_url:?}); set the port peers \
             dial with public_port (DEREC_PUBLIC_PORT)"
        ));
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(format!(
            "base_url must be a scheme and host only, with no path (got {base_url:?})"
        ));
    }
    Ok(())
}

/// What to say at boot about a loopback `base_url`, or `None` when it is not
/// loopback.
///
/// `base_url` is stamped into every address this node hands a peer, and a
/// peer dials it from where *it* runs. Loopback therefore reaches this node
/// only from the same network namespace: another process on this machine,
/// yes — two natively run nodes on one host can pair over loopback on
/// different ports — but not another device, and, in a container, not even
/// another container on the same host, whose loopback is its own. The old
/// warning ("reachable only from this machine") was wrong in exactly that
/// case, which is the one two-node Docker setups hit.
pub fn loopback_base_url_warning(base_url: &str, in_container: bool) -> Option<String> {
    let host = reqwest::Url::parse(base_url)
        .ok()?
        .host_str()?
        .to_ascii_lowercase();
    let loopback = host == "localhost" || host == "[::1]" || host.starts_with("127.");
    if !loopback {
        return None;
    }
    Some(if in_container {
        format!(
            "DEREC_BASE_URL is loopback ({base_url}) and this node runs in a container, where \
             loopback is the container itself. A browser on the host still reaches it through \
             the published port, but any other container — a second node included — and any \
             other device dials its own loopback and reaches nothing. To pair across nodes, \
             set DEREC_BASE_URL to an address every peer can reach: the host's LAN IP (e.g. \
             DEREC_BASE_URL=http://192.168.0.28, with DEREC_PUBLIC_PORT / \
             DEREC_PUBLIC_GRPC_PORT set to the published ports), or this container's name on \
             a Docker network the peers share."
        )
    } else {
        format!(
            "DEREC_BASE_URL is loopback ({base_url}). Browsers and other nodes on this machine \
             reach it, but another device, or a node in a container, dials its own loopback \
             and reaches nothing. Set DEREC_BASE_URL to this host's LAN address (e.g. \
             DEREC_BASE_URL=http://192.168.0.28) before pairing from anywhere else."
        )
    })
}

// Hand-written rather than derived: a derived `Default` would leave `origins`
// empty, and an empty origins list is a lie — it would make `/debug/config`
// report *no* settings rather than reporting that every setting is a built-in
// default, which is what a `LoadedConfig` nobody configured actually means.
impl Default for LoadedConfig {
    fn default() -> Self {
        Self {
            settings: Settings::default(),
            origins: ENV_KEYS
                .iter()
                .map(|key| ConfigOrigin {
                    path: key.path,
                    source: ConfigSource::Default,
                })
                .collect(),
            file_found: false,
            unknown_env: Vec::new(),
            empty_env: Vec::new(),
        }
    }
}

/// The `[defaults]` table as written, before unset fields are resolved.
///
/// Every field is optional, and knowing *which* were omitted is what lets
/// [`Defaults::resolve`] adapt the rest instead of validating a developer's one
/// override against three values they never touched.
///
/// `deny_unknown_fields` is on so a misspelled key fails loudly rather than
/// being silently ignored.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawDefaults {
    participant_count: Option<u8>,
    pre_paired_count: Option<u8>,
    min_participants: Option<u8>,
    recommended_participants: Option<u8>,
    protocol_timeout_secs: Option<u32>,
    authentication_method: Option<AuthenticationMethod>,
    unpair_ack: Option<UnpairAck>,
    auto_accept_unpair_requests: Option<bool>,
    auto_accept_store_share_requests: Option<bool>,
    auto_accept_verify_share_requests: Option<bool>,
    grpc_enabled: Option<bool>,
    grpc_port: Option<u16>,
    helper_transports: Option<crate::models::TransportBreakdown>,
    grpc_relay_enabled: Option<bool>,
}

/// Why configuration could not be loaded. Every variant's message names the
/// file or variable at fault and, where there is one, the usual fix — a boot
/// abort is read by someone who wants to change one line and try again.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error(
        "{variable} names {path}, but there is no such file. Check the path and the volume \
         mount (e.g. -v \"$PWD/config.toml:{path}:ro\"), or unset {variable} to run on \
         environment variables and built-in defaults alone"
    )]
    Missing {
        path: PathBuf,
        variable: &'static str,
    },
    #[error("could not read config file {path}: {source}{hint}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
        /// Empty, or a sentence starting with `; ` that says what usually
        /// causes this.
        hint: String,
    },
    #[error("could not parse config file {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: toml::de::Error,
    },
    /// One line per problem, each naming the file or variable that supplied
    /// the offending value.
    #[error("invalid configuration:\n{}", .problems.join("\n"))]
    Invalid { problems: Vec<String> },
}

/// A rule the merged configuration breaks, and the settings involved.
///
/// The keys are dotted paths, so the error can say where each involved value
/// came from: a conflict between a file value and an environment override
/// reads very differently from a typo in one place.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Violation {
    message: String,
    keys: Vec<&'static str>,
}

impl Violation {
    fn new(message: impl Into<String>, keys: &[&'static str]) -> Self {
        Self {
            message: message.into(),
            keys: keys.to_vec(),
        }
    }

    /// Render for a boot abort: the rule, then each involved setting with its
    /// value and the layer that supplied it.
    fn describe(
        &self,
        origins: &[ConfigOrigin],
        values: &[(String, String)],
        file: &Path,
    ) -> String {
        let mut out = format!("  - {}", self.message);
        for key in &self.keys {
            let value = values
                .iter()
                .find(|(path, _)| path.as_str() == *key)
                .map_or("?", |(_, value)| value.as_str());
            let source = origins
                .iter()
                .find(|origin| origin.path == *key)
                .map_or(ConfigSource::Default, |origin| origin.source.clone());
            let _ = write!(
                out,
                "\n      {} = {}  ({})",
                leaf_of(key),
                value,
                describe_source(&source, file)
            );
        }
        // The usual cause of a participant conflict is a value pinned in one
        // layer that no longer fits a count changed in another — exactly what
        // leaving it unset would have adapted automatically.
        if self.keys.len() > 1 && self.keys.contains(&"defaults.participant_count") {
            out.push_str(
                "\n      Settings left unset adapt to participant_count; remove any you did not \
                 mean to pin.",
            );
        }
        out
    }
}

/// Where a value came from, in words.
fn describe_source(source: &ConfigSource, file: &Path) -> String {
    match source {
        ConfigSource::Default => "built-in default".to_owned(),
        ConfigSource::File => format!("file {}", file.display()),
        ConfigSource::Env(variable) => format!("env {variable}"),
    }
}

impl Defaults {
    /// Fill unset fields around the ones the file actually specified.
    ///
    /// A developer who writes only `participant_count = 4` means "four
    /// participants", not "four participants and please fail because the stock
    /// recommendation of five no longer fits". So the participant thresholds,
    /// which are only meaningful relative to the total, are clamped to it when
    /// left unset. A value the file *does* state is never adjusted — it goes to
    /// [`Defaults::validate`] as written, so a genuine contradiction still
    /// aborts the boot.
    fn resolve(raw: RawDefaults) -> Self {
        let base = Self::default();

        let participant_count = raw.participant_count.unwrap_or(base.participant_count);
        let min_participants = raw
            .min_participants
            .unwrap_or_else(|| base.min_participants.min(participant_count).max(1));
        let recommended_participants = raw.recommended_participants.unwrap_or_else(|| {
            base.recommended_participants
                .clamp(min_participants, participant_count.max(min_participants))
        });
        let pre_paired_count = raw
            .pre_paired_count
            .unwrap_or_else(|| base.pre_paired_count.min(participant_count));

        Self {
            participant_count,
            pre_paired_count,
            min_participants,
            recommended_participants,
            protocol_timeout_secs: raw
                .protocol_timeout_secs
                .unwrap_or(base.protocol_timeout_secs),
            authentication_method: raw
                .authentication_method
                .unwrap_or(base.authentication_method),
            unpair_ack: raw.unpair_ack.unwrap_or(base.unpair_ack),
            auto_accept_unpair_requests: raw
                .auto_accept_unpair_requests
                .unwrap_or(base.auto_accept_unpair_requests),
            auto_accept_store_share_requests: raw
                .auto_accept_store_share_requests
                .unwrap_or(base.auto_accept_store_share_requests),
            auto_accept_verify_share_requests: raw
                .auto_accept_verify_share_requests
                .unwrap_or(base.auto_accept_verify_share_requests),
            grpc_enabled: raw.grpc_enabled.unwrap_or(base.grpc_enabled),
            grpc_port: raw.grpc_port.unwrap_or(base.grpc_port),
            helper_transports: raw
                .helper_transports
                .unwrap_or(crate::models::TransportBreakdown {
                    http: participant_count,
                    grpc: 0,
                    both: 0,
                }),
            grpc_relay_enabled: raw.grpc_relay_enabled.unwrap_or(base.grpc_relay_enabled),
        }
    }

    /// Rejects combinations the wizard could never produce, so a mistake
    /// surfaces at boot rather than as a confusing UI state much later.
    fn validate(&self) -> Result<(), Violation> {
        const COUNT: &str = "defaults.participant_count";
        const MIN: &str = "defaults.min_participants";
        const RECOMMENDED: &str = "defaults.recommended_participants";

        if self.participant_count == 0 {
            return Err(Violation::new(
                "participant_count must be at least 1",
                &[COUNT],
            ));
        }
        if self.min_participants == 0 {
            return Err(Violation::new(
                "min_participants must be at least 1",
                &[MIN],
            ));
        }
        if self.protocol_timeout_secs == 0 {
            return Err(Violation::new(
                "protocol_timeout_secs must be greater than 0",
                &["defaults.protocol_timeout_secs"],
            ));
        }
        if self.min_participants > self.participant_count {
            return Err(Violation::new(
                format!(
                    "min_participants ({}) exceeds participant_count ({})",
                    self.min_participants, self.participant_count
                ),
                &[MIN, COUNT],
            ));
        }
        if self.recommended_participants < self.min_participants {
            return Err(Violation::new(
                format!(
                    "recommended_participants ({}) is below min_participants ({})",
                    self.recommended_participants, self.min_participants
                ),
                &[RECOMMENDED, MIN],
            ));
        }
        if self.recommended_participants > self.participant_count {
            return Err(Violation::new(
                format!(
                    "recommended_participants ({}) exceeds participant_count ({})",
                    self.recommended_participants, self.participant_count
                ),
                &[RECOMMENDED, COUNT],
            ));
        }
        if self.pre_paired_count > self.participant_count {
            return Err(Violation::new(
                format!(
                    "pre_paired_count ({}) exceeds participant_count ({})",
                    self.pre_paired_count, self.participant_count
                ),
                &["defaults.pre_paired_count", COUNT],
            ));
        }
        if self.helper_transports.total() != self.participant_count as usize {
            let mut keys = HELPER_TRANSPORTS.to_vec();
            keys.push(COUNT);
            return Err(Violation::new(
                format!(
                    "helper_transports sums to {} but participant_count is {}",
                    self.helper_transports.total(),
                    self.participant_count
                ),
                &keys,
            ));
        }
        if !self.grpc_enabled
            && (self.helper_transports.grpc > 0 || self.helper_transports.both > 0)
        {
            return Err(Violation::new(
                "helper_transports asks for gRPC helpers but grpc_enabled is false",
                &[
                    "defaults.grpc_enabled",
                    "defaults.helper_transports.grpc",
                    "defaults.helper_transports.both",
                ],
            ));
        }
        if self.grpc_port == 0 {
            return Err(Violation::new(
                "grpc_port must be greater than 0",
                &["defaults.grpc_port"],
            ));
        }
        Ok(())
    }
}

/// Parse one environment value by the shape its key takes.
///
/// Surrounding whitespace is dropped first: a value out of a compose file or a
/// `.env` with a stray space is a typo, not a request for a database named
/// `" ./derec.db"`.
fn coerce(key: &EnvKey, raw: &str) -> Result<Value, String> {
    let value = raw.trim();
    match key.kind {
        Kind::Text => Ok(Value::from(value)),
        Kind::Bool => parse_bool(value).map(Value::from).ok_or_else(|| {
            format!(
                "{}={raw:?} is not a boolean; use true or false",
                key.variable
            )
        }),
        Kind::Uint { max } => value
            .parse::<u64>()
            .ok()
            .filter(|n| *n <= max)
            .map(Value::from)
            .ok_or_else(|| {
                format!(
                    "{}={raw:?} is not a whole number between 0 and {max}",
                    key.variable
                )
            }),
    }
}

/// The spellings of a boolean an environment variable may use, in any case.
fn parse_bool(value: &str) -> Option<bool> {
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Reads `DEREC_*` into the config tree.
///
/// A hand-written provider rather than figment's `Env`: this one owns the
/// flat-name-to-dotted-path mapping, parses each value by its key's type, and
/// separates variables that match a known key from ones that do not, which is
/// what makes "unknown warns" possible.
#[derive(Clone)]
struct EnvProvider {
    values: Vec<(&'static str, Value)>,
    unknown: Vec<String>,
    /// Known variables set to an empty value. Ignored rather than read as an
    /// empty setting: compose interpolates an undefined `${VAR}` to the empty
    /// string, and that means "I did not set this", not "set it to nothing".
    empty: Vec<&'static str>,
    /// Values that could not be parsed, already worded for the operator.
    errors: Vec<String>,
}

impl EnvProvider {
    fn from_env() -> Self {
        let mut values = Vec::new();
        let mut unknown = Vec::new();
        let mut empty = Vec::new();
        let mut errors = Vec::new();

        // `vars_os`, not `vars`: the latter panics on the first non-UTF-8
        // value anywhere in the environment, including ones that are not ours.
        for (name, raw) in std::env::vars_os() {
            let Some(name) = name.to_str() else {
                continue;
            };
            if !name.starts_with(ENV_PREFIX) || RESERVED_ENV.contains(&name) {
                continue;
            }
            let Some(key) = ENV_KEYS.iter().find(|key| key.variable == name) else {
                unknown.push(name.to_owned());
                continue;
            };
            let Some(raw) = raw.to_str() else {
                errors.push(format!("{name} is not valid UTF-8"));
                continue;
            };
            if raw.trim().is_empty() {
                empty.push(key.variable);
                continue;
            }
            match coerce(key, raw) {
                Ok(value) => values.push((key.path, value)),
                Err(message) => errors.push(message),
            }
        }

        values.sort_by_key(|(path, _)| *path);
        unknown.sort();
        empty.sort_unstable();
        errors.sort();
        Self {
            values,
            unknown,
            empty,
            errors,
        }
    }

    /// Whether the environment set `path`.
    fn supplies(&self, path: &str) -> bool {
        self.values.iter().any(|(p, _)| *p == path)
    }

    /// The variable that maps to `path`, if any.
    fn variable_for(path: &str) -> Option<&'static str> {
        ENV_KEYS
            .iter()
            .find(|key| key.path == path)
            .map(|key| key.variable)
    }
}

/// Insert `value` at a dotted path, creating intermediate dictionaries.
fn insert_path(root: &mut Dict, path: &str, value: Value) {
    let mut segments: Vec<&str> = path.split('.').collect();
    let Some(leaf) = segments.pop() else {
        return;
    };

    let mut cursor = root;
    for segment in segments {
        let entry = cursor
            .entry(segment.to_owned())
            .or_insert_with(|| Value::from(Dict::new()));
        match entry {
            Value::Dict(_, dict) => cursor = dict,
            _ => return,
        }
    }
    cursor.insert(leaf.to_owned(), value);
}

impl Provider for EnvProvider {
    fn metadata(&self) -> Metadata {
        Metadata::named(ENV_PROVIDER_NAME)
    }

    fn data(&self) -> Result<Map<Profile, Dict>, figment::Error> {
        let mut root = Dict::new();
        for (path, value) in &self.values {
            insert_path(&mut root, path, value.clone());
        }
        Ok(Profile::Default.collect(root))
    }
}

/// Word one figment extraction error for the operator.
///
/// Figment's own `Display` prefixes the key with its profile
/// (`default.server.port`) and names the provider generically ("TOML source
/// string"), neither of which is a thing the operator wrote. This names the
/// plain key and the actual variable or file.
fn describe_extract_error(error: &figment::Error, file: &Path) -> String {
    let key = error.path.join(".");
    // An unknown key can only have come from the file — the environment
    // provider maps known variables and nothing else — whatever metadata the
    // enclosing table happens to carry after the merge.
    let unknown_key = matches!(error.kind, figment::error::Kind::UnknownField(..));
    let from_env = !unknown_key
        && error
            .metadata
            .as_ref()
            .is_some_and(|metadata| metadata.name == ENV_PROVIDER_NAME);

    let source = if from_env {
        EnvProvider::variable_for(&key)
            .map_or_else(|| "the environment".to_owned(), |v| format!("env {v}"))
    } else {
        format!("file {}", file.display())
    };

    if key.is_empty() {
        format!("  - {} ({source})", error.kind)
    } else {
        format!("  - {key}: {} ({source})", error.kind)
    }
}

impl Settings {
    /// Merge file and environment into one validated configuration.
    ///
    /// `contents` is `None` when no file was found, which is the ordinary case
    /// for a plain `docker run` with nothing mounted.
    ///
    /// There is no figment defaults provider on purpose. [`Defaults::resolve`]
    /// owns the built-in values *and* adapts the participant thresholds around
    /// whatever count survived the merge; a defaults layer would fill every
    /// `Option` first and turn each unset field into an explicit one.
    pub fn merge(path: &Path, contents: Option<String>) -> Result<LoadedConfig, ConfigError> {
        let file_found = contents.is_some();
        let body = contents.unwrap_or_default();

        // Parse first so a syntax error keeps reporting as `Parse`.
        let _: toml::Value = body.parse().map_err(|source| ConfigError::Parse {
            path: path.to_path_buf(),
            source,
        })?;

        let env = EnvProvider::from_env();
        if !env.errors.is_empty() {
            // Reported on their own: merging without the values that failed to
            // parse would go on to validate a configuration nobody wrote.
            return Err(ConfigError::Invalid {
                problems: env.errors.iter().map(|e| format!("  - {e}")).collect(),
            });
        }

        let from_file = Figment::from(Toml::string(&body));
        let merged = Figment::from(Toml::string(&body)).merge(env.clone());

        let raw: RawConfig = merged.extract().map_err(|error| ConfigError::Invalid {
            problems: error
                .into_iter()
                .map(|e| describe_extract_error(&e, path))
                .collect(),
        })?;

        let defaults = Defaults::resolve(raw.defaults);
        let settings = Settings {
            server: ServerSettings::resolve(raw.server, defaults.grpc_port),
            defaults,
        };

        // Before validation, so a rejection can say which layer supplied each
        // value it names.
        let origins: Vec<ConfigOrigin> = ENV_KEYS
            .iter()
            .map(|key| {
                let source = if env.supplies(key.path) {
                    ConfigSource::Env(key.variable)
                } else if from_file.find_value(key.path).is_ok() {
                    ConfigSource::File
                } else {
                    ConfigSource::Default
                };
                ConfigOrigin {
                    path: key.path,
                    source,
                }
            })
            .collect();

        let violations = settings.validate();
        if !violations.is_empty() {
            let values = values_by_path(&settings);
            return Err(ConfigError::Invalid {
                problems: violations
                    .iter()
                    .map(|v| v.describe(&origins, &values, path))
                    .collect(),
            });
        }

        Ok(LoadedConfig {
            settings,
            origins,
            file_found,
            unknown_env: env.unknown,
            empty_env: env.empty,
        })
    }

    /// Every rule the merged result breaks — one per table at most, plus the
    /// checks that span both.
    fn validate(&self) -> Vec<Violation> {
        let mut violations = Vec::new();
        if let Err(v) = self.server.validate() {
            violations.push(v);
        }
        if let Err(v) = self.defaults.validate() {
            violations.push(v);
        }
        // Caught here rather than as a bind failure: the second listener would
        // fail with "address in use" against *this* process, which reads like
        // some other program holding the port.
        if self.defaults.grpc_enabled && self.server.port == self.defaults.grpc_port {
            violations.push(Violation::new(
                format!(
                    "port and grpc_port are both {}; the HTTP and gRPC listeners need \
                     different ports (or set grpc_enabled = false)",
                    self.server.port
                ),
                &["server.port", "defaults.grpc_port"],
            ));
        }
        violations
    }
}

/// Which config file to read, and whether its absence is an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigFile {
    pub path: PathBuf,
    /// Named by `DEREC_CONFIG_PATH`. An explicit path that does not exist is a
    /// mistake worth stopping for — a typo or a mount that did not happen —
    /// while a missing file at the built-in path is the ordinary unconfigured
    /// run.
    pub explicit: bool,
}

impl ConfigFile {
    /// The file the server will read, honouring `DEREC_CONFIG_PATH`.
    ///
    /// An empty or whitespace-only value counts as unset, matching every other
    /// variable: compose turns an undefined `${VAR}` into the empty string, and
    /// an empty path is not one anybody means.
    pub fn from_env() -> Self {
        let named = std::env::var_os(CONFIG_PATH_ENV)
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().to_string_lossy().trim().is_empty());
        match named {
            Some(path) => Self {
                path,
                explicit: true,
            },
            None => Self {
                path: PathBuf::from(DEFAULT_CONFIG_PATH),
                explicit: false,
            },
        }
    }
}

/// Render the resolved configuration for the boot log.
///
/// Every setting appears, not only the overridden ones: a developer who set a
/// variable and saw no effect needs to see that key reported as `default`,
/// because that *is* the diagnosis. Order follows [`ENV_KEYS`], which is fixed,
/// so two runs of the same configuration produce identical text and can be
/// diffed.
pub fn report(loaded: &LoadedConfig, path: &Path) -> String {
    let mut out = String::from("configuration\n");

    let _ = writeln!(
        out,
        "  file   {}  {}",
        path.display(),
        if loaded.file_found {
            "loaded"
        } else {
            "not found"
        }
    );
    let env_count = loaded
        .origins
        .iter()
        .filter(|o| matches!(o.source, ConfigSource::Env(_)))
        .count();
    let _ = writeln!(out, "  env    {env_count} DEREC_* variables");

    for name in &loaded.unknown_env {
        let _ = writeln!(out, "  env    {name} is not a known setting; ignored");
    }
    for name in &loaded.empty_env {
        let _ = writeln!(out, "  env    {name} is set but empty; ignored");
    }

    let values = values_by_path(&loaded.settings);
    let width = ENV_KEYS
        .iter()
        .map(|key| leaf_of(key.path).len())
        .max()
        .unwrap_or(0);

    let mut table = String::new();
    for key in ENV_KEYS {
        let table_name = key.path.split('.').next().unwrap_or("");
        if !table.contains(&format!("[{table_name}]")) {
            let _ = write!(table, "\n  [{table_name}]\n");
        }

        let origin = loaded
            .origins
            .iter()
            .find(|o| o.path == key.path)
            .map(|o| match o.source {
                ConfigSource::Default => "default".to_owned(),
                ConfigSource::File => "file".to_owned(),
                ConfigSource::Env(name) => format!("env {name}"),
            })
            .unwrap_or_else(|| "default".to_owned());

        let value = values
            .iter()
            .find(|(p, _)| p == key.path)
            .map(|(_, v)| v.clone())
            .unwrap_or_default();

        let _ = writeln!(
            table,
            "  {:<width$}  {:<24}  {}",
            leaf_of(key.path),
            value,
            origin,
            width = width
        );
    }

    out.push_str(&table);
    out
}

/// The part of a dotted path the banner shows, e.g.
/// `defaults.helper_transports.http` → `helper_transports.http`.
fn leaf_of(path: &str) -> &str {
    path.split_once('.').map(|(_, rest)| rest).unwrap_or(path)
}

/// Every setting's value as displayed text, keyed by its dotted path.
///
/// Goes through `serde_json` rather than a hand-written match so a field added
/// to [`Defaults`] cannot be silently missing from the banner — the
/// `every_config_path_gets_an_origin` test pairs with this to keep both honest.
fn values_by_path(settings: &Settings) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Ok(root) = serde_json::to_value(settings) else {
        return out;
    };

    for key in ENV_KEYS {
        let mut cursor = &root;
        let mut found = true;
        for segment in key.path.split('.') {
            match cursor.get(segment) {
                Some(next) => cursor = next,
                None => {
                    found = false;
                    break;
                }
            }
        }
        if found {
            let text = match cursor {
                // The banner and boot errors reach logs; a Postgres URL
                // carries its password.
                serde_json::Value::String(s) if key.path == "server.database_url" => {
                    DatabaseUrl::redact(s)
                }
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            out.push((key.path.to_owned(), text));
        }
    }
    out
}

/// Read configuration from `file`, merged with the environment.
///
/// A missing file at the built-in path is not an error — that is the ordinary
/// `docker run` case, and the environment plus built-in defaults are a complete
/// configuration. A missing file that `DEREC_CONFIG_PATH` named *is*, and so is
/// every other read failure: a developer who mounted a file wants to hear that
/// it was not used at boot rather than silently get stock values.
pub fn load(file: &ConfigFile) -> Result<LoadedConfig, ConfigError> {
    let path = &file.path;
    let contents = match std::fs::read_to_string(path) {
        Ok(c) => Some(c),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            if file.explicit {
                return Err(ConfigError::Missing {
                    path: path.clone(),
                    variable: CONFIG_PATH_ENV,
                });
            }
            None
        }
        Err(source) => {
            return Err(ConfigError::Read {
                path: path.clone(),
                hint: read_hint(path, &source),
                source,
            });
        }
    };

    Settings::merge(path, contents)
}

/// What usually causes a config file that exists to be unreadable.
fn read_hint(path: &Path, error: &std::io::Error) -> String {
    if path.is_dir() {
        // The single most common Docker mistake with this app: bind-mounting a
        // host file that does not exist makes Docker create a *directory* in
        // its place, on the host and in the container.
        "; it is a directory, not a file. Docker creates an empty directory when a \
         bind-mounted file does not exist on the host: create the file on the host (or \
         drop the mount), remove the stray directory, and recreate the container"
            .to_owned()
    } else if error.kind() == std::io::ErrorKind::PermissionDenied {
        "; make it readable by the user the server runs as (uid 10001 in the image), \
         e.g. chmod a+r on the host"
            .to_owned()
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    /// Set `vars` for the duration of `body`, restoring the previous values
    /// afterwards. Tests touching the process environment must not run
    /// concurrently; `ENV_LOCK` serialises them.
    ///
    /// Every test that reads configuration goes through here, including the ones
    /// setting nothing: `Settings::merge` reads the whole process environment, so
    /// a test that skipped the lock could see another test's `DEREC_*` variable.
    fn with_env<T>(vars: &[(&str, &str)], body: impl FnOnce() -> T) -> T {
        use std::sync::{Mutex, OnceLock};
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _guard = ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let saved: Vec<(String, Option<String>)> = vars
            .iter()
            .map(|(k, _)| ((*k).to_owned(), std::env::var(k).ok()))
            .collect();

        // This crate is edition 2021, where `set_var`/`remove_var` are safe.
        for (k, v) in vars {
            std::env::set_var(k, v);
        }
        let out = body();
        for (k, v) in saved {
            match v {
                Some(v) => std::env::set_var(&k, v),
                None => std::env::remove_var(&k),
            }
        }
        out
    }

    fn settings_from(contents: &str, vars: &[(&str, &str)]) -> LoadedConfig {
        with_env(vars, || {
            Settings::merge(Path::new("test.toml"), Some(contents.to_owned()))
                .expect("settings must load")
        })
    }

    fn error_from(contents: &str, vars: &[(&str, &str)]) -> String {
        with_env(vars, || {
            Settings::merge(Path::new("test.toml"), Some(contents.to_owned()))
                .expect_err("settings must be rejected")
                .to_string()
        })
    }

    fn example_path() -> PathBuf {
        // It lives in the repo-wide `examples/` directory, beside the compose
        // and `.env` examples, rather than in this package — the three are read
        // together and a developer should not have to hunt two directories for
        // them. Hence the climb out of `apps/backend`.
        PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../examples/config.example.toml"
        ))
    }

    fn explicit(path: impl Into<PathBuf>) -> ConfigFile {
        ConfigFile {
            path: path.into(),
            explicit: true,
        }
    }

    /// The `[defaults]` half on its own, for the tests that predate `[server]`.
    ///
    /// They all state bare keys, which the two-table file shape now nests, so
    /// the header goes on here rather than in fourteen string literals.
    fn parse(contents: &str) -> Result<Defaults, ConfigError> {
        let body = format!("[defaults]\n{contents}\n");
        with_env(&[], || Settings::merge(Path::new("test.toml"), Some(body)))
            .map(|loaded| loaded.settings.defaults)
    }

    #[test]
    fn an_empty_file_yields_the_built_in_defaults() {
        assert_eq!(parse("").unwrap(), Defaults::default());
    }

    #[test]
    fn a_partial_file_overrides_only_what_it_names() {
        // The point of `#[serde(default)]` per field: a developer who only cares
        // about the timeout should not have to restate the other seven values,
        // and doing so must not reset them.
        let parsed = parse("protocol_timeout_secs = 45").unwrap();

        assert_eq!(parsed.protocol_timeout_secs, 45);
        assert_eq!(
            parsed.participant_count,
            Defaults::default().participant_count
        );
        assert_eq!(parsed.unpair_ack, Defaults::default().unpair_ack);
    }

    #[test]
    fn every_field_is_settable() {
        let parsed = parse(
            r#"
            participant_count = 9
            pre_paired_count = 4
            min_participants = 2
            recommended_participants = 6
            protocol_timeout_secs = 120
            authentication_method = "user"
            unpair_ack = "not_required"
            auto_accept_unpair_requests = false
            auto_accept_store_share_requests = true
            auto_accept_verify_share_requests = true
            grpc_enabled = true
            grpc_port = 60051
            helper_transports = { http = 5, grpc = 4, both = 0 }
            grpc_relay_enabled = false
            "#,
        )
        .unwrap();

        assert_eq!(
            parsed,
            Defaults {
                participant_count: 9,
                pre_paired_count: 4,
                min_participants: 2,
                recommended_participants: 6,
                protocol_timeout_secs: 120,
                authentication_method: AuthenticationMethod::User,
                unpair_ack: UnpairAck::NotRequired,
                auto_accept_unpair_requests: false,
                auto_accept_store_share_requests: true,
                auto_accept_verify_share_requests: true,
                grpc_enabled: true,
                grpc_port: 60051,
                helper_transports: crate::models::TransportBreakdown {
                    http: 5,
                    grpc: 4,
                    both: 0,
                },
                grpc_relay_enabled: false,
            }
        );
    }

    #[test]
    fn malformed_toml_is_rejected() {
        assert!(matches!(
            parse("participant_count = ").unwrap_err(),
            ConfigError::Parse { .. }
        ));
    }

    #[test]
    fn thresholds_above_an_explicit_participant_count_are_rejected() {
        // Each of these *states* the offending value, so it is a real
        // contradiction rather than a stock default that no longer fits.
        for contents in [
            "participant_count = 3\nmin_participants = 4\nrecommended_participants = 4",
            "participant_count = 3\nmin_participants = 1\nrecommended_participants = 5",
            "participant_count = 3\nmin_participants = 1\nrecommended_participants = 3\npre_paired_count = 4",
        ] {
            assert!(
                matches!(parse(contents).unwrap_err(), ConfigError::Invalid { .. }),
                "expected rejection for:\n{contents}"
            );
        }
    }

    #[test]
    fn lowering_only_the_participant_count_clamps_the_untouched_thresholds() {
        // The whole point of a partial config. Stock defaults are 7/3/3/5, so a
        // developer who writes just `participant_count = 2` would otherwise be
        // told their file is invalid because of three values they never wrote.
        let parsed = parse("participant_count = 2").unwrap();

        assert_eq!(parsed.participant_count, 2);
        assert_eq!(parsed.min_participants, 2);
        assert_eq!(parsed.recommended_participants, 2);
        assert_eq!(parsed.pre_paired_count, 2);
        assert_eq!(
            parsed.helper_transports,
            crate::models::TransportBreakdown {
                http: 2,
                grpc: 0,
                both: 0
            }
        );
        assert_eq!(parsed.validate(), Ok(()));
    }

    #[test]
    fn raising_only_the_minimum_lifts_an_untouched_recommendation() {
        // Stock recommendation is 5; a minimum above it must not produce a
        // recommendation that sits below the minimum.
        let parsed = parse("min_participants = 6").unwrap();

        assert_eq!(parsed.min_participants, 6);
        assert_eq!(parsed.recommended_participants, 6);
        assert_eq!(parsed.validate(), Ok(()));
    }

    #[test]
    fn an_explicit_value_is_never_silently_adjusted() {
        // Clamping applies only to fields the file left out. A stated value is
        // either honoured exactly or reported — never quietly rewritten.
        let parsed = parse("participant_count = 9\nrecommended_participants = 6").unwrap();

        assert_eq!(parsed.recommended_participants, 6);
    }

    #[test]
    fn a_recommended_count_below_the_minimum_is_rejected() {
        let contents = "participant_count = 9\nmin_participants = 5\nrecommended_participants = 2";

        assert!(matches!(
            parse(contents).unwrap_err(),
            ConfigError::Invalid { .. }
        ));
    }

    #[test]
    fn zero_valued_counts_and_timeouts_are_rejected() {
        for contents in [
            "participant_count = 0",
            "min_participants = 0",
            "protocol_timeout_secs = 0",
        ] {
            assert!(
                matches!(parse(contents).unwrap_err(), ConfigError::Invalid { .. }),
                "expected rejection for: {contents}"
            );
        }
    }

    #[test]
    fn a_helper_transports_breakdown_that_does_not_sum_to_the_participant_count_is_rejected() {
        let contents =
            "participant_count = 9\nhelper_transports = { http = 5, grpc = 0, both = 0 }";

        assert!(matches!(
            parse(contents).unwrap_err(),
            ConfigError::Invalid { .. }
        ));
    }

    #[test]
    fn requesting_grpc_helpers_while_grpc_is_disabled_is_rejected() {
        // Not a silent downgrade to HTTP: a helper advertising an endpoint
        // nothing is listening on pairs successfully and then black-holes
        // every reply.
        let contents = "participant_count = 9\ngrpc_enabled = false\nhelper_transports = { http = 5, grpc = 4, both = 0 }";

        assert!(matches!(
            parse(contents).unwrap_err(),
            ConfigError::Invalid { .. }
        ));
    }

    #[test]
    fn a_zero_grpc_port_is_rejected() {
        assert!(matches!(
            parse("grpc_port = 0").unwrap_err(),
            ConfigError::Invalid { .. }
        ));
    }

    #[test]
    fn the_built_in_defaults_satisfy_their_own_validation() {
        // Otherwise a deployment with no config file would be in a state the
        // server refuses to accept from a file.
        assert_eq!(Defaults::default().validate(), Ok(()));
        assert!(Settings::default().validate().is_empty());
    }

    #[test]
    fn a_missing_file_at_the_default_path_is_not_an_error() {
        let missing = ConfigFile {
            path: PathBuf::from("definitely-not-a-real-config-file.toml"),
            explicit: false,
        };

        let loaded = with_env(&[], || load(&missing)).expect("a missing file is not an error");

        assert!(!loaded.file_found);
    }

    #[test]
    fn a_missing_file_named_by_the_variable_aborts_with_the_path() {
        // A typo in DEREC_CONFIG_PATH, or a mount that did not happen, used to
        // boot on stock values while the developer believed their file was in
        // effect.
        let err = with_env(&[], || load(&explicit("/nope/derec/config.toml")))
            .expect_err("an explicitly named missing file is an error");

        let message = err.to_string();
        assert!(matches!(err, ConfigError::Missing { .. }), "{message}");
        assert!(message.contains("/nope/derec/config.toml"), "{message}");
        assert!(message.contains("DEREC_CONFIG_PATH"), "{message}");
    }

    #[test]
    fn a_directory_where_the_file_should_be_is_explained() {
        // What Docker leaves behind when a bind-mounted file is missing on
        // the host.
        let dir = std::env::temp_dir();
        let err = with_env(&[], || load(&explicit(dir.clone()))).expect_err("a directory");

        assert!(err.to_string().contains("is a directory"), "{err}");
    }

    #[test]
    fn the_config_path_variable_decides_whether_a_file_is_required() {
        let named = with_env(
            &[("DEREC_CONFIG_PATH", "/etc/derec/mine.toml")],
            ConfigFile::from_env,
        );
        assert_eq!(named, explicit("/etc/derec/mine.toml"));

        // Empty means unset — what compose produces for an undefined `${VAR}`.
        let empty = with_env(&[("DEREC_CONFIG_PATH", "  ")], ConfigFile::from_env);
        assert_eq!(
            empty,
            ConfigFile {
                path: PathBuf::from(DEFAULT_CONFIG_PATH),
                explicit: false,
            }
        );
    }

    #[test]
    fn the_shipped_example_config_parses_and_validates() {
        // The example is documentation a developer will copy verbatim; if it
        // drifts out of sync with the schema, `deny_unknown_fields` turns that
        // into a boot failure for them rather than a test failure for us.
        let loaded =
            with_env(&[], || load(&explicit(example_path()))).expect("the example must load");

        assert!(loaded.file_found);
    }

    #[test]
    fn the_shipped_example_survives_a_single_count_override() {
        // The example used to pin every participant threshold and the
        // transport breakdown, so the one-line override the docs suggest —
        // DEREC_PARTICIPANT_COUNT — refused to boot against values the
        // developer had copied, not chosen.
        for count in ["1", "4", "12"] {
            let loaded = with_env(&[("DEREC_PARTICIPANT_COUNT", count)], || {
                load(&explicit(example_path()))
            })
            .unwrap_or_else(|e| panic!("example + DEREC_PARTICIPANT_COUNT={count}: {e}"));

            let expected: u8 = count.parse().expect("test literal");
            assert_eq!(loaded.settings.defaults.participant_count, expected);
            assert_eq!(
                loaded.settings.defaults.helper_transports.total(),
                expected as usize
            );
        }
    }

    #[test]
    fn env_beats_the_file() {
        let loaded = settings_from(
            "[defaults]\nprotocol_timeout_secs = 45\n",
            &[("DEREC_PROTOCOL_TIMEOUT_SECS", "99")],
        );

        assert_eq!(loaded.settings.defaults.protocol_timeout_secs, 99);
    }

    #[test]
    fn the_file_is_used_where_the_env_is_silent() {
        let loaded = settings_from("[defaults]\nprotocol_timeout_secs = 45\n", &[]);

        assert_eq!(loaded.settings.defaults.protocol_timeout_secs, 45);
    }

    #[test]
    fn the_file_can_set_every_server_key() {
        // The image used to preset DEREC_BASE_URL, DEREC_PORT, DEREC_STATIC_DIR
        // and DEREC_DATABASE_URL as environment, which outranks the file — so a
        // mounted file could not change any of them. Its values are built-in
        // defaults now; this pins that the file layer reaches all four.
        let loaded = settings_from(
            "[server]\nbase_url = \"http://10.0.0.5\"\nport = 6000\n\
             database_url = \"/data/x.db\"\nstatic_dir = \"/srv/ui\"\n",
            &[],
        );

        let server = &loaded.settings.server;
        assert_eq!(server.base_url, "http://10.0.0.5");
        assert_eq!(server.port, 6000);
        assert_eq!(server.database_url, "/data/x.db");
        assert_eq!(server.static_dir, "/srv/ui");
        for path in [
            "server.base_url",
            "server.port",
            "server.database_url",
            "server.static_dir",
        ] {
            let origin = loaded
                .origins
                .iter()
                .find(|o| o.path == path)
                .expect("origin");
            assert_eq!(origin.source, ConfigSource::File, "{path}");
        }
    }

    #[test]
    fn an_absent_setting_falls_through_to_the_built_in_default() {
        let loaded = settings_from("", &[]);

        assert_eq!(
            loaded.settings.defaults.protocol_timeout_secs,
            Defaults::default().protocol_timeout_secs
        );
        assert_eq!(loaded.settings.server.port, 5000);
        assert_eq!(loaded.settings.server.base_url, "http://localhost");
        assert_eq!(loaded.settings.server.static_dir, DEFAULT_STATIC_DIR);
    }

    #[test]
    fn a_partial_override_still_adapts_the_rest() {
        // The whole reason there is no figment defaults layer: setting only the
        // count must clamp the thresholds around it rather than fail against
        // the stock recommendation of five.
        let loaded = settings_from("", &[("DEREC_PARTICIPANT_COUNT", "4")]);

        assert_eq!(loaded.settings.defaults.participant_count, 4);
        assert_eq!(loaded.settings.defaults.recommended_participants, 4);
        assert_eq!(loaded.settings.defaults.helper_transports.http, 4);
    }

    #[test]
    fn validation_runs_on_the_merged_result_not_on_either_layer() {
        // Each layer is fine alone: the file sums 7/0/0 against its own count of
        // 7, and the env just says 3. Together they contradict.
        let message = error_from(
            "[defaults]\nparticipant_count = 7\n\
             [defaults.helper_transports]\nhttp = 7\ngrpc = 0\nboth = 0\n",
            &[("DEREC_PARTICIPANT_COUNT", "3")],
        );

        assert!(
            message.contains("helper_transports"),
            "expected the sum check to fail, got: {message}"
        );
    }

    #[test]
    fn a_cross_layer_conflict_names_the_layer_of_each_value() {
        // "helper_transports sums to 7 but participant_count is 3" alone sends
        // the developer to the file looking for a 3 that is not there.
        let message = error_from(
            "[defaults.helper_transports]\nhttp = 7\n",
            &[("DEREC_PARTICIPANT_COUNT", "3")],
        );

        assert!(message.contains("env DEREC_PARTICIPANT_COUNT"), "{message}");
        assert!(message.contains("file test.toml"), "{message}");
        assert!(message.contains("adapt to participant_count"), "{message}");
    }

    #[test]
    fn same_port_for_http_and_grpc_is_refused_at_boot() {
        let message = error_from("", &[("DEREC_PORT", "50051")]);

        assert!(message.contains("grpc_port"), "{message}");
        assert!(message.contains("env DEREC_PORT"), "{message}");

        // Not a conflict when there is no gRPC listener.
        let loaded = settings_from(
            "",
            &[("DEREC_PORT", "50051"), ("DEREC_GRPC_ENABLED", "false")],
        );
        assert_eq!(loaded.settings.server.port, 50051);
    }

    #[test]
    fn server_settings_come_from_their_own_table() {
        let loaded = settings_from(
            "[server]\nbase_url = \"http://10.0.0.5\"\nport = 6000\n",
            &[],
        );

        assert_eq!(loaded.settings.server.base_url, "http://10.0.0.5");
        assert_eq!(loaded.settings.server.port, 6000);
    }

    #[test]
    fn public_ports_follow_the_listeners_unless_set() {
        // Unset: peers dial the ports the server listens on, as before.
        let loaded = settings_from(
            "[server]\nport = 6000\n[defaults]\ngrpc_port = 60051\n",
            &[],
        );
        assert_eq!(loaded.settings.server.public_port, 6000);
        assert_eq!(loaded.settings.server.public_grpc_port, 60051);

        // Set: `docker run -p 8080:5000 -p 8081:50051` advertises what is
        // published, not what the container listens on.
        let loaded = settings_from(
            "",
            &[
                ("DEREC_PUBLIC_PORT", "8080"),
                ("DEREC_PUBLIC_GRPC_PORT", "8081"),
            ],
        );
        assert_eq!(loaded.settings.server.port, 5000);
        assert_eq!(loaded.settings.server.public_port, 8080);
        assert_eq!(loaded.settings.server.public_grpc_port, 8081);
    }

    #[test]
    fn a_trailing_slash_on_base_url_is_dropped() {
        // Left in, every advertised URI would read `http://host/:5000/derec/…`.
        let loaded = settings_from("[server]\nbase_url = \"http://192.168.1.20/\"\n", &[]);
        assert_eq!(loaded.settings.server.base_url, "http://192.168.1.20");
    }

    #[test]
    fn the_scheme_and_host_of_base_url_are_lowercased() {
        // `HTTP://LOCALHOST` used to boot and then fail every provisioning
        // call: the SDK matched transport URIs on a lowercase scheme.
        let loaded = settings_from("", &[("DEREC_BASE_URL", "HTTP://LocalHost/")]);
        assert_eq!(loaded.settings.server.base_url, "http://localhost");

        let loaded = settings_from("", &[("DEREC_BASE_URL", "Https://[::1]")]);
        assert_eq!(loaded.settings.server.base_url, "https://[::1]");
    }

    #[test]
    fn a_base_url_with_credentials_is_refused_at_boot() {
        for bad in ["http://user@host", "http://user:secret@host"] {
            let message = error_from("", &[("DEREC_BASE_URL", bad)]);
            assert!(
                message.contains("user name or password"),
                "{bad:?} should be refused for its credentials, got: {message}"
            );
        }
    }

    #[test]
    fn normalizing_leaves_what_validation_must_refuse_for_it_to_refuse() {
        assert_eq!(normalize_base_url("  192.168.1.20/ "), "192.168.1.20");
        assert_eq!(normalize_base_url("FTP://Host"), "ftp://host");
    }

    #[test]
    fn a_base_url_that_cannot_take_a_port_is_refused_at_boot() {
        // Each of these used to boot and advertise an address nothing can dial,
        // e.g. `http://host:8080:5000/derec/…`.
        for (bad, hint) in [
            ("http://192.168.1.20:8080", "public_port"),
            ("http://host/path", "no path"),
            ("192.168.1.20", "scheme and host"),
            ("ftp://host", "http:// or https://"),
            // The URL parser drops a default or empty port and an empty user
            // name, and repairs a missing slash, so each of these used to pass
            // and advertise e.g. `http://host:80:5600/derec/…`.
            ("http://host:80", "public_port"),
            ("https://host:443", "public_port"),
            ("http://host:", "public_port"),
            ("http://[::1]:80", "public_port"),
            ("http://@host", "user name or password"),
            ("http://:@host", "user name or password"),
            ("http:/host", "scheme and host"),
            ("http:host", "scheme and host"),
            ("http://host?x=1", "no path"),
            ("http://host#frag", "no path"),
            ("http:///host", "no path"),
        ] {
            let message = error_from("", &[("DEREC_BASE_URL", bad)]);
            assert!(
                message.contains(hint),
                "{bad:?} should be refused naming {hint:?}, got: {message}"
            );
        }
    }

    #[test]
    fn a_loopback_base_url_warning_says_what_cannot_reach_it() {
        assert_eq!(
            loopback_base_url_warning("http://192.168.0.28:5000", false),
            None
        );
        assert_eq!(loopback_base_url_warning("http://node-a:5000", true), None);

        for base in [
            "http://localhost:5000",
            "http://127.0.0.1:5000",
            "http://[::1]:5000",
        ] {
            let native = loopback_base_url_warning(base, false).expect("loopback warns");
            assert!(native.contains("another device"), "{native}");
            assert!(native.contains("in a container"), "{native}");

            // In a container the claim "reachable from this machine" is false
            // for every other container — the two-node Docker case.
            let docker = loopback_base_url_warning(base, true).expect("loopback warns");
            assert!(docker.contains("any other container"), "{docker}");
            assert!(docker.contains("DEREC_PUBLIC_PORT"), "{docker}");
            assert!(!docker.contains("only from this machine"), "{docker}");
        }
    }

    #[test]
    fn a_bracketed_ipv6_base_url_without_a_port_is_accepted() {
        // Its own colons are not a port.
        let loaded = settings_from("", &[("DEREC_BASE_URL", "http://[fe80::1]")]);
        assert_eq!(loaded.settings.server.base_url, "http://[fe80::1]");
    }

    // ── Relay allowlist ──────────────────────────────────────────────────────

    #[test]
    fn the_relay_allowlist_is_empty_by_default_and_allows_no_other_node() {
        let loaded = settings_from("", &[]);
        let allowlist = loaded.settings.server.relay_allowlist();

        assert_eq!(allowlist, RelayAllowlist::None);
        assert!(!allowlist.allows("192.168.0.30", 50051));
    }

    #[test]
    fn the_relay_allowlist_takes_hosts_and_host_ports_from_file_or_env() {
        let loaded = settings_from(
            "[server]\nrelay_allowed_hosts = \"node-b:50051, 192.168.0.30\"\n",
            &[],
        );
        let allowlist = loaded.settings.server.relay_allowlist();
        assert!(allowlist.allows("node-b", 50051));
        assert!(!allowlist.allows("node-b", 50052), "the port was pinned");
        assert!(
            allowlist.allows("192.168.0.30", 1),
            "no port means any port"
        );
        assert!(!allowlist.allows("192.168.0.31", 50051));

        let loaded = settings_from("", &[("DEREC_RELAY_ALLOWED_HOSTS", "NODE-B [::1]:9")]);
        let allowlist = loaded.settings.server.relay_allowlist();
        assert!(allowlist.allows("node-b", 7), "hosts compare lowercased");
        assert!(allowlist.allows("[::1]", 9));
        let origin = loaded
            .origins
            .iter()
            .find(|o| o.path == "server.relay_allowed_hosts")
            .expect("origin recorded");
        assert_eq!(
            origin.source,
            ConfigSource::Env("DEREC_RELAY_ALLOWED_HOSTS")
        );
    }

    #[test]
    fn a_star_allows_any_host_but_only_on_its_own() {
        let loaded = settings_from("", &[("DEREC_RELAY_ALLOWED_HOSTS", "*")]);
        assert_eq!(
            loaded.settings.server.relay_allowlist(),
            RelayAllowlist::Any
        );

        let message = error_from("", &[("DEREC_RELAY_ALLOWED_HOSTS", "*, node-b")]);
        assert!(message.contains("relay_allowed_hosts"), "{message}");
    }

    #[test]
    fn a_relay_allowlist_entry_that_is_not_a_host_is_refused_at_boot() {
        for bad in [
            "grpc://node-b:50051",
            "node-b/x",
            "user@node-b",
            "node-b:",
            "node-b:99999",
        ] {
            let message = error_from("", &[("DEREC_RELAY_ALLOWED_HOSTS", bad)]);
            assert!(
                message.contains("relay_allowed_hosts")
                    && message.contains("env DEREC_RELAY_ALLOWED_HOSTS"),
                "{bad:?}: {message}"
            );
        }
    }

    #[test]
    fn booleans_and_numbers_survive_the_environment() {
        let loaded = settings_from(
            "",
            &[
                ("DEREC_GRPC_ENABLED", "false"),
                ("DEREC_GRPC_PORT", "60051"),
                ("DEREC_AUTHENTICATION_METHOD", "user"),
                ("DEREC_PARTICIPANT_COUNT", "2"),
                ("DEREC_HELPER_TRANSPORTS_HTTP", "2"),
            ],
        );

        assert!(!loaded.settings.defaults.grpc_enabled);
        assert_eq!(loaded.settings.defaults.grpc_port, 60051);
        assert_eq!(
            loaded.settings.defaults.authentication_method,
            AuthenticationMethod::User
        );
    }

    #[test]
    fn text_settings_keep_values_that_look_like_numbers_or_booleans() {
        // Coercion used to guess from the text, so these arrived as a number
        // and a boolean and were rejected as the wrong type.
        let loaded = settings_from(
            "",
            &[("DEREC_STATIC_DIR", "2024"), ("DEREC_DATABASE_URL", "123")],
        );
        assert_eq!(loaded.settings.server.static_dir, "2024");
        assert_eq!(loaded.settings.server.database_url, "123");

        // `true` is still not a URL, but the refusal is about the URL, not a
        // type the developer never chose.
        let message = error_from("", &[("DEREC_BASE_URL", "true")]);
        assert!(
            message.contains("base_url must be a scheme and host"),
            "{message}"
        );
        assert!(message.contains("env DEREC_BASE_URL"), "{message}");
        assert!(!message.contains("invalid type"), "{message}");
    }

    #[test]
    fn environment_values_are_trimmed_and_booleans_are_case_insensitive() {
        let loaded = settings_from(
            "",
            &[
                ("DEREC_PORT", " 6000 "),
                ("DEREC_GRPC_ENABLED", "FALSE"),
                ("DEREC_GRPC_RELAY_ENABLED", "No"),
                ("DEREC_AUTO_ACCEPT_STORE_SHARE_REQUESTS", "1"),
                ("DEREC_BASE_URL", " http://10.0.0.5 "),
            ],
        );

        assert_eq!(loaded.settings.server.port, 6000);
        assert!(!loaded.settings.defaults.grpc_enabled);
        assert!(!loaded.settings.defaults.grpc_relay_enabled);
        assert!(loaded.settings.defaults.auto_accept_store_share_requests);
        assert_eq!(loaded.settings.server.base_url, "http://10.0.0.5");
    }

    #[test]
    fn an_unparsable_environment_value_names_the_variable_not_the_figment_key() {
        for (variable, value) in [
            ("DEREC_PORT", "abc"),
            ("DEREC_PORT", "70000"),
            ("DEREC_PARTICIPANT_COUNT", "300"),
            ("DEREC_GRPC_ENABLED", "maybe"),
        ] {
            let message = error_from("", &[(variable, value)]);
            assert!(message.contains(variable), "{variable}={value}: {message}");
            assert!(
                !message.contains("default."),
                "{variable}={value}: {message}"
            );
            assert!(
                !message.contains("config.toml"),
                "{variable}={value}: {message}"
            );
        }
    }

    #[test]
    fn an_unknown_enum_value_from_the_environment_names_the_variable() {
        let message = error_from("", &[("DEREC_UNPAIR_ACK", "sometimes")]);

        assert!(message.contains("env DEREC_UNPAIR_ACK"), "{message}");
        assert!(message.contains("unpair_ack"), "{message}");
        assert!(!message.contains("default."), "{message}");
    }

    #[test]
    fn a_wrong_type_in_the_file_names_the_file_and_the_plain_key() {
        let message = error_from("[server]\nport = \"five thousand\"\n", &[]);

        assert!(message.contains("server.port"), "{message}");
        assert!(message.contains("file test.toml"), "{message}");
        assert!(!message.contains("default."), "{message}");
    }

    #[test]
    fn an_empty_environment_value_counts_as_unset() {
        // What compose produces for `DEREC_PORT: ${PORT}` with PORT undefined.
        let loaded = settings_from("[server]\nport = 6000\n", &[("DEREC_PORT", "")]);

        assert_eq!(loaded.settings.server.port, 6000);
        assert_eq!(loaded.empty_env, vec!["DEREC_PORT"]);
        let banner = report(&loaded, Path::new("config.toml"));
        assert!(banner.contains("DEREC_PORT is set but empty"), "{banner}");
    }

    #[test]
    fn a_misspelled_file_key_is_rejected_rather_than_ignored() {
        // `deny_unknown_fields` exists so a typo fails loudly. Silently ignoring
        // it would leave the developer staring at a value they thought they set.
        let message = error_from("[defaults]\nprotocol_timeout_sec = 45\n", &[]);

        assert!(
            message.contains("protocol_timeout_sec"),
            "the error must name the offending key, got: {message}"
        );
        assert!(message.contains("file test.toml"), "{message}");
    }

    #[test]
    fn an_unknown_env_variable_warns_rather_than_aborting() {
        let loaded = settings_from("", &[("DEREC_PARTICIPNT_COUNT", "4")]);

        assert_eq!(
            loaded.unknown_env,
            vec!["DEREC_PARTICIPNT_COUNT".to_owned()]
        );
        assert_eq!(
            loaded.settings.defaults.participant_count,
            Defaults::default().participant_count
        );
    }

    #[test]
    fn reserved_variables_are_not_treated_as_config_keys() {
        let loaded = settings_from(
            "",
            &[
                ("DEREC_CONFIG_PATH", "/etc/derec/config.toml"),
                ("DEREC_DATA_DIR", "/data"),
            ],
        );

        assert!(
            loaded.unknown_env.is_empty(),
            "got {:?}",
            loaded.unknown_env
        );
    }

    #[test]
    fn the_env_namespace_has_no_collisions() {
        let mut names = HashSet::new();
        let mut paths = HashSet::new();

        for key in ENV_KEYS {
            assert!(
                names.insert(key.variable),
                "duplicate variable name: {}",
                key.variable
            );
            assert!(
                paths.insert(key.path),
                "duplicate config path: {}",
                key.path
            );
            assert!(
                key.variable.starts_with(ENV_PREFIX),
                "{} is missing the {ENV_PREFIX} prefix",
                key.variable
            );
            assert!(
                !RESERVED_ENV.contains(&key.variable),
                "{} is both a config key and reserved",
                key.variable
            );
        }
    }

    #[test]
    fn origins_report_where_each_value_actually_came_from() {
        let loaded = settings_from(
            "[defaults]\nunpair_ack = \"required\"\n",
            &[
                ("DEREC_PARTICIPANT_COUNT", "3"),
                ("DEREC_HELPER_TRANSPORTS_HTTP", "3"),
            ],
        );

        let origin = |path: &str| {
            loaded
                .origins
                .iter()
                .find(|o| o.path == path)
                .unwrap_or_else(|| panic!("no origin recorded for {path}"))
                .source
                .clone()
        };

        assert_eq!(
            origin("defaults.participant_count"),
            ConfigSource::Env("DEREC_PARTICIPANT_COUNT")
        );
        assert_eq!(origin("defaults.unpair_ack"), ConfigSource::File);
        assert_eq!(
            origin("defaults.protocol_timeout_secs"),
            ConfigSource::Default
        );
        assert_eq!(origin("server.port"), ConfigSource::Default);
    }

    #[test]
    fn a_file_value_equal_to_the_default_still_reports_as_file() {
        // The developer editing that line needs to see it took effect.
        let loaded = settings_from("[defaults]\nprotocol_timeout_secs = 300\n", &[]);

        let origin = loaded
            .origins
            .iter()
            .find(|o| o.path == "defaults.protocol_timeout_secs")
            .expect("origin recorded");

        assert_eq!(origin.source, ConfigSource::File);
    }

    #[test]
    fn every_config_path_gets_an_origin() {
        let loaded = settings_from("", &[]);
        let reported: HashSet<&str> = loaded.origins.iter().map(|o| o.path).collect();

        for key in ENV_KEYS {
            assert!(reported.contains(key.path), "{} has no origin", key.path);
        }
        assert_eq!(reported.len(), ENV_KEYS.len());
    }

    #[test]
    fn legacy_unprefixed_names_are_detected() {
        let found = with_env(&[("BASE_URL", "http://10.0.0.5")], legacy_env_in_use);
        assert_eq!(found, vec![("BASE_URL", "DEREC_BASE_URL")]);

        // Documented as aborting boot, and used to be silently ignored.
        let found = with_env(&[("STATIC_DIR", "/app/static")], legacy_env_in_use);
        assert_eq!(found, vec![("STATIC_DIR", "DEREC_STATIC_DIR")]);
    }

    #[test]
    fn the_database_url_comes_through_the_same_ladder_as_everything_else() {
        let loaded = settings_from(
            "[server]\ndatabase_url = \"./from-file.db\"\n",
            &[("DEREC_DATABASE_URL", "postgres://db/derec")],
        );

        assert_eq!(loaded.settings.server.database_url, "postgres://db/derec");

        let origin = loaded
            .origins
            .iter()
            .find(|o| o.path == "server.database_url")
            .expect("database_url has an origin");
        assert_eq!(origin.source, ConfigSource::Env("DEREC_DATABASE_URL"));
    }

    #[test]
    fn an_unset_database_url_is_the_built_in_default() {
        let loaded = settings_from("", &[]);

        assert_eq!(
            loaded.settings.server.database_url,
            crate::models::DEFAULT_DATABASE_URL
        );
    }

    #[test]
    fn a_database_url_from_the_file_is_used_and_reported_as_file() {
        let loaded = settings_from("[server]\ndatabase_url = \"sqlite::memory:\"\n", &[]);

        assert_eq!(loaded.settings.server.database_url, "sqlite::memory:");
        assert_eq!(
            loaded
                .origins
                .iter()
                .find(|o| o.path == "server.database_url")
                .expect("origin")
                .source,
            ConfigSource::File
        );
    }

    #[test]
    fn a_legacy_name_is_ignored_once_its_replacement_is_set() {
        let found = with_env(
            &[("BASE_URL", "http://old"), ("DEREC_BASE_URL", "http://new")],
            legacy_env_in_use,
        );

        assert!(found.is_empty(), "got {found:?}");
    }

    #[test]
    fn the_banner_lists_every_setting_with_its_origin() {
        let loaded = settings_from(
            "[defaults]\nunpair_ack = \"not_required\"\n",
            &[
                ("DEREC_PARTICIPANT_COUNT", "3"),
                ("DEREC_HELPER_TRANSPORTS_HTTP", "3"),
            ],
        );

        let banner = report(&loaded, Path::new("/etc/derec/config.toml"));

        // An overridden value names the variable that won.
        assert!(
            banner.contains("participant_count") && banner.contains("DEREC_PARTICIPANT_COUNT"),
            "{banner}"
        );
        // A file value reports the file.
        assert!(
            banner.contains("unpair_ack") && banner.contains("not_required"),
            "{banner}"
        );
        // An untouched value is still listed, marked default — that is the
        // whole diagnostic: "I set it and nothing happened" looks like this.
        assert!(banner.contains("protocol_timeout_secs"), "{banner}");
        assert!(banner.contains("default"), "{banner}");
    }

    #[test]
    fn the_banner_never_prints_a_database_password() {
        let loaded = settings_from(
            "",
            &[(
                "DEREC_DATABASE_URL",
                "postgres://derec:hunter2@db:5432/derec",
            )],
        );

        let banner = report(&loaded, Path::new("config.toml"));
        assert!(!banner.contains("hunter2"), "{banner}");
        assert!(
            banner.contains("postgres://derec:***@db:5432/derec"),
            "{banner}"
        );
    }

    #[test]
    fn the_banner_says_whether_a_file_was_found() {
        let missing = with_env(&[], || {
            Settings::merge(Path::new("/nope/config.toml"), None).expect("loads")
        });

        let banner = report(&missing, Path::new("/nope/config.toml"));
        assert!(banner.contains("not found"), "{banner}");
        assert!(banner.contains("/nope/config.toml"), "{banner}");
    }

    #[test]
    fn the_banner_reports_unknown_variables() {
        let loaded = settings_from("", &[("DEREC_NOT_A_KEY", "1")]);
        let banner = report(&loaded, Path::new("config.toml"));

        assert!(banner.contains("DEREC_NOT_A_KEY"), "{banner}");
    }

    #[test]
    fn the_banner_is_stable_across_runs() {
        let a = settings_from(
            "",
            &[
                ("DEREC_PARTICIPANT_COUNT", "3"),
                ("DEREC_HELPER_TRANSPORTS_HTTP", "3"),
            ],
        );
        let b = settings_from(
            "",
            &[
                ("DEREC_HELPER_TRANSPORTS_HTTP", "3"),
                ("DEREC_PARTICIPANT_COUNT", "3"),
            ],
        );

        assert_eq!(
            report(&a, Path::new("config.toml")),
            report(&b, Path::new("config.toml")),
            "two logs of the same configuration must be diffable"
        );
    }
}
