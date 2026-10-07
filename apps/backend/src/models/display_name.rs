// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Display names, and the rules a caller-supplied one is held to.

use std::fmt;

/// The longest display name an actor may carry, in characters.
///
/// Names are rendered in roster rows and sent to peers as
/// `communication_info["name"]` on every pairing, so an unbounded one is both
/// a layout problem and a payload every peer has to carry.
pub const MAX_NAME_CHARS: usize = 64;

/// A caller-supplied display name that passed the rules: trimmed, non-empty,
/// at most [`MAX_NAME_CHARS`] characters, no control characters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DisplayName(String);

/// Why a display name was refused. `field` names the input, so a caller
/// sending several names learns which one it was.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NameError {
    #[error("{field} must not be empty")]
    Empty { field: String },
    #[error("{field} must be at most {MAX_NAME_CHARS} characters")]
    TooLong { field: String },
    #[error("{field} must not contain control characters")]
    ControlCharacters { field: String },
}

impl DisplayName {
    /// Trim `raw` and check it is usable, naming `field` in any refusal.
    pub fn parse(raw: &str, field: &str) -> Result<Self, NameError> {
        let name = raw.trim();
        if name.is_empty() {
            return Err(NameError::Empty {
                field: field.to_owned(),
            });
        }
        if name.chars().count() > MAX_NAME_CHARS {
            return Err(NameError::TooLong {
                field: field.to_owned(),
            });
        }
        if name.chars().any(char::is_control) {
            return Err(NameError::ControlCharacters {
                field: field.to_owned(),
            });
        }
        Ok(Self(name.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A name sent as the request's `name` field.
impl TryFrom<&str> for DisplayName {
    type Error = NameError;

    fn try_from(raw: &str) -> Result<Self, Self::Error> {
        Self::parse(raw, "name")
    }
}

impl From<DisplayName> for String {
    fn from(name: DisplayName) -> Self {
        name.0
    }
}

impl AsRef<str> for DisplayName {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for DisplayName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_trimmed() {
        assert_eq!(
            DisplayName::try_from("  Alex ").map(String::from),
            Ok("Alex".to_owned())
        );
    }

    #[test]
    fn a_blank_name_is_refused_and_named() {
        let error = DisplayName::try_from("   ").expect_err("blank is refused");

        assert_eq!(error.to_string(), "name must not be empty");
    }

    #[test]
    fn an_over_long_name_is_refused() {
        let long = "x".repeat(MAX_NAME_CHARS + 1);

        assert_eq!(
            DisplayName::parse(&long, "names[1]").map_err(|e| e.to_string()),
            Err("names[1] must be at most 64 characters".to_owned())
        );
    }

    #[test]
    fn control_characters_are_refused() {
        assert!(matches!(
            DisplayName::try_from("a\u{7}b"),
            Err(NameError::ControlCharacters { .. })
        ));
    }
}
