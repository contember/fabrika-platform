# Sprint — Static provider bundles (2026-07-29)

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

- **Problem.** Platform/config correlation currently depends on closed maps in
  neutral packages.
- **Verify first.** Characterize deploy orchestration with a third fake provider.
- **Scope.** Add a runtime-neutral provider contract, JSON envelope/codecs, typed
  adapter factories, and fake-provider contract tests.
- **Acceptance / witness.** A fake provider compiles and runs without adding its id
  to a core union or registry.
- **Touch points.** New contract package, engine types/tests, workspace metadata.

### WU2 — Extract the Cloudflare provider (effort L)

- **Problem.** Neutral config and engine packages import oblaka, wrangler, and the
  Cloudflare plan.
- **Verify first.** Preserve the current Cloudflare plan and dry-run witnesses.
- **Scope.** Move Cloudflare authoring, target, plan, collaborators, driver, and
  runner request contract behind the provider package.
- **Acceptance / witness.** Existing Cloudflare tests pass from the new package;
  neutral packages contain no Cloudflare import or closed platform arm.
- **Touch points.** config, engine, runner, new Cloudflare provider package.

### WU3 — Extract the Zerops provider (effort L)

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
