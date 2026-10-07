// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Serde helpers for how this API writes values into JSON.

/// Serialize a `u64` as a decimal string.
///
/// Every `u64` this app puts on the wire — channel ids, secret ids — exceeds
/// JavaScript's exact integer range, so none may travel as a JSON number.
pub fn u64_as_string<S: serde::Serializer>(value: &u64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&value.to_string())
}
