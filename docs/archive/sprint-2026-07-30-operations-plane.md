> **OUTCOME — shipped 2026-07-30.** Fabrika now has an independent Operations
> plane for Sentry-compatible error ingest, portable processing and persistence,
> scoped triage, deploy-owned releases, source maps, active health checks, and a
> third workspace in the unified console. Cloudflare and Bun/Zerops composition
> roots install the service. Explicit application public origins feed active
> health without conflating them with provider routing domains. Release
> reconciliation survives control restarts and keeps the latest observed retry
> as the commit summary. The local stack proves managed ingest, release
> projection, issue persistence, queued-work recovery, and private-network
> isolation. The Zerops composition remains validated locally and against
> published schemas, not a real account.
>
> **Commit map.** WU1 → `02e9b8a`; WU2 → `846d222`, `b3580aa`, `2333dcf`; WU3 →
> `b552c31`, `dbf2fa3`, `b27754f`, `e4879a2`, `028b4fb`; WU4 → `5082ddb`,
> `0a8cc20`, `dcbf81e`, `fff19b2`, `81e23bf`, `3ab0065`; WU5 → `9fc3624`,
> `81e23bf`, `1a997ed`, `ab0f6ce`; WU6 → `6af4f8f`, `23905fd`, `cddfa89`;
> WU7 → `77eb5d3`, `b27754f`, `dbf2fa3`, `e4879a2`, `cf1dedf`, `d52d24f`;
> WU8 → `1df9cc6`, `e4879a2`, `4827afd`, `1ef9541`; WU9 migration decision,
> implementation, and final verification fixes → `cf17797`, `eacc01d`,
> `9c858f0`, `10deffd`.
>
> **Closure hardening.** Control models `publicOrigin` explicitly and projects it
> without deriving it from a provider domain. Bun migration runners compose
> reusable `platform-node` bundles into service-owned, bundle-qualified ledgers.
> Operations mounts the private release-reconcile route, forces secure browser
> session cookies from configured public-host state behind TLS-terminating
> proxies, and bounds and revalidates HTTPS-only webhook delivery. Provider
> restart reconciliation completes terminal run and release state. A commit
> summary follows its latest observed retry without collapsing distinct run
> links. Commit `1ef9541` extends the local smoke through managed configuration,
> ingest, persistence, duplicate delivery, restart, and network-isolation
> witnesses. DNS resolution/rebinding remains deferred rather than claimed
> secure.
>
> **Verification.**
>
> - **Final post-fix gate:** all 30 workspace typechecks passed. The full
>   `bun test` run reported 1,287 pass, 134 skip, 0 fail, and 4,700 expectations
>   across 1,421 tests in 154 files. The skips are the opt-in PostgreSQL and S3
>   suites, not passing backend evidence.
> - **Static checks:** lint exited 0 after checking 553 files, with 0 errors, 6
>   warnings, and 353 informational findings. `format:check` and
>   `git diff --check` passed.
> - **Real PostgreSQL 17:** the explicit backend suites reported 123 pass, 0
>   fail, and 505 expectations. A later focused post-fix migration proof
>   reported 14 pass, 0 fail, and 66 expectations. These runs overlap and are
>   not summed as a unique total. The Operations legacy case recognized seven
>   qualified migration identities; its later regression proves that only
>   `platform-node/0001_jobs.sql` is fresh and asserts the exact CLI message.
> - **Real MinIO:** 9 pass, 0 fail, and 18 expectations. Verification cleanup
>   left zero test containers.
> - **Generated Zerops artifacts:** `gen:check` validated all five schemas, and
>   the platform plan validated all five generated artifacts. This is schema
>   evidence, not a real-account deploy.
> - **Cloudflare:** Wrangler dry-runs passed for control
>   (333.36 KiB / 73.55 KiB gzip), Operations
>   (385.87 KiB / 80.28 KiB gzip), and runner
>   (63.77 KiB / 16.64 KiB gzip). Runner emitted only the expected warning that
>   the development instance type was renamed to `lite`.
> - **Offline and local compositions:** the control offline verifier passed all
>   six plan steps without cloud mutation. `local:reset`, `local:smoke`, and
>   `local:down` passed; the smoke completed run
>   `019fb472-e18f-7027-b471-b54290cb4fad`.
> - **Docs:** dprint and diff checks passed. The agent-docs lint reported only
>   the known ignored compatibility symlink `docs/AGENTS.md -> CLAUDE.md`.
> - **Not executed:** browser/official-Sentry-SDK proof remains
>   [the Operations adoption proof](sprint-2026-07-31-operations-adoption-proof.md);
>   Zerops source-map publication and a credentialed real-account deployment
>   remain [backlog 36](../backlog/36-complete-zerops-release-artifact-correlation.md)
>   and [backlog 05](../backlog/05-bring-up-on-a-real-zerops-account.md).
>
> **Backlog closed.** Items 27–33 were consumed. Remaining proof is tracked in
> [the later adoption proof](sprint-2026-07-31-operations-adoption-proof.md) and
> [36](../backlog/36-complete-zerops-release-artifact-correlation.md); remaining
> activation and egress hardening is tracked in
> [37](../backlog/37-activate-zerops-managed-environment-transactionally.md) and
> [38](../backlog/38-add-dns-safe-operations-egress.md). A real
> Zerops account remains [05](../backlog/05-bring-up-on-a-real-zerops-account.md);
> live state adoption and standalone Poplach retirement remain
> [34](../backlog/34-retire-standalone-poplach.md). Logs, general-purpose
> metrics, traces, incidents, provider telemetry unavailable at the foundation
> boundary, and a portable email transport remain outside this shipped slice.

# Sprint — Operations plane foundation (2026-07-30)

**Goal.** Ship the first portable Operations plane by absorbing Poplach as
Fabrika-native Errors, binding it to Delivery releases and Access identities,
and proving the integrated service on the Cloudflare and Bun/Zerops
compositions.

**Theme.** Runtime feedback becomes a first-party platform capability without
turning control into a telemetry service. The batch consumes
backlog 27–33: preserve Poplach's
useful Sentry-replacement behaviour, replace its duplicate project model, add
release and health context, mount one Operations console surface, and supply
both runtime implementations. Credentialed adoption of any live standalone
installation remains [backlog 34](../backlog/34-retire-standalone-poplach.md).

## Refs re-verified at HEAD (2026-07-30)

- ✔ The Poplach source tree is clean at `8e0c79d`; local `main` is four commits
  ahead of `origin/main`. The captured source still imports `@trasa/core`,
  `@propustka/client`, `@propustka/core`, and `vozka-config` —
  `../poplach/package.json:14-23`.
- ✔ One Poplach Worker currently serves typed RPC, open source-map upload,
  Sentry-envelope ingest, SPA assets, the queue consumer, and scheduled alert
  detection — `../poplach/src/worker.ts:1-70`.
- ✔ Poplach is Cloudflare-shaped at its composition root: D1, KV, R2, Queues,
  two Analytics Engine datasets, Email Routing, cron, assets, and an IAM
  service binding — `../poplach/vozka.config.ts:43-100`.
- ✔ Its domain surface is already substantial: eleven migrations preserve
  issue activity, regressions, snooze, merge, alert rules, notification
  channels, and the IAM-directory retirement; sixteen browser scenarios cover
  sign-in, ingest, grouping, triage, source maps, alerts, access, and project
  setup — `../poplach/migrations/` and `../poplach/tests/browser/`.
- ✔ Poplach already has an honest occurrence-count seam with local/D1 and
  Analytics Engine implementations. `CountStore` owns record, aggregate,
  bucket series, and total operations — `../poplach/src/lib/count-store.ts:19-85`;
  the AE implementation is selected explicitly in production —
  `../poplach/src/lib/count-store.ts:224-379`.
- ⚠ The current DSN key is explicitly a Sentry **public key** and may ship in
  browser bundles. The endpoint is effectively open, so payload and queue-size
  caps are already load-bearing — `../poplach/src/api/ingest.ts:33-46` and
  `../poplach/src/lib/ingest.ts:67-86`. The integrated design must not pretend
  this credential can be kept secret.
- ⚠ Source-map upload is currently unauthenticated and keyed only by caller-
  supplied `release` and `file`; it writes directly to R2 —
  `../poplach/src/api/ingest.ts:177-207`. This surface cannot survive the
  integrated release model.
- ⚠ Poplach creates its own `projects` and stores recoverable DSN keys in both
  SQL and KV — `../poplach/src/rpc/procedures/projects.ts:45-69`. Its project
  and `project.read` scope are duplicate authorities once Delivery owns the
  application environment.
- ✔ `@fabrika/app` now exposes runtime-neutral routing, typed RPC, errors,
  middleware contracts, and the browser client, with explicit Bun and
  Cloudflare entrypoints — `packages/app/package.json:18-33` and
  `packages/app/src/index.ts:4-37`.
- ✔ The shared runtime already supplies SQL, blob, queue-producer, HTTP-service,
  asset, and background-work ports; the Bun implementation set supplies
  Postgres, S3, a Postgres job consumer, filesystem assets, and supervised
  background work — `packages/platform/src/ports.ts:12-59` and
  `packages/platform-node/src/index.ts:1-27`.
- ✔ Repository operations, not individual SQL strings, are the accepted
  portability seam. Composition roots may replace one complete capability, and
  divergent implementations need the same real-backend behaviour contract —
  [ADR-0015](../decisions/0015-repository-operations-are-the-sql-portability-seam.md).
- ✔ Control already provides the required same-origin gateway pattern: it
  transports `/iam/admin/*` through an `HttpService`, preserves IAM ownership,
  rejects cross-origin mutations, and maps an IAM 401 to the public login URL —
  `packages/control/src/routes.ts:39-47` and
  `packages/control/src/iam-admin.ts:4-54`.
- ✔ The console currently hard-codes Delivery and Access as its two navigation
  sections and derives the current plane from the URL —
  `packages/dashboard/src/routes/_layout.tsx:7-67`. Its overview reads both
  services concurrently and tolerates an unavailable or forbidden Access plane
  — `packages/dashboard/src/routes/index.tsx:19-40`.
- ✔ Control is the canonical source for application and environment ids and
  stores provider target/artifact data as opaque envelopes —
  `packages/control/src/db.ts:17-42`. There is no provider-neutral service
  catalog today; shared Operations code must not parse a provider payload to
  invent one.
- ✔ A deploy run already records `app_id`, `env`, `ref`, resolved `commit_sha`,
  provider operation id, and terminal timestamps —
  `packages/control/src/db.ts:132-151`. The lifecycle has one terminal
  transition after provider execution — `packages/control/src/run-lifecycle.ts:255-277`.
- ✔ The Zerops platform project currently contains proxy, IAM, control, shared
  PostgreSQL, and private object storage; Operations belongs in this platform
  trust/failure boundary, not an application namespace —
  `packages/installation-zerops/zerops/topology.ts:113-197`.
- ✔ The full local stack already exercises IAM, control, Postgres, MinIO,
  proxies, an app namespace, a deployed example app, restart reconciliation,
  and network isolation — `packages/local-stack/compose.yaml:9-243` and
  `packages/local-stack/src/smoke.ts:108-239`. It is the end-to-end witness to
  extend rather than creating a second harness.
- ⚠ No evidence in this repository establishes whether a live Poplach
  installation exists or which state must be retained. No destructive cutover
  or repository retirement may be inferred from the code import.

## Work units

### WU1 — Import a parity-preserving Operations kernel (effort L)

- **Problem.** Poplach is outside the workspace and tied to predecessor package
  names, but its error parsing, grouping, triage, source-map resolution, alerts,
  and browser scenarios are the only complete behaviour specification.
- **Verify first.**
  1. Record the exact Poplach source commit and file inventory.
  2. Run its typecheck and a fresh seeded browser suite before moving code; do
     not trust the existing `.lopata/` database because its applied migrations
     may lag the source.
  3. Classify each file as domain, browser contract, UI, Cloudflare adapter,
     fixture, or obsolete standalone deployment.
- **Scope.**
  1. Create `@fabrika/operations`, `@fabrika/operations-contract`, and
     `@fabrika/operations-ui` package boundaries.
  2. Import the Poplach domain and fixtures from the recorded commit.
  3. Replace `@trasa/core` with `@fabrika/app` and `@propustka/*` with
     `@fabrika/auth`; use standard-schema validation without casts or compatibility
     shims.
  4. Keep the direct ingest API separate from the authenticated operator API.
  5. Convert server-derived browser types into the browser-safe contract package.
  6. Preserve current error parsing, fingerprinting, grouping, event detail,
     source-context resolution, issue mutations, activity, and alert semantics.
- **Acceptance / witness.**
  - Every imported pure/domain test passes under the workspace.
  - A source-inventory check accounts for every Poplach `src/`, migration,
    seed, and browser-test file as migrated, replaced, or explicitly deferred.
  - No workspace package imports `@trasa/*`, `@propustka/*`, or `vozka-config`
    for the Operations implementation.
  - `bun run --filter @fabrika/operations typecheck` and contract/UI typechecks
    pass with no casts, `any`, or suppression comments.
- **Touch points.** New Operations packages, root workspace lockfile,
  `packages/app/`, `packages/auth/`, and `../poplach/` as read-only source.

### WU2 — Make storage and asynchronous processing portable (effort XL)

- **Problem.** Poplach domain code reaches D1, KV, R2, Queue, Analytics Engine,
  Email Routing, and Cloudflare analytics directly. The existing SQL text also
  contains SQLite-specific `INSERT OR IGNORE`, `AUTOINCREMENT`, and
  `unixepoch()` assumptions. A Bun process cannot honestly satisfy that shape.
- **Verify first.**
  1. Trace every binding use and every SQL operation from request to scheduled
     work.
  2. Group persistence by complete capabilities: sources/credentials,
     issues/activity, occurrences, alerts/channels, dedup claims, releases, and
     health.
  3. Identify which operations are portable over `SqlDatabase`, which require
     SQLite/Postgres variants under ADR-0015, and which are signal-store ports.
  4. Measure the existing ingest hot path before adding a SQL lookup or synchronous
     write.
- **Scope.**
  1. Define one runtime-neutral Operations environment and focused repository
     bundle.
  2. Use `BlobStore` for raw event bodies and source maps and `JobQueue` for
     accepted ingest. Keep consumer lifecycle runtime-specific.
  3. Keep occurrence aggregation behind a domain port. Supply Analytics Engine
     and SQL/Postgres implementations with the same idempotency, aggregate,
     series, and total contract.
  4. Replace KV-only alert deduplication with an atomic claim operation; do not
     widen a generic platform port for a single-domain cache.
  5. Store a durable dead-event index instead of requiring `BlobStore.list`,
     whose current port deliberately has no listing surface.
  6. Add separate D1/SQLite and Postgres migrations. Generate UUIDv7 ids and
     timestamps caller-side.
  7. Add Cloudflare queue/DLQ/cron adapters and a Bun
     `PostgresJobConsumer`/scheduler composition with equivalent retry and
     abandonment behaviour.
  8. Never log an envelope, DSN key, webhook target containing credentials, or
     an error object that may embed them.
- **Acceptance / witness.**
  - Shared repository contract tests pass against real D1/SQLite and real
    Postgres; count-store contract tests pass against the configured CF adapter
    double and Postgres.
  - A duplicate queue delivery does not duplicate an occurrence, issue activity,
    regression, or notification.
  - Raw payload and source-map tests pass against R2-compatible and S3/MinIO
    implementations.
  - Killing and restarting the Bun consumer preserves queued work and retries.
  - An entrypoint-isolation test proves shared Operations code imports neither
    Cloudflare nor Bun/Node runtime modules.
- **Touch points.** `packages/operations/`, `packages/platform/`,
  `packages/platform-node/`, Operations migrations, and backend integration
  fixtures.

### WU3 — Project the Delivery catalog and Access policy into Operations (effort L)

- **Problem.** Poplach's local project catalog and `project.read` authorization
  duplicate Fabrika's application/environment registry and cannot represent
  deploy correlation without drift.
- **Verify first.**
  1. Trace every control registry create/update/delete path and its retry
     behaviour.
  2. Verify how one IAM token can carry Operations actions over the existing
     `app` and `environment` scope dimensions.
  3. Confirm that no provider-neutral service id exists before adding a
     `service` coordinate.
- **Scope.**
  1. Define a versioned Operations source coordinate with canonical `appId` and
     `environment`; allow a stable optional service key, defaulted by the source
     contract rather than decoded from provider envelopes.
  2. Add `operations.read`, `operations.triage`, and `operations.manage` actions
     over Fabrika's existing app/environment scopes. Remove Poplach project
     creation and the `project.read` vocabulary.
  3. Add a narrow private control-to-Operations service contract.
  4. Reconcile a complete, idempotent catalog projection from control after
     registry changes and during scheduled maintenance. A transient Operations
     outage must not roll back a successful registry mutation; drift remains
     visible and the next pass repairs it.
  5. Represent deletion as a disabled/tombstoned source until retention policy
     permits cleanup; never silently orphan issue history.
  6. Resolve assignees from IAM principals and emit IAM audit events for triage,
     rule, channel, and source-management mutations.
- **Acceptance / witness.**
  - Contract tests prove create/update/disable/re-enable reconciliation is
    idempotent and recovers after Operations downtime.
  - A renamed app display value does not change source identity or detach issues.
  - Scoped principals see and mutate only permitted app environments; assignment
    labels survive later IAM principal deletion.
  - Shared control and Operations code treat provider envelopes as opaque.
- **Touch points.** Operations contract/service, `packages/control/`,
  `packages/control-contract/`, control maintenance, IAM schema/actions, and
  authorization tests.

### WU4 — Provision and protect Sentry-compatible ingest (effort L)

- **Problem.** Operators currently create a Poplach project, copy a DSN, and
  configure each application manually. The DSN key is client-visible by design,
  while the present KV mapping and project path are Poplach-specific.
- **Verify first.**
  1. Drive the bundled Sentry demo and at least one browser SDK through the
     existing endpoint to freeze the required envelope and auth compatibility.
  2. Separate client-visible DSN material from genuinely secret server-to-server
     credentials before choosing a provider storage path.
  3. Trace provider var/secret assembly and reserved-name collision behaviour on
     Cloudflare and Zerops.
- **Scope.**
  1. Generate a high-entropy, source-scoped write credential caller-side. Store
     only its verifier in Operations; expose the DSN as configuration and never
     describe it as confidential.
  2. Reserve provider-neutral Fabrika environment keys for the ingest DSN and
     source coordinates and inject them during registration/reconciliation.
  3. Support explicit rotation and revocation, including an overlap window for
     safe rollout.
  4. Authenticate the source before enqueueing and enforce source binding,
     payload limits, queue limits, per-source rate limits, and safe 4xx/503
     retry semantics.
  5. Keep Sentry-envelope compatibility at the current Poplach level; unsupported
     envelope item kinds are rejected or ignored explicitly.
  6. Add a minimal application helper/example without requiring applications to
     target a different cloud provider.
- **Acceptance / witness.**
  - Registration produces a working DSN for both provider assemblies without a
    separate project-creation action.
  - The Sentry demo sends an exception, receives 202, and the asynchronous
    consumer produces exactly one grouped issue.
  - Wrong-source, revoked, expired-overlap, oversized, malformed, and rate-
    limited requests return the specified status and do not enqueue.
  - No request log, deploy log, API error, or persisted Operations row contains
    the raw credential.
- **Touch points.** Operations ingest and credential repositories, control
  registry/reconciliation, provider deploy input assembly, examples, and
  application-facing documentation.

### WU5 — Correlate deploy releases and secure source maps (effort L)

- **Problem.** Poplach trusts event-provided release strings and accepts source
  maps on an open endpoint. Control already knows the app, environment, run,
  ref, commit, and provider outcome, but does not publish that lifecycle to
  Operations. The two provider build paths expose source-map artefacts at
  different moments.
- **Verify first.**
  1. Trace source resolution, build, and artefact availability end to end for
     the Cloudflare runner and the Zerops manifest/pipeline path.
  2. Verify whether each path can upload files before changing a provider or
     runner contract.
  3. Confirm the missing-commit and dry-run semantics.
- **Scope.**
  1. Key a release by application environment plus immutable commit; link every
     deploy run separately so retries and redeploys remain visible.
  2. Reconcile run start, provider acceptance, and terminal state through the
     private Operations contract. Operations downtime must not fail delivery;
     scheduled replay repairs missing release state.
  3. Stamp the release into managed application configuration so events use the
     same identity.
  4. Replace the open source-map endpoint with a bounded, authenticated
     release-artefact upload. Use a run/release-scoped upload credential, not the
     public ingest DSN.
  5. Add provider-correct upload hooks only where artefacts actually exist.
     Record `incomplete` release artefacts rather than failing an otherwise
     successful deploy when Operations is unavailable.
  6. Show the introducing deploy, commit, release health, new issues, and
     regressions on issue, release, and Delivery run views.
- **Acceptance / witness.**
  - Two deploys of different commits create distinct releases; a retry of one
    run does not duplicate either release or source maps.
  - A new issue and a regression link to the correct release and deploy run.
  - Source maps cannot cross app/environment/release boundaries and an
    unauthenticated upload is rejected.
  - A minified seeded error resolves to original frames on both runtime
    compositions.
  - Deploy succeeds during an Operations outage and reconciliation later fills
    the missing release state while clearly reporting incomplete artefacts.
- **Touch points.** Operations releases/source maps, control run lifecycle and
  maintenance, provider contracts and implementations, runner transport and
  container where required, CLI/build integration, and Delivery/Operations UI.

### WU6 — Add portable service and telemetry health (effort L)

- **Problem.** Poplach's status page derives useful issue and throughput state,
  but live queue/reject metrics call Cloudflare APIs directly. It does not
  actively answer whether a deployed application endpoint is healthy.
- **Verify first.**
  1. Separate facts derivable from Operations stores from provider API facts.
  2. Verify egress and public-domain reachability from the Cloudflare Worker and
     the isolated Zerops platform project.
  3. Audit email delivery options before selecting a Bun implementation; do not
     invent an unapproved vendor dependency.
- **Scope.**
  1. Preserve processed-count, freshness, DLQ, reject, and queue-health
     observations behind provider/runtime adapters.
  2. Add configured HTTP health checks against the environment's public domain
     with explicit interval, timeout, expected status, and bounded response
     handling.
  3. Store current state plus bounded history and define healthy, degraded,
     failed, stale, and unavailable semantics.
  4. Generalize alert rules and atomic dedup claims across new issue, regression,
     spike, failed check, recovery, and unhealthy telemetry.
  5. Keep portable webhook delivery. Add email only after a runtime-neutral
     transport and both compositions are proven; otherwise retain it as an
     explicit follow-up instead of silently dropping or faking it.
  6. Surface per-environment health in Operations and a compact installation
     summary.
- **Acceptance / witness.**
  - Deterministic scheduler tests prove failure thresholds, recovery, staleness,
    deduplication, and no alert storms.
  - Local smoke toggles a target endpoint from healthy to failed to recovered
    and observes one alert per transition.
  - Cloudflare and Bun adapters return the same health contract when provider
    metrics are available and an explicit unavailable state when they are not.
  - Notification failures never roll back an issue, occurrence, or health
    observation and never leak the target credential.
- **Touch points.** Operations health/alerts/UI, provider health adapters,
  scheduler composition, notification transport, and dashboard overview.

### WU7 — Compose Operations into the unified console (effort L)

- **Problem.** Poplach ships a complete second shell and SPA. Fabrika's console
  currently assumes two planes, while the correct service boundary requires
  Operations to retain authorization and API ownership.
- **Verify first.**
  1. Inventory Poplach route ids, URLs, accessible labels, test ids, and visual
     primitives before moving them.
  2. Re-run Buzola route generation after the concurrent Access-route work at
     HEAD; do not copy stale generated routes.
  3. Trace the IAM gateway's cookie, CSRF, login-bounce, and failure-isolation
     behaviour as the model to preserve.
- **Scope.**
  1. Make `@fabrika/operations-ui` a feature package with Errors, Releases,
     Health, alert, and channel routes under `/operations/*`; it owns no app
     shell or build.
  2. Add Operations as the third console navigation plane and update copy that
     currently says “both planes”.
  3. Add `/operations/api/*` as a same-origin control gateway to the private
     Operations operator API. Operations authenticates, authorizes, and audits;
     control only transports.
  4. Do not route ingest or release-artefact upload through the console gateway.
  5. Replace project creation/detail context with Fabrika
     application/environment context.
  6. Treat an unavailable or forbidden Operations service as an isolated
     feature failure; Delivery and Access remain usable.
- **Acceptance / witness.**
  - Browser tests navigate among all three planes and exercise issue
    list/detail, filters, bulk status, comment, assign, snooze, merge, alerts,
    release links, and health.
  - A scoped user cannot infer issue counts, DSNs, alert targets, or release
    details from an unauthorized environment.
  - Cross-origin mutations are rejected and an unauthenticated browser receives
    the correct login bounce.
  - Stopping Operations produces a bounded Operations/overview unavailable state
    while Delivery and Access routes continue to work.
- **Touch points.** `packages/operations-ui/`, `packages/dashboard/`,
  `packages/control/src/routes.ts`, Cloudflare and HTTP service gateways, route
  generation, and browser tests.

### WU8 — Install Operations on Cloudflare, Zerops, and the local stack (effort XL)

- **Problem.** A service package is not a platform feature until installation,
  migrations, private operator connectivity, public ingest, queues, scheduling,
  storage, secrets, deploy ordering, and recovery exist on both supported
  compositions.
- **Verify first.**
  1. Materialize the proposed Cloudflare graph in dry-run before committing
     binding names or workflow order.
  2. Compile the proposed Zerops topology against the checked-in schema and
     verify project cost/isolation consequences.
  3. Confirm public-host routing can expose ingest without making the private
     operator API reachable.
- **Scope.**
  1. Add the Operations Cloudflare Worker graph with its own D1, R2, ingest/DLQ
     queues, Analytics Engine datasets where retained, cron, IAM binding, and
     public ingest domain.
  2. Deploy Cloudflare in dependency order: IAM → Operations → runner/control,
     so control's Operations service binding always resolves.
  3. Add an `operations` Bun service to the Zerops platform project, a separate
     Postgres database/schema, private object-storage bucket coordinates, job
     consumer, scheduler command, private control route, and public ingest route
     through the platform proxy.
  4. Extend installation plans, generated artefacts, migration commands, setup
     secrets, and health checks without publishing from localhost.
  5. Add Operations, its database, bucket, consumer, routing, and environment
     generation to `@fabrika/local-stack`.
  6. Extend local smoke through registration → managed DSN → deploy → envelope
     ingest → queue processing → issue query → release correlation → source-map
     resolution → health transition → Operations restart recovery.
- **Acceptance / witness.**
  - Cloudflare resource generation and `wrangler deploy --dry-run` recognize
    every binding, route, migration, queue consumer, asset dependency, and
    service binding.
  - Zerops provisioning and steady-state documents validate and preserve the
    platform/app network isolation invariants.
  - The extended local smoke passes from a reset state and after killing and
    restarting Operations with queued work in flight.
  - No application service can reach the Operations private operator API, while
    its configured public ingest endpoint remains reachable.
- **Touch points.** Operations composition roots,
  `packages/installation-cloudflare/`, `packages/installation-zerops/`,
  `packages/installation-zerops/zerops/`, root `zerops.yaml`,
  `packages/local-stack/`, control bindings, generated artefacts, and CI
  templates.

### WU9 — Prove the basic plane and close the consumed backlog (effort M)

- **Problem.** The migration touches security boundaries, two databases, two
  queue implementations, provider deployment, the unified console, and a
  high-volume public endpoint. Package-local green tests are not sufficient
  evidence.
- **Verify first.**
  1. Re-read every acceptance witness in backlog 27–33 and map it to a command
     or browser observation.
  2. Confirm which Postgres/S3 suites would otherwise skip and run them against
     the local stack's real services.
  3. Confirm generated Cloudflare and Zerops artefacts have no uncommitted drift.
- **Scope.**
  1. Run focused Operations contracts and browser scenarios throughout the
     sprint.
  2. Run the complete typecheck and test suites under a CPU lease, with real
     Postgres/S3 Operations integration enabled.
  3. Run lint, format check, generated-artifact checks, package-boundary tests,
     Cloudflare dry-run, Zerops schema validation, and the extended local smoke.
  4. Update `docs/reference/overview.md`, portability and local-development
     references, package manuals, examples, and public configuration docs.
  5. Archive this sprint with its closure header and commit map. Delete backlog 27–33
     only when their individual witnesses pass; keep or rescope any honest
     remainder.
- **Acceptance / witness.**
  - `cpu-lease run -n 4 -- bun run typecheck` passes every workspace package.
  - `cpu-lease run -n 4 -- bun test` passes with Operations Postgres/S3 suites
    actually executed, not skipped.
  - `bun run local:smoke`, lint, format check, generated-artifact validation,
    `git diff --check`, and the Cloudflare dry-run all pass.
  - The archived closure record reports exact test counts, skipped external suites,
    generated artefacts, commit mapping, and any deferred cutover work.
- **Touch points.** Repository-wide verification, `docs/reference/`, package
  manuals, examples, sprint/archive indexes, and backlog 27–33.

## Out of scope (explicit)

- Logs, general-purpose application metrics, distributed traces, custom
  dashboards/query languages, and incident management remain in
  [the broad Operations idea](../ideas/operations-plane.md). Pipeline counters
  required to operate Errors are not a commitment to a metrics product.
- Compatibility with all Sentry APIs or envelope item kinds. The witness is the
  current Poplach error-event contract plus explicitly chosen SDK examples.
- A provider-neutral application service catalog. The first source coordinate is
  application + environment with an optional stable service key; shared code
  does not decode provider envelopes to infer topology.
- Making application code portable. Fabrika itself and the Operations service
  remain portable; deployed applications may use provider primitives.
- A credentialed production deploy or real Zerops validation. That remains
  [backlog 05](../backlog/05-bring-up-on-a-real-zerops-account.md).
- Migrating live Poplach data, switching production DSNs, deleting resources, or
  archiving the standalone repository. Those actions require a verified
  installation inventory and explicit cutover authority under
  [backlog 34](../backlog/34-retire-standalone-poplach.md).
- Selecting an external email vendor without an approved runtime-neutral
  transport. Portable webhooks are required; email is preserved only if both
  runtime compositions can support it honestly.

## Decisions

- [ADR-0016](../decisions/0016-independent-operations-plane.md) is the product
  and service boundary: Operations is the third plane, Errors is the first
  capability, and telemetry never traverses control storage or its synchronous
  API.
- The initial package set is `@fabrika/operations`,
  `@fabrika/operations-contract`, and `@fabrika/operations-ui`. Add a separate
  core package only when a real second consumer requires it.
- Control remains authoritative for application/environment and deploy-run
  coordinates. It pushes an idempotent full projection through the private
  Operations contract after mutations and during maintenance; Operations
  retains derived state and tombstones only.
- The source coordinate is application + environment with an optional stable
  service key. No shared code reads provider payloads to manufacture a service.
- The Sentry DSN contains a public, write-only source credential. Operations
  stores its verifier, applies rate/payload limits, and supports rotation; the
  design never relies on keeping browser-visible DSN material secret.
- A release is app + environment + immutable commit. Deploy runs link to that
  release separately, so retries and redeploys remain distinct.
- Operations availability never gates application registration or deployment.
  Catalog/release synchronization is idempotent and replayed; incomplete
  observability is visible rather than converted into a delivery failure.
- The operator API is private and reached through the same-origin control
  gateway. Ingest and release-artefact upload are separate authenticated data
  paths and never use that gateway.
- Repository-operation contracts follow ADR-0015. New generic platform ports
  require more than one domain consumer; Operations-only seams stay with
  Operations.
- [ADR-0017](../decisions/0017-service-owned-postgres-migrations.md) makes each
  Bun service's Postgres migration ledger bundle-qualified and service-owned.
  Operations composes the reusable `platform-node` job-queue bundle before its
  domain bundle.
- Any discovery that changes these durable cross-service or credential
  boundaries graduates to a new ADR before implementation continues.

## Sequencing

| Phase | Work                                                     | Dependency / parallelism                                                                       |
| ----- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1     | WU1 — import and parity                                  | First; establishes package and behaviour baseline.                                             |
| 2     | WU2 — portable data path · WU3 — registry/IAM projection | Parallel after WU1; agree on source/repository contracts first.                                |
| 3     | WU4 — managed ingest · WU6 — health/alerts               | WU4 needs WU2+WU3. WU6 needs WU2 and the source model; they can then run in parallel.          |
| 4     | WU5 — releases/source maps · WU7 — console               | WU5 needs WU3+WU4. WU7 can scaffold after WU3 and completes against WU4–WU6 contracts.         |
| 5     | WU8 — both installations and local stack                 | Start topology spikes after WU2; finalize only after WU3–WU7 settle their bindings and routes. |
| 6     | WU9 — full proof and closure                             | Last. No backlog deletion before its own witness passes.                                       |

Keep commits atomic by WU or a smaller independently green slice. Generated
route/topology artefacts land in the same commit as the source that changes them.
Do not start the credentialed cutover in backlog 34 from this sprint.

## Run log

- Postgres migration ownership and reusable dependency bundles →
  [ADR-0017](../decisions/0017-service-owned-postgres-migrations.md).
- Zerops does not yet publish source maps from its platform-owned build
  filesystem → [backlog 36](../backlog/36-complete-zerops-release-artifact-correlation.md).
- Zerops service variables are written before an asynchronous app version is
  known to be active → [backlog 37](../backlog/37-activate-zerops-managed-environment-transactionally.md).
- Syntax validation alone cannot stop DNS rebinding or private-address egress
  from webhooks and active health checks →
  [backlog 38](../backlog/38-add-dns-safe-operations-egress.md).
