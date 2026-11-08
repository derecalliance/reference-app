# Settings

What the Settings section shows: the node's own configuration (read-only), and this browser's overrides of the node's helper pool defaults, field by field.

These are browser- and node-wide. A secret's protocol settings (timeout, unpair acknowledgement, which incoming requests it answers on its own, authentication method) are not here: each secret holds its own, starting from the app's defaults, on its **Settings** tab. So are its publishing choices; its threshold and helper weights are on its **Channels** tab. See [Protecting secrets](04-protecting-secrets.md#the-settings-tab).

## Two halves

| Section | Editable | Where it lives |
| --- | --- | --- |
| **Node configuration** | No | Resolved by the node at boot from its config file and `DEREC_*` variables. Same data as `GET /api/v1/debug/config`. |
| **Pool defaults** | Yes | This browser's `localStorage` (`derec.protocolDefaults`), on top of the node's defaults from `GET /api/v1/config`. |

## Node configuration

A table per config section, `[server]` and `[defaults]`, with every setting, its value, and a chip saying where it came from: `default`, `config file`, or the environment variable's name. It also says whether a config file was found and lists any `DEREC_*` variables it ignored because they match no setting. To change a value, edit `config.toml` or the variable and restart the node. See [Node configuration](15-node-configuration.md).

## Browser overrides vs node defaults

- The form starts from the node's defaults. Changing a field and clicking **Save** stores **only the fields that differ** from the node; the rest keep following the node if it is reconfigured.
- The banner says *Following the node* or *Overridden in this browser*.
- **Reset to node** drops every override.
- Overrides never reach the server as settings. They travel on each provisioning request and prefill the setup wizard.
- The gRPC switches are facts about the node, not preferences: `grpc_enabled` and `grpc_relay_enabled` always come from the node, whatever was saved.
- If the node is down when the page loads, the built-in defaults stand in and the app keeps asking for the node's (after 1 s, 2 s, 5 s, 10 s, then every 30 s, and at once when a secret reaches the node again) until it answers once. A secret's protocol settings never depend on it.
- Overrides of protocol settings saved here by an earlier version of the app are no longer read.
- **Reset browser data** also erases these overrides.

## Participant pool

| Field | Node key | Default | Range | Effect |
| --- | --- | --- | --- | --- |
| **Participants** | `participant_count` | 7 | 2 to 255 | Target pool size for **Provision up to N**. |
| **Minimum** | `min_participants` | 3 | 2 to the pool size | The fixed threshold that secrets set up from now on start with, used if they switch from a percentage (a new secret starts at 50% of its helpers' subshares) to a fixed number. Each secret then keeps its own threshold, set on its **Channels** tab. |
| **Recommended** | `recommended_participants` | 5 | Minimum to the pool size | Below this many paired helpers, a secret's page shows a warning. Advisory. |
| **Pre-paired** | `pre_paired_count` | 3 | 0 to the pool size | The wizard's starting value for *Pre-pair locally*. |

## Transport mix

Shown only while the node runs gRPC. Three counts, **HTTP only**, **gRPC only** and **Both**, that always add up to the pool size: the field you edit keeps its value and the others shift (a raise takes from the largest, a cut goes to HTTP only). Used by **Provision up to N**. Node keys `helper_transports.http`, `.grpc`, `.both`; default all HTTP.

## No protocol settings

Neither the node nor this page holds protocol settings. Each secret has its own on its **Settings** tab, starting from the app's defaults (30-second timeout, no unpair acknowledgement, every incoming request accepted automatically). Helpers provisioned from **Participants** get the same timeout and acknowledgement.

Invalid values are flagged on the field and **Save** stays disabled: *Fix the highlighted fields to save.* Only plain digits count as a number (`1e3` and `2.5` are refused).
