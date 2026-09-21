# Sprint — Connect the local builder to an installed platform (2026-09-21)

**Goal.** A person connects their local builder through browser consent, creates or selects an application in the installed console, builds locally, deploys through Control, and repeats the workflow without registering a duplicate application.

**Theme.** Keep coding agents and application execution local while making application identity and deployment continuous with the installed platform. Initial delivery targets Zerops.

## Refs re-verified at HEAD (2026-09-21)

- ✔ `packages/builder/cli/src/layout.ts:17` stores only profile, session ID and creation time; connection metadata is new.
- ✔ `packages/builder/daemon/src/index.ts:60` binds to localhost but does not admit HTTP/WebSocket requests by authority and origin.
- ✔ `packages/control-contract/src/rpc.ts:117` already exposes application creation, environment replacement, deploy and run polling.
- ✔ `packages/iam/src/issue.ts:70` supports delegated service-principal keys; credentials are hash-only and grants are scope-checked.
- ✔ `packages/control/src/control-rpc.ts` requires global application management for creation and app-scoped management for updates. Human console creation avoids giving the daemon global authority.
- ⚠ `packages/control/src/api/registry/environments.ts` preserves some omitted placement fields and clears others. Builder updates must explicitly preserve the reviewed placement.
- ⚠ The local compiler executes application TypeScript and temporarily modifies its process environment. Compilation must run separately from credential-bearing daemon operations.
- ⚠ An immutable commit reference does not snapshot the Control registry. Do not claim an immutable full-manifest deployment guarantee.

## Work units

### WU0 — Freeze the contracts and authorization design (M)

- **Problem.** Browser-to-builder pairing and non-secret project binding have no shared contract.
- **Verify first.** Inspect both IAM transports, existing issuance, Control creation, provider compilation, and local daemon callers.
- **Scope.** Specify pairing lifecycle, browser consent, local custody, initial placement handoff, CLI/daemon DTOs and ownership. Record the durable decision. Independently review before dependent implementation.
- **Acceptance / witness.** Every field has one owner; secrets never enter project metadata, browser state, compiler environment or logs; both IAM transports implement the same contract.
- **Touch points.** Contract packages, builder shared DTOs, package manifests, ADR and this sprint.

### WU1 — IAM authorization transactions (L)

- **Problem.** There is no public device-pairing protocol; existing admin key issuance requires IAM administration.
- **Verify first.** Delegated issuance and revocation tests; database capability and migration conventions.
- **Scope.** Short-lived pairing attempts, authenticated human approval, live delegation checks, single-use redemption, mandatory key expiry and issuer revocation. Both database/runtime compositions.
- **Acceptance / witness.** Wrong proof, denial, expiry, replay and concurrent exchange refuse issuance. Machine callers cannot approve. An app-scoped service key cannot exercise global or other-app authority.
- **Touch points.** IAM implementation, migrations, transports and focused tests.

### WU2 — Console connection flow (L)

- **Problem.** Application creation, placement and local authorization are disconnected.
- **Verify first.** Existing application create/update and namespace/source authorization behavior.
- **Scope.** Human creation/selection, explicit destination review, approval and revocation through existing authenticated boundaries. Return non-secret binding information without browser-to-loopback cross-origin writes.
- **Acceptance / witness.** Non-admin users with sufficient explicit permissions can connect; insufficient permissions refuse. Creation conflicts never silently become updates.
- **Touch points.** Control and dashboard, their tests and generated route registry.

### WU3 — Local custody, admission and deploy orchestration (L)

- **Problem.** The daemon has neither platform credentials nor a safe deployment lifecycle.
- **Verify first.** Real HTTP/WebSocket admission probes and disposable Git-repository tests.
- **Scope.** Exact local-origin admission, private user-level credential custody outside repositories, project registration, browser pairing client, isolated compilation, explicit environment creation/update, immutable pushed revision trigger, run polling and resumption.
- **Acceptance / witness.** Hostile origins fail before side effects; restart retains the connection; no credential reaches compilation or artifacts; repeat updates preserve placement; failed preparation never triggers a deploy; terminal commit matches the requested revision.
- **Touch points.** Builder daemon, shared local deployment implementation and focused tests.

### WU4 — Local CLI and UI (M)

- **Problem.** The builder cannot display or operate the installed application, and its application preview assumes port 5173.
- **Verify first.** Existing init/resume and HTTP client tests.
- **Scope.** Connect/status/disconnect/deploy operations, explicit preview URL, connection and run views, clear offline/error states, console links. Keep UI and CLI on the daemon HTTP boundary.
- **Acceptance / witness.** Old projects still open; repeated init does not rebind; a non-default preview works; offline fixtures cannot deploy; failed runs cannot appear successful.
- **Touch points.** Builder CLI and UI with disjoint test ownership.

### WU5 — Zerops stack and agent workflow (M)

- **Problem.** The catalog does not describe today's platform-managed Zerops application path.
- **Verify first.** Catalog dependency closure and public Zerops example.
- **Scope.** Supported Zerops preset, current authentication/configuration guidance, preview publication, first deployment and subsequent changes.
- **Acceptance / witness.** Catalog integrity passes and workflow instructions match actual CLI help and implementation.
- **Touch points.** Builder stacks, decisions, skill and catalog tests.

### WU6 — Integrated verification and documentation (M)

- **Problem.** Unit doubles cannot establish the proxy/IAM/Control/browser round trip.
- **Verify first.** Available Docker stack and CPU leases; preserve unrelated running services.
- **Scope.** End-to-end local witness, independent reviews, root quality checks, UI builds, package validation, current reference docs.
- **Acceptance / witness.** Browser approval → local credential → first environment/deploy → repeat update, including denied and revoked access. Distinguish emulator success from real Zerops evidence.
- **Touch points.** Integration/browser tests, local test support and documentation.

## Out of scope (explicit)

- Remote coding-agent hosting and workspace management: the user explicitly prefers local agents.
- Namespace provisioning, GitHub App setup and custom-domain binding from the builder: the administrator prepares these.
- Automatic commits or pushes of application repositories: deploy consumes a remotely available commit.
- New global authorization semantics, an app-and-environment scope intersection, or a second gate evaluator.
- Production deployment, publishing and pushing this repository. Live Zerops testing needs separate authorization.
- Immutable registry snapshots for queued deploys; do not overstate the existing exact-source guarantee.

## Decisions

- The user approved browser pairing and human console confirmation of application creation/selection.
- The user approved orchestration, independent review, local integration checks and atomic commits on the current branch.
- Builder credentials use a separate service principal scoped to one app, with existing `app.manage`, `deploy.trigger` and `deploy.read` actions. `app.manage` also permits deletion and management of all app environments; consent must say so.
- Credentials remain outside the repository and outside browser/agent/compiler data. `fabrika control` keeps its environment-only credential contract.
- Protocol details and frozen DTOs are settled in WU0 before dependent implementation. Architectural blockers return to the user.

## Sequencing

WU0 first; local admission is an independent prerequisite within that wave. Then IAM, daemon foundations and catalog can proceed independently. Control consent follows the IAM seam. CLI and UI follow the local seam. WU6 integrates and verifies all units. Maximum three simultaneous implementers, one tree, strictly disjoint write territories. Each implemented unit receives review by another agent and leader-run checks before commit.

## Run log

- 2026-09-21: Grounding completed by three read-only agents; initial working tree clean at `c154865`.
- 2026-09-21: `bun run release:validate --tag=v0.2.0` passed for 28 public packages. Bare validation requires an explicit tag when HEAD is untagged.
- 2026-09-21: Baseline builder test command timed out waiting for a CPU lease; no test result was produced. Retry under a lease during verification.
- 2026-09-21: User approved the implementation gate. Protocol and console bootstrap specification review started; daemon admission implementation has a separate three-file territory.
