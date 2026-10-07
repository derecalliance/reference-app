// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! Liveness, for the image's `HEALTHCHECK`. Outside `/api/v1` and bodyless, so
//! a probe needs no knowledge of the API's envelope.

pub mod get;
