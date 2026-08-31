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

use serde::{Deserialize, Serialize};

use crate::models::{AuthenticationMethod, UnpairAck};

/// Where to look for the config file when `DEREC_CONFIG_PATH` is unset.
const DEFAULT_CONFIG_PATH: &str = "config.toml";

/// Environment variable naming the config file. A Docker deployment mounts a
/// file and points this at it.
const CONFIG_PATH_ENV: &str = "DEREC_CONFIG_PATH";

/// The file as written, before unset fields are resolved.
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
        Ok(())
    }

    fn parse(path: &Path, contents: &str) -> Result<Self, ConfigError> {
        let raw: RawDefaults = toml::from_str(contents).map_err(|source| ConfigError::Parse {
            path: path.to_path_buf(),
            source,
        })?;

        let defaults = Self::resolve(raw);

        defaults.validate().map_err(|reason| ConfigError::Invalid {
            path: path.to_path_buf(),
            reason,
        })?;

        Ok(defaults)
    }
}

/// The path the server will read, honouring `DEREC_CONFIG_PATH`.
pub fn configured_path() -> PathBuf {
    std::env::var_os(CONFIG_PATH_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_PATH))
}

/// Read defaults from `path`.
///
/// `Ok(None)` means no file was there, which is the ordinary case for a plain
/// `docker run` with nothing mounted — the caller falls back to
/// [`Defaults::default`]. Every other failure is returned: a developer who
/// mounted a file that cannot be read, parsed, or validated wants to hear about
/// it at boot rather than silently get stock values.
pub fn load(path: &Path) -> Result<Option<Defaults>, ConfigError> {
    let contents = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(ConfigError::Read {
                path: path.to_path_buf(),
                source,
            });
        }
    };

    Defaults::parse(path, &contents).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(contents: &str) -> Result<Defaults, ConfigError> {
        Defaults::parse(Path::new("test.toml"), contents)
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
            }
        );
    }

    #[test]
    fn a_misspelled_key_is_rejected_rather_than_ignored() {
        // `deny_unknown_fields` exists so a typo fails loudly. Silently ignoring
        // it would leave the developer staring at a value they thought they set.
        let err = parse("protocol_timeout_sec = 45").unwrap_err();

        assert!(matches!(err, ConfigError::Parse { .. }), "got {err:?}");
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
    fn the_built_in_defaults_satisfy_their_own_validation() {
        // Otherwise a deployment with no config file would be in a state the
        // server refuses to accept from a file.
        assert_eq!(Defaults::default().validate(), Ok(()));
    }

    #[test]
    fn a_missing_file_is_not_an_error() {
        let missing = Path::new("definitely-not-a-real-config-file.toml");

        assert!(matches!(load(missing), Ok(None)));
    }

    #[test]
    fn the_shipped_example_config_parses_and_validates() {
        // The example is documentation a developer will copy verbatim; if it
        // drifts out of sync with the schema, `deny_unknown_fields` turns that
        // into a boot failure for them rather than a test failure for us.
        let example = concat!(env!("CARGO_MANIFEST_DIR"), "/config.example.toml");

        assert!(load(Path::new(example)).unwrap().is_some());
    }
}
