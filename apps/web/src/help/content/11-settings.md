# Settings

What the Settings section shows: the node's own configuration (read-only), and this browser's overrides of the protocol defaults, field by field.

## Two halves

| Section | Editable | Where it lives |
| --- | --- | --- |
| **Node configuration** | No | Resolved by the node at boot from its config file and `DEREC_*` variables. Same data as `GET /api/v1/debug/config`. |
| **Protocol defaults** | Yes | This browser's `localStorage` (`derec.protocolDefaults`), on top of the node's defaults from `GET /api/v1/config`. |

## Node configuration

A table per config section, `[server]` and `[defaults]`, with every setting, its value, and a chip saying where it came from: `default`, `config file`, or the environment variable's name. It also says whether a config file was found and lists any `DEREC_*` variables it ignored because they match no setting. To change a value, edit `config.toml` or the variable and restart the node. See [Node configuration](15-node-configuration.md).

## Browser overrides vs node defaults

- The form starts from the node's defaults. Changing a field and clicking **Save** stores **only the fields that differ** from the node; the rest keep following the node if it is reconfigured.
- The banner says *Following the node* or *Overridden in this browser*.
- **Reset to node** drops every override.
- Overrides never reach the server as settings. They travel on each provisioning request and prefill the setup wizard.
- The gRPC switches are facts about the node, not preferences: `grpc_enabled` and `grpc_relay_enabled` always come from the node, whatever was saved.
- **Reset browser data** also erases these overrides.

## Participant pool

| Field | Node key | Default | Range | Effect |
| --- | --- | --- | --- | --- |
| **Participants** | `participant_count` | 7 | 2 to 255 | Target pool size for **Provision up to N**. |
| **Minimum** | `min_participants` | 3 | 2 to the pool size | The threshold of vaults set up from now on: shares needed to recover, and paired helpers needed before protecting. Frozen into each vault at setup. |
| **Recommended** | `recommended_participants` | 5 | Minimum to the pool size | Below this many paired helpers, a vault shows a warning. Advisory. |

## Transport mix

Shown only while the node runs gRPC. Three counts, **HTTP only**, **gRPC only** and **Both**, that always add up to the pool size: the field you edit keeps its value and the others shift (a raise takes from the largest, a cut goes to HTTP only). Used by **Provision up to N**. Node keys `helper_transports.http`, `.grpc`, `.both`; default all HTTP.

## Protocol policy

| Field | Node key | Default | Effect |
| --- | --- | --- | --- |
| **Unpair acknowledgement** | `unpair_ack` | `required` | `required`: the initiator keeps its state until the peer acknowledges or the timeout passes. `not_required`: state is dropped at once and later replies are ignored. Applies to new helpers and to a vault when its protocol starts. |
| **Incoming unpair requests** | `auto_accept_unpair_requests` | auto-accept | Or *show a dialog*. Read live by every vault in this browser. |
| **Incoming share storage requests** | `auto_accept_store_share_requests` | show a dialog | When a vault acts as a helper. Hosted helpers always accept. |
| **Incoming verification requests** | `auto_accept_verify_share_requests` | show a dialog | When a vault acts as a helper. Hosted helpers always answer. |
| **Authentication method** | `authentication_method` | `user` | How the app decides two channels belong to the same user. `user`: the helper links channels by hand (*Link to existing*). `application` is reserved and not selectable. |

## Defaults for new owners

| Field | Node key | Default | Range | Effect |
| --- | --- | --- | --- | --- |
| **Protocol timeout (s)** | `protocol_timeout_secs` | 300 | 10 to 86400 | The wizard's starting value, and the timeout new helpers are created with. A vault uses it unless its owner changed it at setup; a change applies when the vault's protocol next starts (for example after a reload). |
| **Pre-paired** | `pre_paired_count` | 3 | 0 to the pool size | The wizard's starting value for *Pre-pair locally*. |

Invalid values are flagged on the field and **Save** stays disabled: *Fix the highlighted fields to save.* Only plain digits count as a number (`1e3` and `2.5` are refused).
