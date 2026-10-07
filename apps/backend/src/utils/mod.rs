// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Small pure utilities with no business meaning of their own: the clock and
//! timestamp formatting, and serde helpers. Any layer may use them; they
//! depend on nothing in this crate.

pub mod json;
pub mod time;
