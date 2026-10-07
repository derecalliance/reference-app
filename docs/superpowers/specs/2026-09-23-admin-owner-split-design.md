# Separating the operator surface from the owner surface

## The problem

The app presents one screen that is two things at once.

An **owner** pairs with helpers, protects a secret, verifies shares and recovers.
An **operator** decides what this node runs: how many participants exist, what
transports they advertise, which one is pretending to be offline, what the node
was configured with.

Today both live in `OwnerPage.tsx`. The provisioned-participant pool is an
`aside` inside the owner's page (`OwnerPage.tsx:3219`), the server's self-view is
one of the owner's tabs, and the setup wizard bundles pool provisioning into
owner onboarding — so a developer who wants to manage the node has to first
become an owner, and an owner is shown controls that have nothing to do with
owning a secret.

The two roles also differ in *scope*: an owner is per browser context, while the
operator surface is about the node. Nesting the second inside the first has it
backwards.

## What this builds

A shell with a left navigation pane — permanent on desktop, a hamburger drawer
on narrow screens — holding four sections:

| Section | Answers |
| --- | --- |
| **Owner** | Who am I, who am I paired with, what have I protected |
| **Participants** | What does this node run |
| **Settings** | What is this node configured with |
| **Inspect** | What is the server doing right now |

`Owner` is today's owner page with the operator controls removed. The other
three are new, assembled from components and endpoints that already exist.

### Admin does not require an owner

The left nav is present from the first load. Opening the app in a fresh browser
lands on an operator surface that works: provision participants, read the node's
configuration, inspect the server. `Owner` is the section that offers the setup
wizard when no owner exists yet.

This is the change that makes a bare container immediately useful, and it
follows from what the operator surface *is* — node-level, not owner-level.

### The pool and the pairing entry point

The side panel is doing two jobs. `+ Add` provisions a participant on the server
(operator). The `Pair` button on each row starts an owner's pairing flow (owner).
Moving the panel wholesale would take the owner's pairing entry point with it.

So it splits:

- **Admin ▸ Participants** owns the lifecycle: provision, name, transport,
  offline toggle, removal, and the pool count.
- **Owner** keeps a lean picker — the participants available to pair with, a
  name, a transport badge, a pair button. Nothing that manages them.

The owner flow stays intact end-to-end while every operator control leaves it.

### Settings is two things, said plainly

**Node configuration** is read-only. It is resolved at boot from the config file
and `DEREC_*` variables, and there is no endpoint to change it at runtime —
presenting it as editable would be a lie. `GET /debug/config` already returns
every setting with its value and provenance (default, file, or a named
variable), which is the boot banner in JSON. The pane renders that, and says how
to change it: edit `config.toml` or set the variable, then restart.

**Protocol defaults** are editable. They are what the front end prefills
provisioning requests with — participant count, timeout, unpair acknowledgement,
the transport breakdown — and the backend holds no policy of its own about them.
They are client-side state that travels on each request.

Keeping these in one pane under one heading each is what stops a developer
editing a value that cannot take effect.

## What this is not

- **Not authentication.** There is no admin *role*, no login, no privilege. This
  app has no auth anywhere by design, and this change adds none. It separates
  two *activities*, not two *permissions*. Anyone who can reach the app can
  reach both, exactly as today.
- **Not a refactor of `OwnerPage.tsx`.** It is 327KB and every end-to-end test
  drives it. This removes one `aside`, adds one picker, and moves one tab out.
  Restructuring it is worth doing and is not this.
- **Not client-side routing.** See below.

## Architecture

### No routes

The app deliberately has no client-side routes: every screen lives at the base
path, which is why `build_router`'s `ServeDir` fallback carries no SPA rewrite.
Introducing `/admin` as a URL would mean teaching the backend to rewrite unknown
paths to `index.html` — a server change in service of a navigation affordance.

The shell swaps sections from React state instead. The selected section persists
to `localStorage` so a reload returns you where you were.

The cost is real and worth naming: no deep links, and the browser's back button
does not move between sections. For a single-page developer tool driven from one
window, that is a smaller loss than an SPA rewrite on a server whose route table
is otherwise entirely explicit paths.

### Components

```
App
└── AppShell                      nav + section switching
    ├── Owner        → SetupWizard | OwnerPage        (existing)
    ├── Participants → admin/ParticipantsPane         (new, from the aside)
    ├── Settings     → admin/SettingsPane             (new)
    └── Inspect      → admin/InspectTab               (moved)
ConsolePanel                      stays global, outside the shell
```

`ConsolePanel` is deliberately outside: it reports the whole session's protocol
events and backend deliveries, which is not a section of anything.

### Data

Nothing new is needed from the backend. Every pane reads endpoints that exist:

| Pane | Endpoints |
| --- | --- |
| Participants | `GET /actors`, `POST /helpers`, `POST /helpers/ensure`, `POST /helpers/{id}/toggle-status` |
| Settings | `GET /debug/config` (node, read-only), `GET /config` (defaults) |
| Inspect | `GET /debug/state`, `GET /debug/events` |

The owner's pair-picker reads the same `GET /actors` the aside does today.

### State

Protocol defaults are client-side and already exist — the setup wizard holds
them. They lift into the shell so both the wizard and the Settings pane read one
source, rather than each keeping a copy that can disagree.

Nothing else is lifted. Owner state stays in `OwnerPage`; pool state is fetched
by the pane that shows it.

## Testing

**Unit.** The new panes get vitest coverage: what they render from a given
payload, and what they do on each action. They are small and mostly
presentational, which is the point of extracting them.

**End-to-end.** Forty-eight Playwright tests drive this UI, and they are the
suite that caught every defect in the backend work. The coupling is concentrated
in `e2e/app.ts` — `participantRow`, the `Pair` button, `.side-panel-section` —
so the helpers gain a navigation step and new selectors in one file rather than
across fifteen specs.

The suite must pass **48 passed, 4 skipped, 0 failed** before and after. A spec
that needs its own edit — rather than an edit to a shared helper — is a signal
that the split moved something it should not have, and is worth stopping on.

## Order of work

Three steps, each independently reviewable, chosen so the riskiest change is not
first:

1. **The shell.** Nav, section switching, persistence, and `Inspect` moved out of
   the owner tabs. Nothing else moves. The owner page still holds its aside.
2. **The split.** `Participants` pane takes the pool; the owner page loses the
   aside and gains the pair-picker. This is the step the e2e helpers change for.
3. **Settings.** Node configuration with provenance, and the protocol defaults
   lifted out of the wizard.

Step 1 is visible immediately and reversible cheaply, which is what makes it the
right place to look at the shape before more moves.
