// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 DeRec Alliance. All rights reserved.

//! The vendored protos in `proto/` must match the `derec-proto` release the
//! backend is pinned to.
//!
//! `build.rs` deliberately does not locate the crate's shipped copies — a
//! consumer cannot do that without guessing at the registry cache layout, and a
//! wrong guess there fails the build on a machine whose only sin is a different
//! `CARGO_HOME`. The same guess is fine *here*: when it does not resolve this
//! test skips and costs coverage rather than breaking anything.

use std::path::{Path, PathBuf};

/// The 15 files `derectransport.proto` needs transitively. Paths are relative
/// to both `proto/` here and the crate root upstream, which share a layout.
const VENDORED: &[&str] = &[
    "grpc/derectransport.proto",
    "protobufs/derecmessage.proto",
    "protobufs/pair.proto",
    "protobufs/unpair.proto",
    "protobufs/storeshare.proto",
    "protobufs/verify.proto",
    "protobufs/getshare.proto",
    "protobufs/secretidsversions.proto",
    "protobufs/updatechannelinfo.proto",
    "protobufs/prepair.proto",
    "protobufs/error.proto",
    "protobufs/result.proto",
    "protobufs/transportprotocol.proto",
    "protobufs/communicationinfo.proto",
    "protobufs/parameterrange.proto",
];

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The `derec-proto` version this crate depends on, read from the manifest so
/// bumping the dependency cannot leave this test checking the old release.
fn pinned_version() -> String {
    let manifest = std::fs::read_to_string(manifest_dir().join("Cargo.toml"))
        .expect("read Cargo.toml");
    let parsed: toml::Value = manifest.parse().expect("parse Cargo.toml");
    let dep = &parsed["dependencies"]["derec-proto"];

    if let Some(version) = dep.as_str() {
        return version.to_owned();
    }
    dep.get("version")
        .and_then(toml::Value::as_str)
        .expect("derec-proto needs a version")
        .to_owned()
}

/// Find the extracted crate source under any registry directory.
fn upstream_root(version: &str) -> Option<PathBuf> {
    let cargo_home = std::env::var_os("CARGO_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cargo")))?;

    let registries = std::fs::read_dir(cargo_home.join("registry").join("src")).ok()?;
    for registry in registries.flatten() {
        let candidate = registry.path().join(format!("derec-proto-{version}"));
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    None
}

fn read(root: &Path, relative: &str) -> String {
    std::fs::read_to_string(root.join(relative))
        .unwrap_or_else(|e| panic!("read {}: {e}", root.join(relative).display()))
}

#[test]
fn vendored_protos_match_the_pinned_release() {
    let version = pinned_version();

    let Some(upstream) = upstream_root(&version) else {
        eprintln!(
            "SKIPPED: no derec-proto-{version} under any registry src directory. \
             Run `cargo fetch` first, or ignore if this is a vendored build."
        );
        return;
    };

    let local = manifest_dir().join("proto");

    for relative in VENDORED {
        assert_eq!(
            read(&local, relative),
            read(&upstream, relative),
            "proto/{relative} has drifted from derec-proto {version}. \
             Re-copy it from the crate and rebuild."
        );
    }
}

#[test]
fn the_vendored_set_is_exactly_what_is_listed() {
    let local = manifest_dir().join("proto");
    let mut found = Vec::new();

    for dir in ["grpc", "protobufs"] {
        let entries = std::fs::read_dir(local.join(dir)).expect("read proto dir");
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".proto") {
                found.push(format!("{dir}/{name}"));
            }
        }
    }

    found.sort();
    let mut expected: Vec<String> = VENDORED.iter().map(|s| (*s).to_owned()).collect();
    expected.sort();

    assert_eq!(
        found, expected,
        "the files on disk and the list in this test have diverged"
    );
}
