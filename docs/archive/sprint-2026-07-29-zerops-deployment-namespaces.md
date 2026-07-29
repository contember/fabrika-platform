# Sprint — Zerops deployment namespaces (2026-07-29)

## OUTCOME

Shipped first-class provider-owned deployment namespaces for Zerops.

- `e431670` records the ownership and isolation model in ADR-0014.
- `7916470`, `c7f0d56`, `4ef9a76`, `9ba400f`, `43c7a9c`, and `0617b91`
  establish the open provider contract, persistence, APIs, and reconciliation
  coordinates.
- `bfd7549`, `a1c5213`, `c32f679`, `91e7a1c`, and `3344f02` provision Zerops
  projects, enforce immutable service ownership, and deliver cheap, mid, and
  full topologies including namespace-owned PostgreSQL.
- `960f00e`, `9b8bf77`, and `74b7b21` add the dashboard, operator API/CLI, target
  v2 migration, and namespace-aware deploy, proxy, secret, cancellation, and
  reconciliation lifecycle.
- `51da752` documents the resulting contract and operator workflows in
  [`deployment-namespaces.md`](../reference/deployment-namespaces.md).

Verification:

- `cpu-lease run -n 4 -- bun run typecheck` passed every workspace package.
- `cpu-lease run -n 4 -- bun test` passed 1,090 tests with no failures; 117
  Postgres/S3 integration tests skipped because their external services were not
  configured.
- The dashboard route generator and its 16 tests passed.
- The namespace operator and lifecycle targeted suites passed 101 tests.
- Format checking, lint, tracked-document lint, and `git diff --check` passed.

Moving deployed applications or data, destructive namespace deletion, per-app
database/user brokerage inside cheap PostgreSQL, and automatic custom-domain
binding remain outside this feature. Credentialed Zerops validation remains in
[backlog 05](../backlog/05-bring-up-on-a-real-zerops-account.md).

**Goal.** Make Zerops projects first-class deployment namespaces with cheap,
mid, and full isolation presets, including a namespace-owned shared PostgreSQL
service for the cheap preset.

**Theme.** One namespace lifecycle must cover project placement, its mandatory
proxy, service ownership, and optional shared infrastructure without leaking
Zerops concepts into the neutral control core.

## Refs re-verified at HEAD (2026-07-29)

- ✔ A Zerops app target already persists arbitrary `projectId` and deploy
  `serviceId` coordinates; it does not assume `apps-prod` —
  `packages/provider-zerops/src/control.ts:22-49`.
- ✔ The neutral provider contract has environments but no namespace concept or
  namespace lifecycle capability — `packages/provider-contract/src/control.ts:20-108`.
- ✔ Proxy manifests already aggregate registered apps by Zerops `projectId` and
  roll the `proxy` service in that project —
  `packages/control/src/zerops-proxy.ts:37-110`.
- ✔ The current topology factory can create an apps project with one proxy, but
  the committed topology list emits only `apps-prod` —
  `deploy/zerops/topology.ts:191-235`.
- ✔ App imports set `override: true`; without cross-app ownership checks, a
  colliding hostname can update another app's service —
  `packages/provider-zerops/src/compile.ts:46-63`.
- ✔ The compiler checks duplicate hostnames only inside one import, not across
  apps already assigned to a project —
  `packages/provider-zerops/src/compile.ts:164-203`.
- ✔ The worked app already demonstrates an app-owned PostgreSQL service and a
  runtime reference to `${notesdb_connectionString}` —
  `examples/zerops-app/fabrika.config.ts:27-71`,
  `examples/zerops-app/zerops.yaml:84-91`.
- ✔ Project-level environment variables remain forbidden; any shared PostgreSQL
  binding must use a Zerops service-variable reference and must not copy a
  connection string through fabrika —
  `packages/provider-zerops/src/compile.ts:164-188`.
- ⚠ Namespace provisioning must deploy a usable proxy, not merely create its
  empty service. The proxy needs the global IAM URL, its IAM key, an initial
  manifest, and a source-backed `proxy` pipeline —
  `deploy/zerops/setups.ts:179-250`.

## Work units

### WU1 — Ratify namespace and isolation semantics (effort M)

- **Problem.** ADR-0006 allows different app-to-project mappings, but there is no
  first-class namespace object, resource ownership model, or precise definition
  of the three isolation presets.
- **Verify first.** Trace every current use of Zerops `projectId`, the proxy
  manifest grouping key, and the app service import boundary. Confirm that the
  platform project and global IAM stay outside the app namespace model.
- **Scope.** Write a new ADR that extends ADR-0006 and ADR-0011. Define one
  deployment namespace as one provider-owned placement boundary; on Zerops it is
  exactly one project and owns exactly one proxy. Define the presets as
  compositions rather than a closed provider-neutral enum:
  - **cheap:** shared namespace, namespace-owned `postgres`, app-owned runtime
    services;
  - **mid:** shared namespace, app-owned prefixed runtime and database services;
  - **full:** namespace exclusive to one app, with only its proxy and app-owned
    services.
- **Shared PostgreSQL meaning.** State explicitly that cheap shares the physical
  PostgreSQL service and its platform-issued connection credential. Apps in that
  namespace are one trust domain; per-app database/user brokerage is not implied.
- **Acceptance / witness.** The ADR records ownership, failure boundaries,
  PostgreSQL semantics, migration restrictions, and rejected alternatives. The
  decision index and active sprint agree.
- **Touch points.** `docs/decisions/`, `docs/decisions/README.md`,
  `docs/reference/provider-bundles.md`.

### WU2 — Add the open namespace contract and persistence (effort L)

- **Problem.** `ProviderEnvironment` carries a self-contained target envelope,
  so the project coordinate is duplicated per app and providers cannot
  provision or validate a shared placement boundary.
- **Verify first.** Characterize environment registration, provider envelope
  migration, SQLite/Postgres schema parity, and a third fake provider with no
  namespace capability.
- **Scope.** Add an optional provider-neutral namespace record with a
  provider-owned target envelope. Extend `ControlProvider` with an optional
  namespace capability for normalize, provision, and reconcile. Add
  `deployment_namespaces`, an optional `app_envs.namespace_id`, and generic
  namespace resource claims. Migrate existing Zerops environments by grouping
  target-v1 rows by project ID; leave providers without namespace capability
  unchanged. Advance the Zerops app target envelope so project coordinates live
  only in the namespace target after migration.
- **Acceptance / witness.** Contract tests prove a namespaced third provider and
  a provider without namespaces both work. SQLite and Postgres schema tests
  produce the same rows, constraints, and migrated Zerops grouping. No shared
  table has a Zerops-specific column or closed provider check.
- **Touch points.** `packages/provider-contract/`, `packages/control/src/db.ts`,
  `packages/control/migrations/`, `packages/control/migrations-postgres/`,
  control DB tests.

### WU3 — Expose namespace registration and assignment (effort M)

- **Problem.** Operators can register an app environment only by supplying raw
  provider target data. There is no named placement object to select, inspect,
  or constrain.
- **Verify first.** Capture current app/environment create, update, delete, ACL,
  audit, and dashboard DTO behaviour.
- **Scope.** Add namespace list/get/create/adopt/reconcile APIs and audit events.
  Let an app environment select `namespaceId`; provider normalization receives
  both namespace and app data. Require a Zerops namespace for new Zerops
  environments. Reject environment assignment to a namespace for another env,
  provider, or exclusive app. Reject changing namespace after a successful
  deploy; moving live services or data is a separate migration workflow.
- **Acceptance / witness.** API tests cover shared assignment, exclusive
  assignment, provider/env mismatch, immutable deployed placement, ACL, and
  audit metadata. Existing Cloudflare environment flows remain namespace-free.
- **Touch points.** `packages/control/src/api/`, `packages/control/src/db.ts`,
  `packages/control/src/actions.ts`, `packages/dashboard/src/lib/api.ts`.

### WU4 — Provision and reconcile Zerops namespace projects (effort L)

- **Problem.** `appsTopology()` produces static artifacts but control cannot
  idempotently create an arbitrary project, initialize its proxy, or recover a
  partially provisioned namespace.
- **Verify first.** Characterize `importProject`, service lookup, environment
  writes, pipeline triggering, and failure/retry behaviour with a recording fake
  API. Reconfirm which proxy inputs are configuration versus secrets.
- **Scope.** Move/generalize the apps topology factory into the Zerops provider
  boundary. Add a versioned Zerops namespace codec containing project and proxy
  coordinates plus placement/resource policy. Provision through the project
  import endpoint, resolve the created proxy service, write an empty fail-closed
  manifest plus IAM URL/key, and trigger the pinned Fabrika `proxy` setup from a
  configured source. Make retries converge after interruption. Support adopting
  an existing project only after validating its proxy and isolation invariants.
- **Acceptance / witness.** Provider tests prove create, retry after each
  mutation boundary, reconcile, adopt, missing/wrong proxy rejection, no secret
  logging, and fail-closed empty proxy startup. Generated topology artifacts
  remain reproducible.
- **Touch points.** `packages/provider-zerops/`, `deploy/zerops/topology.ts`,
  `deploy/zerops/setups.ts`, `packages/control/src/node/provider.ts`.

### WU5 — Enforce namespace service ownership (effort L)

- **Problem.** Zerops imports intentionally use `override: true`; a hostname
  collision in a shared project can therefore mutate a service owned by another
  app.
- **Verify first.** Demonstrate the collision with two manifests targeting the
  same fake project and record every reserved namespace hostname.
- **Scope.** Derive resource claims from the validated manifest before any
  provider mutation. Reserve `proxy` and namespace-owned services. Persist
  `(namespace, provider resource key) → app/environment` claims atomically.
  Require deterministic app prefixes for cheap and mid shared namespaces; add an
  authoring helper that respects Zerops' 25-character lowercase-alphanumeric
  hostname limit. Full exclusive namespaces may use unprefixed app service names.
  Do not automatically release or delete a removed service claim.
- **Acceptance / witness.** Concurrent registration tests prove only one
  claimant wins. Cross-app override, reserved-name use, illegal prefix, and
  manifest drift fail before the Zerops API is called. The owning app can
  idempotently redeploy its existing services.
- **Touch points.** `packages/provider-contract/`,
  `packages/provider-zerops/src/authoring.ts`,
  `packages/provider-zerops/src/manifest.ts`, control registry/DB code and tests.

### WU6 — Deliver the cheap shared-PostgreSQL preset (effort L)

- **Problem.** App-owned databases cover mid/full placement, but no namespace
  resource model can provision and safely reserve a shared PostgreSQL service.
- **Verify first.** Validate a topology containing `proxy`, a managed PostgreSQL
  service, and two prefixed app runtimes against the checked-in Zerops schema.
  Confirm `${postgres_connectionString}` resolves as a service-variable
  reference without exposing its value to fabrika.
- **Scope.** Add an opt-in namespace-owned PostgreSQL resource named `postgres`.
  Default production to `postgresql:ha@18` and non-production to
  `postgresql:single@18`, while allowing an explicit supported type/profile.
  Reserve its hostname and expose a typed authoring declaration for apps that
  consume the shared binding. Keep the connection value in Zerops: app
  `zerops.yaml` uses `${postgres_connectionString}` directly. Add cheap, mid, and
  full example fixtures; mid keeps an app-prefixed database service and full
  places the same app services in an exclusive project.
- **Acceptance / witness.** Schema and provider tests prove two cheap apps bind
  to one namespace PostgreSQL service, cannot redefine it, and never persist or
  log its connection string. Mid proves two app-owned database services coexist
  without collision. Full proves a project contains only proxy plus one app's
  services.
- **Touch points.** `packages/provider-zerops/`, `deploy/zerops/`,
  `examples/zerops-app/`, provider/control integration tests.

### WU7 — Route lifecycle and proxy work through namespaces (effort M)

- **Problem.** Deploy, proxy synchronization, secrets, cancellation, and
  reconciliation currently decode project coordinates directly from the app
  target.
- **Verify first.** Pin the current operation ordering and failure behaviour for
  deploy and proxy roll with provider fakes.
- **Scope.** Resolve namespace coordinates once at the control-provider boundary.
  Compile proxy manifests by namespace identity, then roll that namespace's
  proxy before app deploy. Keep app secret writes addressed to the app deploy
  service. Carry namespace context through cancellation and reconciliation
  without teaching shared lifecycle code about Zerops projects or tiers.
- **Acceptance / witness.** End-to-end control tests cover two apps in one
  namespace, one app in an exclusive namespace, independent proxy manifests,
  shared-PostgreSQL placement, cancellation, restart reconciliation, and
  fail-closed namespace mismatch. Shared import-graph tests still reach no
  concrete provider.
- **Touch points.** `packages/provider-contract/`,
  `packages/provider-zerops/src/control.ts`,
  `packages/control/src/run-lifecycle.ts`,
  `packages/control/src/zerops-proxy.ts`, reconciliation tests.

### WU8 — Make namespaces operable and close the documentation (effort M)

- **Problem.** A provider capability without an operator surface leaves project
  IDs, tier selection, and recovery hidden behind raw API envelopes.
- **Verify first.** Walk the current onboarding and app-environment dashboard
  flows and the `fabrika-zerops` CLI argument/error conventions.
- **Scope.** Add CLI commands for namespace plan/create/adopt/reconcile and a
  dashboard namespace list/detail/create flow. Present cheap, mid, and full as UI
  presets resolved to explicit placement/resource fields. Let app-environment
  editing select a compatible namespace. Show provisioning state and actionable
  manual custom-domain instructions. Update living architecture, portability,
  and Zerops references.
- **Acceptance / witness.** Offline CLI tests verify plans and fail without
  required coordinates before network access. Dashboard tests cover preset
  payloads and assignment filtering. `format:check`, `lint`, full workspace
  typecheck, full tests, generated-artifact checks, and docs lint pass.
- **Touch points.** `packages/provider-zerops/src/cli*`,
  `packages/dashboard/`, `docs/reference/`, `docs/INDEX.md`.

## Out of scope (explicit)

- Moving an already-deployed app or its data between namespaces. Assignment
  changes after a successful deploy are rejected until a separate migration
  workflow can copy data, switch domains, and retire old services safely.
- Automatic namespace/project deletion and service cleanup. These are
  destructive operations; this sprint provisions and reconciles but does not
  infer that an absent manifest authorizes deletion.
- Per-app PostgreSQL databases, users, or credentials inside the cheap shared
  service. Cheap deliberately shares the provider-issued connection credential;
  applications may isolate their own schemas, while mid/full provide physical
  database-service isolation.
- Automated Zerops custom-domain binding. The checked import schema has no custom
  domain field; the UI/CLI reports the required manual step rather than inventing
  an unverified API.
- Real-account claims about Zerops behaviour. Local/fake/schema witnesses land
  here; the credentialed bring-up remains
  [`../backlog/05-bring-up-on-a-real-zerops-account.md`](../backlog/05-bring-up-on-a-real-zerops-account.md).

## Decisions

The durable rationale and binding ownership rules are ratified by
[ADR-0014](../decisions/0014-provider-owned-deployment-namespaces.md).

- One deployment namespace is one provider-owned placement boundary. On Zerops,
  it maps one-to-one to a project and owns exactly one proxy.
- The `platform` project is not an app namespace. Global IAM, control, their
  database, and run storage remain there.
- Cheap/mid/full are operator presets, not a closed enum in the neutral provider
  contract.
- Shared namespace resources belong to the namespace. App imports may reference
  them but may not declare or override them.
- Cheap shares one physical PostgreSQL service and its provider-issued
  connection credential. Mid and full use app-owned database services.
- Namespace assignment belongs to the registry, not to app source config.
- Existing data receives an explicit migration; no dual-read compatibility path
  remains after it.

## Sequencing

1. WU1 fixes the contract before schema or API work.
2. WU2 establishes the namespace and claim primitives.
3. WU3 and WU4 can proceed in parallel against that contract.
4. WU5 must land before shared-project deploys are enabled.
5. WU6 builds PostgreSQL presets on namespace provisioning and claims.
6. WU7 integrates the runtime lifecycle after WU3-WU6.
7. WU8 closes operator surfaces, verification, and living documentation.

## Run log

<!-- Append as work proceeds. Graduate durable decisions to ADRs and new deferred
     work to backlog items. -->

- 2026-07-29 — User requested opt-in Zerops namespaces with cheap, mid, and full
  isolation, and explicitly included shared PostgreSQL in sprint scope.
- 2026-07-29 — WU1 ratified namespace ownership, isolation presets, shared
  PostgreSQL semantics, and migration restrictions →
  [ADR-0014](../decisions/0014-provider-owned-deployment-namespaces.md).
- 2026-07-29 — The public Zerops project response does not expose
  `envIsolation`; reconciliation therefore reapplies observable service-level
  isolation. Public documentation also does not establish an immutable
  `buildFromGit` revision pin.
- 2026-07-29 — WU2-WU8 shipped the open namespace contract, atomic ownership
  claims, all three Zerops presets, target v2, namespace-routed lifecycle, and
  operator API, CLI, and dashboard surfaces.
