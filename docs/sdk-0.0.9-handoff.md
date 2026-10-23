# SDK 0.0.9 — findings from the reference app

Findings the reference app hit while running against the local, unreleased
lib-derec 0.0.9 (`feature/leaf_separator_and_padding`). App-side fixes are
already in the app; these are the library's to decide.

| # | Area | Severity | Status |
| --- | --- | --- | --- |
| 1 | WASM `restore` refuses `communication_info: undefined` / `null` | Low (app worked around it) | Open — question |

## 1. `restore` refuses an explicit `undefined` / `null` `communication_info`

**Where:** `library/src/interop/recovered_secret.rs` — `HelperIn` and
`ReplicaIn` declare `communication_info: HashMap<String, String>` with
`#[serde(default)]`; decoded in WASM by `parse_recovered_secret`
(`library/src/interop/wasm/protocol/mod.rs`).

**What happens:** `#[serde(default)]` covers a *missing* key only. A helper or
replica member whose `communication_info` key is present but `undefined` or
`null` fails the whole restore:

```
invalid_recovered_secret: TypeError: Reflect.get called on non-object
```

The message names no field, so it reads like a WASM crash rather than a bad
input. `transports` on the same structs is `Option<…>` and documents that
absent, `null` and `[]` all decode — `communication_info` does not get the
same leniency, and the declared TS type (`communication_info?: Record<…>`)
suggests `undefined` is fine.

**Reproduce:** with the 0.0.9 web package, call
`protocol.restore({ helpers: [{ channel_id: '7', transports: [...], shared_key, communication_info: undefined }], secrets: [] }, 1)`.
Omitting the key, or passing `{}` or a `Map`, succeeds.

**App workaround:** `snapshotToPayload` (`apps/web/src/owner/recoveredSecret.ts`)
omits the key when there is no communication info.

**Suggested fix / question:** make the field `Option<HashMap<…>>` (or a
`deserialize_with` that maps `null`/`undefined` to empty), matching
`transports`; and/or have the decode error name the field it failed on.
