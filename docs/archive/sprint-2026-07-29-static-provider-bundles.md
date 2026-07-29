# Sprint — Static provider bundles (2026-07-29)

## OUTCOME

Completed. Static provider bundles now span app authoring, runtime execution,
control capabilities, persistence, provider CLIs, and installation composition.
The shared config package and default driver registry are removed.

Verification:

- `cpu-lease run -n 4 -- bun run typecheck` passed every workspace package.
- `cpu-lease run -n 4 -- bun test` passed 953 tests with 3,168 assertions and no
  failures; 114 Postgres/S3 integration tests skipped because their external
  services were not configured.
- The targeted control suite passed 166 tests, skipped 22 external-service tests,
  and had no failures.
- Targeted Cloudflare provider/runner and Zerops checks passed.

Real-account Zerops bring-up remains in
[`backlog/05-bring-up-on-a-real-zerops-account.md`](../backlog/05-bring-up-on-a-real-zerops-account.md).

**Goal.** Remove Cloudflare and Zerops knowledge from neutral engine and control
code by composing one typed provider bundle per installation.

**Theme.** The existing deploy-driver seam is sound but incomplete. This sprint
extends the boundary across app configuration, persisted targets, deploy
lifecycle, secrets, reconciliation, and runtime composition without preserving
the current internal API or storage format.

## Refs re-verified at HEAD (2026-07-29)

- ✔ `AppConfigs` and `DeployTargets` are closed two-provider maps —
  `packages/config/src/types.ts:113`, `packages/engine/src/types.ts:80`.
- ✔ `@fabrika/engine` imports and registers both concrete drivers by default —
  `packages/engine/src/drivers/index.ts:10`.
- ✔ The shared run lifecycle branches directly on `appEnv.platform` —
  `packages/control/src/run-lifecycle.ts:208`.
- ✔ Registration, secret mutation, cron, and startup code name Zerops capabilities
  directly — `packages/control/src/api/registry.ts:199`,
  `packages/control/src/api/vault.ts:181`, `packages/control/src/cron.ts:14`,
  `packages/control/src/node/server.ts:27`.
- ✔ Persistence fixes the provider set in a CHECK and adds Zerops-specific target
  columns — `packages/control/migrations/0007_zerops_targets.sql:2`.
- ✔ One-platform-per-installation is already a product constraint —
  `docs/decisions/0001-merge-propustka-and-vozka.md:34`.

## Work units

### WU1 — Establish the provider contract (effort M)

**Completed.** `@fabrika/provider-contract` now carries open runtime/control
interfaces, typed codecs, versioned envelopes, and fake-provider contract tests.

- **Problem.** Platform/config correlation currently depends on closed maps in
  neutral packages.
- **Verify first.** Characterize deploy orchestration with a third fake provider.
- **Scope.** Add a runtime-neutral provider contract, JSON envelope/codecs, typed
  adapter factories, and fake-provider contract tests.
- **Acceptance / witness.** A fake provider compiles and runs without adding its id
  to a core union or registry.
- **Touch points.** New contract package, engine types/tests, workspace metadata.

### WU2 — Extract the Cloudflare provider (effort L)

**Completed.** `@fabrika/provider-cloudflare` owns authoring, codecs, the deploy
plan, control adapter, runner job contract, and the `fabrika-cloudflare` CLI.

- **Problem.** Neutral config and engine packages import oblaka, wrangler, and the
  Cloudflare plan.
- **Verify first.** Preserve the current Cloudflare plan and dry-run witnesses.
- **Scope.** Move Cloudflare authoring, target, plan, collaborators, driver, and
  runner request contract behind the provider package.
- **Acceptance / witness.** Existing Cloudflare tests pass from the new package;
  neutral packages contain no Cloudflare import or closed platform arm.
- **Touch points.** config, engine, runner, new Cloudflare provider package.

### WU3 — Extract the Zerops provider (effort L)

**Completed.** `@fabrika/provider-zerops` owns authoring, manifest compilation,
schema/API code, the deploy plan, control capabilities, and the
`fabrika-zerops` CLI.

- **Problem.** Zerops schema, compiler, API client, manifest, driver, proxy, secret,
  and reconciliation logic is split between config, engine, deploy, and control.
- **Verify first.** Preserve manifest, invariant, API, proxy, and reconciliation
  witnesses.
- **Scope.** Move the complete Zerops implementation behind provider subpath
  exports and typed codecs.
- **Acceptance / witness.** Zerops tests pass from the new package; neutral config
  and engine code never name Zerops.
- **Touch points.** config, engine, control, deploy, new Zerops provider package.

### WU4 — Make control lifecycle provider-neutral (effort L)

**Completed.** Shared registry, lifecycle, vault, cancellation, and reconciliation
receive one `ControlProvider` and contain no concrete-provider dispatch.

- **Problem.** Run execution, cancellation, secrets, startup, and cron select
  provider behaviour with concrete branches.
- **Verify first.** Characterize both current lifecycle paths and terminal-state
  ownership.
- **Scope.** Inject one `ControlProvider`; route deploy, external-id persistence,
  reconciliation, cancellation, and secret mutations through its capability
  bundle.
- **Acceptance / witness.** Shared control code passes against a fake provider and
  contains no Cloudflare/Zerops branch.
- **Touch points.** control lifecycle/API/services/cron, provider control adapters.

### WU5 — Replace provider-specific persistence and API data (effort L)

**Completed.** App environments persist target/artifact envelopes; runs persist a
generic external id; registry and dashboard APIs edit the same explicit envelope
shape.

- **Problem.** Adding a provider currently requires SQL columns and registry route
  changes.
- **Verify first.** Record the current app-env/run read-write surface in SQLite and
  Postgres tests.
- **Scope.** Replace named fields with provider id, versioned target/artifact JSON,
  and generic external run id; expose the same envelopes through registration.
- **Acceptance / witness.** A fake provider round-trips through registry, deploy,
  and reconciliation without schema or route changes.
- **Touch points.** both migration sets, DB rows/queries, registry API, dashboard
  types/tests.

### WU6 — Split and enforce composition roots (effort M)

**Completed.** The Worker root selects Cloudflare, the Bun root selects Zerops,
and import-graph tests enforce that shared core reaches neither provider.
Provider-owned CLIs replace the removed shared config/engine command surface.

- **Problem.** One control package currently carries both runtime/provider worlds.
- **Verify first.** Capture the current Worker and Bun import graphs.
- **Scope.** Compose Cloudflare and Zerops entrypoints separately, remove default
  provider registries, add import-boundary tests, and refresh operational docs.
- **Acceptance / witness.** Each composition root imports exactly one provider;
  engine and control core import neither; full workspace verification passes.
- **Touch points.** control entrypoints/packages, package manifests, docs.

## Out of scope (explicit)

- Runtime loading of third-party providers or one installation managing several
  providers.
- Compatibility shims for old TypeScript APIs, manifest v1, registry request
  fields, or provider-specific database columns.
- Real-account deployment and CI publishing; backlog 05 and 25 remain separate.

## Decisions

- [ADR-0011](../decisions/0011-static-provider-bundles.md) fixes static
  installation-level composition, opaque versioned envelopes, and small provider
  capabilities.
- Behaviour may break at internal boundaries, but security invariants, deploy
  semantics, and migration history remain binding.

## Sequencing

1. WU1 fixes the contract.
2. WU2 and WU3 extract implementations against it.
3. WU4 consumes both control adapters.
4. WU5 removes the persisted/API coupling.
5. WU6 makes the import graph enforce the result.

## Run log

- 2026-07-29 — User approved static provider bundles and explicitly waived
  backwards compatibility.
- 2026-07-29 — WU1 landed in `f45a14e`, `c14c586`, and `2278601`.
- 2026-07-29 — Provider bundles and control adapters landed in `d5f024f`,
  `60ccd45`, `ce2b620`, and `b3bafa5`.
- 2026-07-29 — Neutral engine, persistence, and lifecycle landed in `18c1942`,
  `4bdae83`, and `71abd1c`.
- 2026-07-29 — Provider CLIs and consumer cutovers landed in `51a49f4`,
  `f8bfca8`, `55bee1b`, `a55f7a9`, `896ca34`, and `d1ca714`.
- 2026-07-29 — Static control composition, shared-config removal, workspace graph,
  and explicit dashboard envelopes landed in `5f4c19f`, `c3da7ab`, `7947cdf`,
  and `2a2b81a`.
- 2026-07-29 — Full workspace typecheck and test verification passed. The sprint
  is ready to archive.
