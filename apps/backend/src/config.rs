//! Operator-supplied defaults for the front end.
//!
//! The app ships as a Docker image, so a developer who wants different starting
//! values should not have to edit code or retype them in the setup wizard on
//! every run. The server reads a TOML file once at boot and serves it from
//! `GET /config`; the wizard prefills from it and the user can still override
//! any field before setting up.
//!
//! These are **defaults only**. The backend does not enforce them: protocol
//! settings travel on each provisioning request, so the values a node actually
//! runs with are whatever the front end sent.

use std::path::{Path, PathBuf};

use figment::{
    Figment, Metadata, Profile, Provider,
    providers::{Format, Toml},
    value::{Dict, Map, Value},
};
use serde::{Deserialize, Serialize};

use crate::models::{AuthenticationMethod, UnpairAck};

/// Where to look for the config file when `DEREC_CONFIG_PATH` is unset.
const DEFAULT_CONFIG_PATH: &str = "config.toml";

/// Environment variable naming the config file. A Docker deployment mounts a
/// file and points this at it.
const CONFIG_PATH_ENV: &str = "DEREC_CONFIG_PATH";

/// Prefix every configuration variable carries.
const ENV_PREFIX: &str = "DEREC_";

/// `DEREC_*` variables that are not configuration keys.
const RESERVED_ENV: &[&str] = &[CONFIG_PATH_ENV];

/// Variable name → dotted path in the config tree.
///
/// Full names, not suffixes: [`Source::Env`] carries one of these straight into
/// the boot banner and into `/debug/config`, and a `&'static str` cannot be
/// assembled from a prefix at runtime without leaking.
///
/// Names are deliberately flat: the table a key lives in does not appear, so a
/// compose file reads as `DEREC_PARTICIPANT_COUNT` rather than
/// `DEREC_DEFAULTS__PARTICIPANT_COUNT`. Keys are unique across both tables,
/// which `the_env_namespace_has_no_collisions` enforces.
const ENV_KEYS: &[(&str, &str)] = &[
    ("DEREC_BASE_URL", "server.base_url"),
    ("DEREC_PORT", "server.port"),
    ("DEREC_PARTICIPANT_COUNT", "defaults.participant_count"),
    ("DEREC_PRE_PAIRED_COUNT", "defaults.pre_paired_count"),
    ("DEREC_MIN_PARTICIPANTS", "defaults.min_participants"),
    (
        "DEREC_RECOMMENDED_PARTICIPANTS",
        "defaults.recommended_participants",
    ),
    (
        "DEREC_PROTOCOL_TIMEOUT_SECS",
        "defaults.protocol_timeout_secs",
    ),
    (
        "DEREC_AUTHENTICATION_METHOD",
        "defaults.authentication_method",
    ),
    ("DEREC_UNPAIR_ACK", "defaults.unpair_ack"),
    (
        "DEREC_AUTO_ACCEPT_UNPAIR_REQUESTS",
        "defaults.auto_accept_unpair_requests",
    ),
    ("DEREC_GRPC_ENABLED", "defaults.grpc_enabled"),
    ("DEREC_GRPC_PORT", "defaults.grpc_port"),
    ("DEREC_GRPC_RELAY_ENABLED", "defaults.grpc_relay_enabled"),
    (
        "DEREC_HELPER_TRANSPORTS_HTTP",
        "defaults.helper_transports.http",
    ),
    (
        "DEREC_HELPER_TRANSPORTS_GRPC",
        "defaults.helper_transports.grpc",
    ),
    (
        "DEREC_HELPER_TRANSPORTS_BOTH",
        "defaults.helper_transports.both",
    ),
];

/// Unprefixed names this app used to read, and what replaced them.
const LEGACY_ENV: &[(&str, &str)] = &[("BASE_URL", "DEREC_BASE_URL"), ("PORT", "DEREC_PORT")];

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
}

/// How this node runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ServerSettings {
    /// Stamped into every transport URI handed to a peer. The port is appended,
    /// so this is a scheme and host with no port of its own.
    pub base_url: String,
    /// The HTTP listener port.
    pub port: u16,
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self {
            base_url: "http://localhost".to_owned(),
            port: 5000,
        }
    }
}

impl ServerSettings {
    fn resolve(raw: RawServer) -> Self {
        let base = Self::default();
        Self {
            base_url: raw.base_url.unwrap_or(base.base_url),
            port: raw.port.unwrap_or(base.port),
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.port == 0 {
            return Err("port must be greater than 0".to_owned());
        }
        if self.base_url.is_empty() {
            return Err("base_url must not be empty".to_owned());
        }
        Ok(())
    }
}

/// Everything the node was configured with.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Settings {
    pub server: ServerSettings,
    pub defaults: Defaults,
}

/// Where a value came from. `Env` carries the variable that supplied it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Default,
    File,
    Env(&'static str),
}

/// One setting's provenance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    pub path: &'static str,
    pub source: Source,
}

// Written by hand rather than derived: `Source` is an enum with a payload on
// one variant only, and the wire shape wanted here is a flat
// `{path, source, variable?}`. `#[serde(flatten)]` over a tagged enum is the
// one serde combination that does not reliably produce that.
impl Serialize for Origin {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;

        let fields = if matches!(self.source, Source::Env(_)) {
            3
        } else {
            2
        };
        let mut out = serializer.serialize_struct("Origin", fields)?;
        out.serialize_field("path", self.path)?;
        match self.source {
            Source::Default => out.serialize_field("source", "default")?,
            Source::File => out.serialize_field("source", "file")?,
            Source::Env(variable) => {
                out.serialize_field("source", "env")?;
                out.serialize_field("variable", variable)?;
            }
        }
        out.end()
    }
}

/// The result of loading configuration: the values, and how they got there.
#[derive(Debug, Clone)]
pub struct Loaded {
    pub settings: Settings,
    pub origins: Vec<Origin>,
    /// Whether a config file was actually read.
    pub file_found: bool,
    /// `DEREC_*` variables that match no known key. Warned about, not fatal.
    pub unknown_env: Vec<String>,
}

// Hand-written rather than derived: a derived `Default` would leave `origins`
// empty, and an empty origins list is a lie — it would make `/debug/config`
// report *no* settings rather than reporting that every setting is a built-in
// default, which is what a `Loaded` nobody configured actually means.
impl Default for Loaded {
    fn default() -> Self {
        Self {
            settings: Settings::default(),
            origins: ENV_KEYS
                .iter()
                .map(|(_, path)| Origin {
                    path,
                    source: Source::Default,
                })
                .collect(),
            file_found: false,
            unknown_env: Vec::new(),
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
    grpc_enabled: Option<bool>,
    grpc_port: Option<u16>,
    helper_transports: Option<crate::models::TransportBreakdown>,
    grpc_relay_enabled: Option<bool>,
}

/// Starting values for the front-end setup wizard.
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
    /// Whether to run the gRPC ingress listener at all.
    pub grpc_enabled: bool,
    /// Port for the gRPC listener.
    pub grpc_port: u16,
    /// Prefills the wizard's transport breakdown. Sums to `participant_count`.
    pub helper_transports: crate::models::TransportBreakdown,
    /// Whether the backend dials gRPC on a browser owner's behalf.
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
            grpc_enabled: true,
            grpc_port: 50051,
            helper_transports: crate::models::TransportBreakdown {
                http: 7,
                grpc: 0,
                both: 0,
            },
            grpc_relay_enabled: true,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("could not read {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not parse {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: toml::de::Error,
    },
    #[error("{path} is not a usable configuration: {reason}")]
    Invalid { path: PathBuf, reason: String },
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
            grpc_enabled: raw.grpc_enabled.unwrap_or(base.grpc_enabled),
            grpc_port: raw.grpc_port.unwrap_or(base.grpc_port),
            helper_transports: raw.helper_transports.unwrap_or(
                crate::models::TransportBreakdown {
                    http: participant_count,
                    grpc: 0,
                    both: 0,
                },
            ),
            grpc_relay_enabled: raw
                .grpc_relay_enabled
                .unwrap_or(base.grpc_relay_enabled),
        }
    }

    /// Rejects combinations the wizard could never produce, so a mistake
    /// surfaces at boot rather than as a confusing UI state much later.
    fn validate(&self) -> Result<(), String> {
        if self.participant_count == 0 {
            return Err("participant_count must be at least 1".to_owned());
        }
        if self.min_participants == 0 {
            return Err("min_participants must be at least 1".to_owned());
        }
        if self.protocol_timeout_secs == 0 {
            return Err("protocol_timeout_secs must be greater than 0".to_owned());
        }
        if self.min_participants > self.participant_count {
            return Err(format!(
                "min_participants ({}) exceeds participant_count ({})",
                self.min_participants, self.participant_count
            ));
        }
        if self.recommended_participants < self.min_participants {
            return Err(format!(
                "recommended_participants ({}) is below min_participants ({})",
                self.recommended_participants, self.min_participants
            ));
        }
        if self.recommended_participants > self.participant_count {
            return Err(format!(
                "recommended_participants ({}) exceeds participant_count ({})",
                self.recommended_participants, self.participant_count
            ));
        }
        if self.pre_paired_count > self.participant_count {
            return Err(format!(
                "pre_paired_count ({}) exceeds participant_count ({})",
                self.pre_paired_count, self.participant_count
            ));
        }
        if self.helper_transports.total() != self.participant_count as usize {
            return Err(format!(
                "helper_transports sums to {} but participant_count is {}",
                self.helper_transports.total(),
                self.participant_count
            ));
        }
        if !self.grpc_enabled
            && (self.helper_transports.grpc > 0 || self.helper_transports.both > 0)
        {
            return Err(
                "helper_transports asks for gRPC helpers but grpc_enabled is false".to_owned(),
            );
        }
        if self.grpc_port == 0 {
            return Err("grpc_port must be greater than 0".to_owned());
        }
        Ok(())
    }

}

/// Reads `DEREC_*` into the config tree.
///
/// A hand-written provider rather than figment's `Env`: this one owns the
/// flat-name-to-dotted-path mapping, and it can separate variables that match a
/// known key from ones that do not, which is what makes "unknown warns" possible.
#[derive(Clone)]
struct EnvProvider {
    values: Vec<(&'static str, String)>,
    unknown: Vec<String>,
}

impl EnvProvider {
    fn from_env() -> Self {
        let mut values = Vec::new();
        let mut unknown = Vec::new();

        for (name, raw) in std::env::vars() {
            if !name.starts_with(ENV_PREFIX) || RESERVED_ENV.contains(&name.as_str()) {
                continue;
            }
            match ENV_KEYS.iter().find(|(var, _)| *var == name) {
                Some((_, path)) => values.push((*path, raw)),
                None => unknown.push(name),
            }
        }

        values.sort_by_key(|(path, _)| *path);
        unknown.sort();
        Self { values, unknown }
    }

    /// The variable that maps to `path`, if any.
    fn variable_for(path: &str) -> Option<&'static str> {
        ENV_KEYS
            .iter()
            .find(|(_, p)| *p == path)
            .map(|(name, _)| *name)
    }
}

/// Environment values arrive as strings; give figment the right shape so serde
/// does not have to coerce `"false"` into a `bool`.
fn coerce(raw: &str) -> Value {
    if let Ok(b) = raw.parse::<bool>() {
        return Value::from(b);
    }
    if let Ok(n) = raw.parse::<u64>() {
        return Value::from(n);
    }
    Value::from(raw)
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
        Metadata::named("environment")
    }

    fn data(&self) -> Result<Map<Profile, Dict>, figment::Error> {
        let mut root = Dict::new();
        for (path, raw) in &self.values {
            insert_path(&mut root, path, coerce(raw));
        }
        Ok(Profile::Default.collect(root))
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
    pub fn merge(path: &Path, contents: Option<String>) -> Result<Loaded, ConfigError> {
        let file_found = contents.is_some();
        let body = contents.unwrap_or_default();

        // Parse first so a syntax error keeps reporting as `Parse`.
        let _: toml::Value = body.parse().map_err(|source| ConfigError::Parse {
            path: path.to_path_buf(),
            source,
        })?;

        let env = EnvProvider::from_env();
        let unknown_env = env.unknown.clone();

        let from_file = Figment::from(Toml::string(&body));
        let from_env = Figment::from(env.clone());
        let merged = Figment::from(Toml::string(&body)).merge(env);

        let raw: RawConfig = merged.extract().map_err(|e| ConfigError::Invalid {
            path: path.to_path_buf(),
            reason: e.to_string(),
        })?;

        let settings = Settings {
            server: ServerSettings::resolve(raw.server),
            defaults: Defaults::resolve(raw.defaults),
        };

        settings
            .server
            .validate()
            .and_then(|()| settings.defaults.validate())
            .map_err(|reason| ConfigError::Invalid {
                path: path.to_path_buf(),
                reason,
            })?;

        let origins = ENV_KEYS
            .iter()
            .map(|(_, config_path)| {
                let source = if from_env.find_value(config_path).is_ok() {
                    EnvProvider::variable_for(config_path)
                        .map(Source::Env)
                        .unwrap_or(Source::Default)
                } else if from_file.find_value(config_path).is_ok() {
                    Source::File
                } else {
                    Source::Default
                };
                Origin {
                    path: config_path,
                    source,
                }
            })
            .collect();

        Ok(Loaded {
            settings,
            origins,
            file_found,
            unknown_env,
        })
    }
}

/// The path the server will read, honouring `DEREC_CONFIG_PATH`.
pub fn configured_path() -> PathBuf {
    std::env::var_os(CONFIG_PATH_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_PATH))
}

/// Render the resolved configuration for the boot log.
///
/// Every setting appears, not only the overridden ones: a developer who set a
/// variable and saw no effect needs to see that key reported as `default`,
/// because that *is* the diagnosis. Order follows [`ENV_KEYS`], which is fixed,
/// so two runs of the same configuration produce identical text and can be
/// diffed.
pub fn report(loaded: &Loaded, path: &Path) -> String {
    use std::fmt::Write as _;

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
        .filter(|o| matches!(o.source, Source::Env(_)))
        .count();
    let _ = writeln!(out, "  env    {env_count} DEREC_* variables");

    for name in &loaded.unknown_env {
        let _ = writeln!(out, "  env    {name} is not a known setting; ignored");
    }

    let values = values_by_path(&loaded.settings);
    let width = ENV_KEYS
        .iter()
        .map(|(_, path)| leaf_of(path).len())
        .max()
        .unwrap_or(0);

    let mut table = String::new();
    for (_, config_path) in ENV_KEYS {
        let table_name = config_path.split('.').next().unwrap_or("");
        if !table.contains(&format!("[{table_name}]")) {
            let _ = write!(table, "\n  [{table_name}]\n");
        }

        let origin = loaded
            .origins
            .iter()
            .find(|o| o.path == *config_path)
            .map(|o| match o.source {
                Source::Default => "default".to_owned(),
                Source::File => "file".to_owned(),
                Source::Env(name) => format!("env {name}"),
            })
            .unwrap_or_else(|| "default".to_owned());

        let value = values
            .iter()
            .find(|(p, _)| p == config_path)
            .map(|(_, v)| v.clone())
            .unwrap_or_default();

        let _ = writeln!(
            table,
            "  {:<width$}  {:<24}  {}",
            leaf_of(config_path),
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

    for (_, path) in ENV_KEYS {
        let mut cursor = &root;
        let mut found = true;
        for segment in path.split('.') {
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
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            out.push(((*path).to_owned(), text));
        }
    }
    out
}

/// Read configuration from `path`, merged with the environment.
///
/// A missing file is not an error — that is the ordinary `docker run` case, and
/// the environment plus built-in defaults are a complete configuration. Every
/// other read failure is returned: a developer who mounted a file that cannot be
/// read wants to hear about it at boot rather than silently get stock values.
pub fn load(path: &Path) -> Result<Loaded, ConfigError> {
    let contents = match std::fs::read_to_string(path) {
        Ok(c) => Some(c),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => None,
        Err(source) => {
            return Err(ConfigError::Read {
                path: path.to_path_buf(),
                source,
            });
        }
    };

    Settings::merge(path, contents)
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

    fn settings_from(contents: &str, vars: &[(&str, &str)]) -> Loaded {
        with_env(vars, || {
            Settings::merge(Path::new("test.toml"), Some(contents.to_owned()))
                .expect("settings must load")
        })
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
        assert_eq!(parsed.participant_count, Defaults::default().participant_count);
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
            crate::models::TransportBreakdown { http: 2, grpc: 0, both: 0 }
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

        assert!(matches!(parse(contents).unwrap_err(), ConfigError::Invalid { .. }));
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

        assert!(matches!(parse(contents).unwrap_err(), ConfigError::Invalid { .. }));
    }

    #[test]
    fn requesting_grpc_helpers_while_grpc_is_disabled_is_rejected() {
        // Not a silent downgrade to HTTP: a helper advertising an endpoint
        // nothing is listening on pairs successfully and then black-holes
        // every reply.
        let contents = "participant_count = 9\ngrpc_enabled = false\nhelper_transports = { http = 5, grpc = 4, both = 0 }";

        assert!(matches!(parse(contents).unwrap_err(), ConfigError::Invalid { .. }));
    }

    #[test]
    fn a_zero_grpc_port_is_rejected() {
        assert!(matches!(parse("grpc_port = 0").unwrap_err(), ConfigError::Invalid { .. }));
    }

    #[test]
    fn the_built_in_defaults_satisfy_their_own_validation() {
        // Otherwise a deployment with no config file would be in a state the
        // server refuses to accept from a file.
        assert_eq!(Defaults::default().validate(), Ok(()));
    }

    #[test]
    fn a_missing_file_is_not_an_error() {
        let missing = Path::new("definitely-not-a-real-config-file.toml");

        let loaded = with_env(&[], || load(missing)).expect("a missing file is not an error");

        assert!(!loaded.file_found);
    }

    #[test]
    fn the_shipped_example_config_parses_and_validates() {
        // The example is documentation a developer will copy verbatim; if it
        // drifts out of sync with the schema, `deny_unknown_fields` turns that
        // into a boot failure for them rather than a test failure for us.
        //
        // It lives in the repo-wide `examples/` directory, beside the compose
        // and `.env` examples, rather than in this package — the three are read
        // together and a developer should not have to hunt two directories for
        // them. Hence the climb out of `apps/backend`.
        let example = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../examples/config.example.toml"
        );

        let loaded = with_env(&[], || load(Path::new(example))).expect("the example must load");

        assert!(loaded.file_found);
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
    fn an_absent_setting_falls_through_to_the_built_in_default() {
        let loaded = settings_from("", &[]);

        assert_eq!(
            loaded.settings.defaults.protocol_timeout_secs,
            Defaults::default().protocol_timeout_secs
        );
        assert_eq!(loaded.settings.server.port, 5000);
        assert_eq!(loaded.settings.server.base_url, "http://localhost");
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
        let err = with_env(&[("DEREC_PARTICIPANT_COUNT", "3")], || {
            Settings::merge(
                Path::new("test.toml"),
                Some(
                    "[defaults]\nparticipant_count = 7\n\
                     [defaults.helper_transports]\nhttp = 7\ngrpc = 0\nboth = 0\n"
                        .to_owned(),
                ),
            )
            .unwrap_err()
        });

        let message = err.to_string();
        assert!(
            message.contains("helper_transports"),
            "expected the sum check to fail, got: {message}"
        );
    }

    #[test]
    fn server_settings_come_from_their_own_table() {
        let loaded = settings_from("[server]\nbase_url = \"http://10.0.0.5\"\nport = 6000\n", &[]);

        assert_eq!(loaded.settings.server.base_url, "http://10.0.0.5");
        assert_eq!(loaded.settings.server.port, 6000);
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
    fn a_misspelled_file_key_is_rejected_rather_than_ignored() {
        // `deny_unknown_fields` exists so a typo fails loudly. Silently ignoring
        // it would leave the developer staring at a value they thought they set.
        let err = with_env(&[], || {
            Settings::merge(
                Path::new("test.toml"),
                Some("[defaults]\nprotocol_timeout_sec = 45\n".to_owned()),
            )
            .unwrap_err()
        });

        assert!(
            err.to_string().contains("protocol_timeout_sec"),
            "the error must name the offending key, got: {err}"
        );
    }

    #[test]
    fn an_unknown_env_variable_warns_rather_than_aborting() {
        let loaded = settings_from("", &[("DEREC_PARTICIPNT_COUNT", "4")]);

        assert_eq!(loaded.unknown_env, vec!["DEREC_PARTICIPNT_COUNT".to_owned()]);
        assert_eq!(
            loaded.settings.defaults.participant_count,
            Defaults::default().participant_count
        );
    }

    #[test]
    fn config_path_is_not_treated_as_a_config_key() {
        let loaded = settings_from("", &[("DEREC_CONFIG_PATH", "/etc/derec/config.toml")]);

        assert!(loaded.unknown_env.is_empty(), "got {:?}", loaded.unknown_env);
    }

    #[test]
    fn the_env_namespace_has_no_collisions() {
        let mut names = HashSet::new();
        let mut paths = HashSet::new();

        for (name, path) in ENV_KEYS {
            assert!(names.insert(*name), "duplicate variable name: {name}");
            assert!(paths.insert(*path), "duplicate config path: {path}");
            assert!(
                name.starts_with(ENV_PREFIX),
                "{name} is missing the {ENV_PREFIX} prefix"
            );
            assert!(
                !RESERVED_ENV.contains(name),
                "{name} is both a config key and reserved"
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
            Source::Env("DEREC_PARTICIPANT_COUNT")
        );
        assert_eq!(origin("defaults.unpair_ack"), Source::File);
        assert_eq!(origin("defaults.protocol_timeout_secs"), Source::Default);
        assert_eq!(origin("server.port"), Source::Default);
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

        assert_eq!(origin.source, Source::File);
    }

    #[test]
    fn every_config_path_gets_an_origin() {
        let loaded = settings_from("", &[]);
        let reported: HashSet<&str> = loaded.origins.iter().map(|o| o.path).collect();

        for (_, path) in ENV_KEYS {
            assert!(reported.contains(path), "{path} has no origin");
        }
        assert_eq!(reported.len(), ENV_KEYS.len());
    }

    #[test]
    fn legacy_unprefixed_names_are_detected() {
        let found = with_env(&[("BASE_URL", "http://10.0.0.5")], legacy_env_in_use);

        assert_eq!(found, vec![("BASE_URL", "DEREC_BASE_URL")]);
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
