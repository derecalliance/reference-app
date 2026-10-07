// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! What this node was configured with, as plain data: the settings, where each
//! came from, the database URL they name, and the views of them the front end
//! and the debug surface are served.
//!
//! The values only: how they are read — the TOML file, the `DEREC_*`
//! environment, validation, the boot report and the built-in defaults — is
//! [`crate::infrastructure::config`]'s business. Services read these types and
//! never that module, so the dependency points from the rules to the data and
//! not to the loader.

use std::fmt;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::{AuthenticationMethod, TransportBreakdown, UnpairAck};

/// What this node runs as: the configuration it loaded, plus the address it
/// advertises to peers.
///
/// Read once at boot and never mutated. Every service that mints addresses or
/// enforces a node setting holds it, rather than each reading the process
/// environment.
#[derive(Debug, Clone)]
pub struct NodeConfig {
    /// Scheme, host and *public* HTTP port — the prefix of every HTTP URI this
    /// node advertises. Not necessarily where it listens; see
    /// [`ServerSettings::public_port`].
    pub base_url: Arc<str>,
    /// The gRPC port advertised to peers. `defaults.grpc_port` unless the node
    /// is published on a different one; see [`ServerSettings::public_grpc_port`].
    pub public_grpc_port: u16,
    /// Operator-supplied starting values for the front end, and the gRPC keys
    /// this process enforces. Served by `GET /api/v1/config`.
    pub defaults: Defaults,
    /// What this node was configured with and where each value came from.
    /// Served by `GET /api/v1/debug/config`. All built-in defaults for a node built
    /// without a configuration pass, as test fixtures are.
    pub loaded: LoadedConfig,
}

impl NodeConfig {
    /// A node at `base_url` with `defaults`, advertising gRPC on the
    /// listener's own port, with no configuration pass behind it.
    pub fn new(base_url: impl Into<Arc<str>>, defaults: Defaults) -> Self {
        Self {
            base_url: base_url.into(),
            public_grpc_port: defaults.grpc_port,
            defaults,
            loaded: LoadedConfig::default(),
        }
    }

    /// Attach the configuration this node actually booted with.
    pub fn with_loaded(mut self, loaded: LoadedConfig) -> Self {
        self.loaded = loaded;
        self
    }

    /// Advertise `port` for gRPC instead of the listener's own.
    pub fn with_public_grpc_port(mut self, port: u16) -> Self {
        self.public_grpc_port = port;
        self
    }

    /// Host and port peers dial for gRPC, derived from `base_url`'s host and
    /// the public gRPC port so a LAN `base_url` produces a LAN gRPC endpoint
    /// rather than an unreachable `localhost` one.
    ///
    /// Handles a bracketed IPv6 literal (`[::1]:5000`) as one unit: naively
    /// splitting the authority on `:` would cut a `[::1]` host apart at its
    /// first colon and produce `grpc://[:50051`, which nothing can dial.
    pub fn grpc_authority(&self) -> String {
        let host = self
            .base_url
            .split("://")
            .nth(1)
            .and_then(|rest| rest.split('/').next())
            .map(host_from_authority)
            .unwrap_or_else(|| "localhost".to_owned());
        format!("{host}:{}", self.public_grpc_port)
    }
}

/// The host portion of a `host:port` or bracketed `[host]:port` authority.
///
/// A bracketed IPv6 literal is kept whole rather than split at its first
/// colon, which would otherwise land on one of the address's own colons
/// instead of the port separator.
fn host_from_authority(authority: &str) -> String {
    if let Some(rest) = authority.strip_prefix('[') {
        if let Some(host) = rest.split(']').next() {
            return format!("[{host}]");
        }
    }
    authority
        .split(':')
        .next()
        .unwrap_or("localhost")
        .to_owned()
}

/// Everything the node was configured with.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Settings {
    pub server: ServerSettings,
    pub defaults: Defaults,
}

/// How this node runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ServerSettings {
    /// Stamped into every transport URI handed to a peer. The port is appended,
    /// so this is a scheme and host with no port of its own.
    pub base_url: String,
    /// The HTTP listener port.
    pub port: u16,
    /// The HTTP port peers are told to dial — appended to `base_url` in every
    /// advertised URI. The listener port unless set: they differ whenever
    /// something in between remaps it, such as `docker run -p 8080:5000`,
    /// where peers must dial 8080 while the server listens on 5000.
    pub public_port: u16,
    /// The gRPC port peers are told to dial; `defaults.grpc_port` unless set,
    /// for the same reason as `public_port`.
    pub public_grpc_port: u16,
    /// Where state lives. See [`crate::models::DatabaseUrl`] for the accepted
    /// spellings — a bare path means SQLite, anything with a scheme is passed
    /// through, and `sqlite::memory:` asks for a node that forgets on exit.
    pub database_url: String,
    /// Directory of built front-end assets to serve.
    ///
    /// Empty serves no UI, which is what a `cargo run` beside a Vite dev server
    /// wants — Vite is serving the app, and a fallback here would shadow it.
    /// The image's built-in default is `/app/static`.
    pub static_dir: String,
    /// Other nodes `POST /derec/relay` may dial, as written: a comma-separated
    /// list of `host` or `host:port` entries, or `*` for any. Empty — the
    /// default — lets the relay reach only this node. Read it through
    /// [`ServerSettings::relay_allowlist`].
    pub relay_allowed_hosts: String,
}

impl ServerSettings {
    /// The relay's allowlist for other nodes, parsed.
    ///
    /// Infallible on a validated configuration; a value that does not parse —
    /// reachable only by building `ServerSettings` by hand — allows nothing,
    /// the safe reading of an allowlist.
    pub fn relay_allowlist(&self) -> RelayAllowlist {
        RelayAllowlist::parse(&self.relay_allowed_hosts).unwrap_or_default()
    }
}

/// Which other nodes the relay may dial on a browser owner's behalf.
///
/// The relay exists so a browser can reach a gRPC peer it cannot dial itself.
/// Without a limit it would be a general-purpose proxy on a node that is, by
/// design, unauthenticated — so other nodes are refused unless the operator
/// names them. `Any` is there for a trusted LAN where interop peers come and
/// go faster than a list can be kept; it is an explicit `*`, never a default,
/// and boot warns while it is on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum RelayAllowlist {
    /// Only the listed hosts. Empty — the default — allows no other node.
    #[default]
    None,
    Hosts(Vec<AllowedHost>),
    Any,
}

/// One `host` or `host:port` entry. Hosts are compared lowercased; an IPv6
/// literal is written in brackets, as in a URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowedHost {
    pub host: String,
    /// `None` allows every port on the host.
    pub port: Option<u16>,
}

impl RelayAllowlist {
    /// Parse the setting: entries separated by commas or whitespace.
    pub fn parse(raw: &str) -> Result<Self, String> {
        let entries: Vec<&str> = raw
            .split(|c: char| c == ',' || c.is_whitespace())
            .filter(|entry| !entry.is_empty())
            .collect();
        if entries.is_empty() {
            return Ok(Self::None);
        }
        if entries.contains(&"*") {
            if entries.len() > 1 {
                return Err(format!(
                    "relay_allowed_hosts mixes \"*\" with specific hosts (got {raw:?}); \
                     use \"*\" alone to allow any host, or list the hosts"
                ));
            }
            return Ok(Self::Any);
        }
        entries
            .into_iter()
            .map(AllowedHost::parse)
            .collect::<Result<Vec<_>, _>>()
            .map(Self::Hosts)
    }

    /// Whether `host` (lowercased, IPv6 in brackets) on `port` may be dialled.
    pub fn allows(&self, host: &str, port: u16) -> bool {
        match self {
            Self::None => false,
            Self::Any => true,
            Self::Hosts(hosts) => hosts
                .iter()
                .any(|allowed| allowed.host == host && allowed.port.is_none_or(|p| p == port)),
        }
    }
}

impl AllowedHost {
    fn parse(entry: &str) -> Result<Self, String> {
        let refuse = || {
            format!(
                "relay_allowed_hosts entries are a host or host:port, like 192.168.0.30 or \
                 node-b:50051 — no scheme, path or user name (got {entry:?})"
            )
        };
        if entry.contains("://") || entry.contains('/') || entry.contains('@') {
            return Err(refuse());
        }
        // Parsed as a URL authority so an entry means exactly what the same
        // text means in the endpoint being checked against it.
        let url = reqwest::Url::parse(&format!("grpc://{entry}")).map_err(|_| refuse())?;
        let host = url
            .host_str()
            .filter(|h| !h.is_empty())
            .ok_or_else(refuse)?;
        let port = url.port();
        // `host:` parses with no port; it is a typo, not "any port".
        if port.is_none() && entry.trim_end_matches(']').ends_with(':') {
            return Err(refuse());
        }
        Ok(Self {
            host: host.to_ascii_lowercase(),
            port,
        })
    }
}

/// Starting values for the front-end setup wizard, plus the three gRPC keys
/// this process enforces itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct Defaults {
    /// Participants to provision when setting up.
    pub participant_count: u8,
    /// How many of those to auto-pair, skipping the QR exchange. Testing aid.
    pub pre_paired_count: u8,
    /// Paired participants required before secret protection is allowed.
    pub min_participants: u8,
    /// Paired participants below which the UI warns.
    pub recommended_participants: u8,
    /// General protocol timeout, in seconds.
    pub protocol_timeout_secs: u32,
    /// How the app decides two pairing channels belong to the same user.
    pub authentication_method: AuthenticationMethod,
    /// Protocol-level unpair acknowledgement policy.
    pub unpair_ack: UnpairAck,
    /// Whether incoming unpair requests are accepted without a prompt.
    pub auto_accept_unpair_requests: bool,
    /// Whether a browser helper stores an incoming share without a prompt.
    pub auto_accept_store_share_requests: bool,
    /// Whether a browser helper answers a verification request without a prompt.
    pub auto_accept_verify_share_requests: bool,
    /// Whether to run the gRPC ingress listener at all. Enforced by the node.
    pub grpc_enabled: bool,
    /// Port for the gRPC listener. Enforced by the node.
    pub grpc_port: u16,
    /// Prefills the wizard's transport breakdown. Sums to `participant_count`.
    pub helper_transports: TransportBreakdown,
    /// Whether the backend dials gRPC on a browser owner's behalf. Enforced by
    /// the node.
    pub grpc_relay_enabled: bool,
}

impl Default for Defaults {
    fn default() -> Self {
        Self {
            participant_count: 7,
            pre_paired_count: 3,
            min_participants: 3,
            recommended_participants: 5,
            protocol_timeout_secs: 300,
            authentication_method: AuthenticationMethod::default(),
            unpair_ack: UnpairAck::default(),
            auto_accept_unpair_requests: true,
            auto_accept_store_share_requests: false,
            auto_accept_verify_share_requests: false,
            grpc_enabled: true,
            grpc_port: 50051,
            helper_transports: TransportBreakdown {
                http: 7,
                grpc: 0,
                both: 0,
            },
            grpc_relay_enabled: true,
        }
    }
}

/// Where the database lives when nothing says otherwise.
///
/// `derec.db`, relative, so `cargo run` works in a fresh checkout with no
/// configuration — the primary way this repo is developed, and the e2e harness
/// starts the backend exactly that way.
///
/// The image compiles in `/var/lib/derec/derec.db` instead, through
/// `DEREC_BUILTIN_DATABASE_URL` in its build stage, so an unconfigured
/// `docker run` writes under the `VOLUME` and survives a restart. A built-in
/// default rather than an `ENV` preset because an environment variable
/// outranks the config file, and a mounted file must be able to move the
/// database too.
pub const DEFAULT_DATABASE_URL: &str = match option_env!("DEREC_BUILTIN_DATABASE_URL") {
    Some(url) => url,
    None => "derec.db",
};

/// An operator-supplied `database_url`, resolved to the connection string it
/// names.
///
/// | Setting | Connection string |
/// | --- | --- |
/// | empty | the default, resolved as a bare path |
/// | `sqlite::memory:` | passed through — an explicitly ephemeral node |
/// | contains `://` | passed through untouched |
/// | anything else | a bare path; `sqlite://<path>?mode=rwc` |
///
/// `mode=rwc` is on the derived form only. A URL the operator spelled out is
/// theirs, including the absence of a mode.
///
/// [`Display`](fmt::Display) shows the redacted form, so a value logged by
/// accident never carries a password; [`Self::as_str`] is the real string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatabaseUrl(String);

impl DatabaseUrl {
    /// The connection string, credentials included.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether this names an in-memory SQLite database, so the node keeps
    /// nothing across a restart.
    ///
    /// Both spellings count: the bare `sqlite::memory:` and the `mode=memory`
    /// query parameter a tuned URL may use instead. The boot banner warns about
    /// it and `GET /api/v1/config` reports it, so the front end can say so on
    /// screen rather than letting a developer discover it by losing a vault.
    pub fn is_ephemeral(&self) -> bool {
        self.0.contains(":memory:") || self.0.contains("mode=memory")
    }

    /// Replace the password in a URL's credentials with `***` — for a setting
    /// as written, before it is resolved.
    ///
    /// Hand-written rather than via a URL parser: this runs on a value that may
    /// be malformed — that is often *why* it is being logged — and a parser
    /// that rejects the input would suppress the line that explains the
    /// failure.
    ///
    /// Only the section between `://` and the first `@` is considered, so a
    /// colon in a host, port, path or query is untouched.
    pub fn redact(url: &str) -> String {
        let Some((scheme, rest)) = url.split_once("://") else {
            return url.to_owned();
        };
        let Some((credentials, host)) = rest.split_once('@') else {
            return url.to_owned();
        };
        let Some((user, _password)) = credentials.split_once(':') else {
            return url.to_owned();
        };
        format!("{scheme}://{user}:***@{host}")
    }
}

impl From<&str> for DatabaseUrl {
    fn from(raw: &str) -> Self {
        let trimmed = raw.trim();

        if trimmed.is_empty() {
            return Self::from(DEFAULT_DATABASE_URL);
        }
        // Checked before `://` so the in-memory spelling, which has no
        // authority component, is not mistaken for a bare path.
        if trimmed.starts_with("sqlite:") || trimmed.contains("://") {
            return Self(trimmed.to_owned());
        }
        Self(format!("sqlite://{trimmed}?mode=rwc"))
    }
}

impl From<DatabaseUrl> for String {
    fn from(url: DatabaseUrl) -> Self {
        url.0
    }
}

impl fmt::Display for DatabaseUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&Self::redact(&self.0))
    }
}

/// The result of loading configuration: the values, and how they got there.
#[derive(Debug, Clone)]
pub struct LoadedConfig {
    pub settings: Settings,
    pub origins: Vec<ConfigOrigin>,
    /// Whether a config file was actually read.
    pub file_found: bool,
    /// `DEREC_*` variables that match no known key. Warned about, not fatal.
    pub unknown_env: Vec<String>,
    /// Known variables that were set to an empty value and so ignored.
    pub empty_env: Vec<&'static str>,
}

/// Where a value came from. `Env` carries the variable that supplied it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigSource {
    Default,
    File,
    Env(&'static str),
}

/// One setting's provenance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigOrigin {
    pub path: &'static str,
    pub source: ConfigSource,
}

// Written by hand rather than derived: `ConfigSource` is an enum with a payload on
// one variant only, and the wire shape wanted here is a flat
// `{path, source, variable?}`. `#[serde(flatten)]` over a tagged enum is the
// one serde combination that does not reliably produce that.
impl Serialize for ConfigOrigin {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;

        let fields = if matches!(self.source, ConfigSource::Env(_)) {
            3
        } else {
            2
        };
        let mut out = serializer.serialize_struct("Origin", fields)?;
        out.serialize_field("path", self.path)?;
        match self.source {
            ConfigSource::Default => out.serialize_field("source", "default")?,
            ConfigSource::File => out.serialize_field("source", "file")?,
            ConfigSource::Env(variable) => {
                out.serialize_field("source", "env")?;
                out.serialize_field("variable", variable)?;
            }
        }
        out.end()
    }
}

/// The operator's defaults, plus the facts about this node the front end
/// cannot work out for itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontendConfig {
    pub defaults: Defaults,
    /// True when this node's database is in-memory, so everything is lost when
    /// the process stops.
    ///
    /// Derived from the resolved database URL rather than stored in
    /// `Defaults`: it is not something an operator sets, it is a consequence of
    /// what they set.
    pub database_ephemeral: bool,
}

impl From<&NodeConfig> for FrontendConfig {
    fn from(config: &NodeConfig) -> Self {
        let database_url = config.loaded.settings.server.database_url.as_str();
        Self {
            defaults: config.defaults.clone(),
            database_ephemeral: DatabaseUrl::from(database_url).is_ephemeral(),
        }
    }
}

/// The resolved configuration and where each value came from — the same data
/// the boot banner renders — with the database URL redacted: a Postgres URL
/// carries its password, and the debug surface is unauthenticated.
#[derive(Debug, Clone)]
pub struct ResolvedConfig {
    pub settings: Settings,
    pub origins: Vec<ConfigOrigin>,
    pub file_found: bool,
    pub unknown_env: Vec<String>,
    pub empty_env: Vec<&'static str>,
}

impl From<&LoadedConfig> for ResolvedConfig {
    fn from(loaded: &LoadedConfig) -> Self {
        let mut settings = loaded.settings.clone();
        settings.server.database_url = DatabaseUrl::redact(&settings.server.database_url);

        Self {
            settings,
            origins: loaded.origins.clone(),
            file_found: loaded.file_found,
            unknown_env: loaded.unknown_env.clone(),
            empty_env: loaded.empty_env.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // This exists so a LAN `base_url` yields a reachable gRPC endpoint rather
    // than an unreachable `localhost` one — an IPv6 `base_url` must get the
    // same treatment.

    #[test]
    fn grpc_authority_combines_the_base_url_host_with_the_configured_port() {
        let config = NodeConfig::new("http://192.168.0.28:5000", Defaults::default());

        assert_eq!(config.grpc_authority(), "192.168.0.28:50051");
    }

    #[test]
    fn grpc_authority_keeps_a_bracketed_ipv6_host_whole() {
        // Naively splitting the authority on its first `:` lands inside the
        // address itself (`[`) and produces `grpc://[:50051`, which nothing
        // can dial.
        let config = NodeConfig::new("http://[::1]:5000", Defaults::default());

        assert_eq!(config.grpc_authority(), "[::1]:50051");
    }

    #[test]
    fn grpc_authority_advertises_the_public_port_when_one_is_set() {
        let config = NodeConfig::new("http://localhost:5000", Defaults::default())
            .with_public_grpc_port(8081);

        assert_eq!(config.grpc_authority(), "localhost:8081");
    }

    #[test]
    fn host_from_authority_strips_the_port_from_a_plain_host() {
        assert_eq!(host_from_authority("example.com:5000"), "example.com");
    }

    #[test]
    fn host_from_authority_keeps_brackets_around_an_ipv6_literal() {
        assert_eq!(host_from_authority("[2001:db8::1]:5000"), "[2001:db8::1]");
    }

    fn resolve(raw: &str) -> String {
        DatabaseUrl::from(raw).into()
    }

    fn is_ephemeral(raw: &str) -> bool {
        DatabaseUrl::from(raw).is_ephemeral()
    }

    #[test]
    fn a_bare_path_becomes_a_sqlite_url_that_may_create_the_file() {
        // `mode=rwc` is the difference between a fresh container booting and a
        // fresh container failing on a database nobody has created yet.
        assert_eq!(resolve("./derec.db"), "sqlite://./derec.db?mode=rwc");
        assert_eq!(
            resolve("/var/lib/derec/derec.db"),
            "sqlite:///var/lib/derec/derec.db?mode=rwc"
        );
    }

    #[test]
    fn anything_with_a_scheme_is_passed_through_untouched() {
        // A tuned SQLite URL and a Postgres URL arrive the same way: the
        // operator has spelled out what they want and we must not edit it.
        for url in [
            "postgres://user:pw@db:5432/derec",
            "postgresql://db/derec",
            "sqlite://./derec.db?mode=rwc&cache=shared",
        ] {
            assert_eq!(resolve(url), url);
        }
    }

    #[test]
    fn the_in_memory_spelling_survives_resolution() {
        // `sqlite::memory:` contains `:` but not `://`. Treating it as a bare
        // path would produce `sqlite://sqlite::memory:?mode=rwc`, which names a
        // file called `sqlite::memory:` — an ephemeral node that silently
        // persists is the exact opposite of what was asked for.
        assert_eq!(resolve("sqlite::memory:"), "sqlite::memory:");
    }

    #[test]
    fn surrounding_whitespace_is_ignored() {
        // `DEREC_DATABASE_URL=" ./derec.db"` out of a compose file is a typo
        // that should not produce a database named " ./derec.db".
        assert_eq!(resolve("  ./derec.db  "), "sqlite://./derec.db?mode=rwc");
    }

    #[test]
    fn an_empty_value_falls_back_to_the_built_in_default() {
        assert_eq!(resolve(""), resolve(DEFAULT_DATABASE_URL));
        assert_eq!(resolve("   "), resolve(DEFAULT_DATABASE_URL));
    }

    #[test]
    fn a_password_is_replaced_rather_than_shortened() {
        // Not a truncation: the length of a secret is itself information.
        assert_eq!(
            DatabaseUrl::redact("postgres://user:hunter2@db:5432/derec"),
            "postgres://user:***@db:5432/derec"
        );
    }

    #[test]
    fn a_url_with_no_password_is_left_alone() {
        for url in [
            "postgres://user@db:5432/derec",
            "postgres://db:5432/derec",
            "sqlite://./derec.db?mode=rwc",
            "sqlite::memory:",
        ] {
            assert_eq!(DatabaseUrl::redact(url), url, "{url} should be unchanged");
        }
    }

    #[test]
    fn only_the_credentials_section_is_touched() {
        // A colon in the path or query is not a password. Redacting on any
        // colon would mangle `:5432` and make the banner useless for the one
        // thing it is for — seeing what was actually configured.
        assert_eq!(
            DatabaseUrl::redact("postgres://user:pw@db:5432/derec?opt=a:b"),
            "postgres://user:***@db:5432/derec?opt=a:b"
        );
    }

    #[test]
    fn displaying_a_url_redacts_it() {
        let url = DatabaseUrl::from("postgres://user:hunter2@db:5432/derec");

        assert_eq!(url.to_string(), "postgres://user:***@db:5432/derec");
        assert_eq!(url.as_str(), "postgres://user:hunter2@db:5432/derec");
    }

    #[test]
    fn both_in_memory_spellings_are_recognised_as_ephemeral() {
        assert!(is_ephemeral("sqlite::memory:"));
        assert!(is_ephemeral("sqlite://file:x?mode=memory&cache=shared"));
    }

    #[test]
    fn a_file_backed_node_is_not_ephemeral() {
        // Including the bare-path form, which resolves to a
        // `sqlite://…?mode=rwc` URL — checking the raw string would miss it.
        assert!(!is_ephemeral("derec.db"));
        assert!(!is_ephemeral("/var/lib/derec/derec.db"));
        assert!(!is_ephemeral("sqlite://./derec.db?mode=rwc"));
        assert!(!is_ephemeral("postgres://db:5432/derec"));
        assert!(!is_ephemeral(""), "the default is a file, not memory");
    }
}
