# Sprint — Fabrika application runtime (2026-07-29)

## OUTCOME

Completed in `cace795` (`feat(app): add first-party application runtime`).
`@fabrika/app` now owns the runtime-neutral Fetch request pipeline, typed routing
and RPC, middleware, structural errors, object authorization, and the browser
client. Cloudflare and Bun lifecycle adapters use explicit
`@fabrika/app/cloudflare` and `@fabrika/app/bun` entrypoints. Both example
applications consume the new framework.

Verification:

- `cpu-lease run -n 4 -- bun run typecheck` passed every workspace package.
- `cpu-lease run -n 4 -- bun test` passed 1,013 tests with 3,287 assertions and
  no failures; 114 Postgres/S3 integration tests skipped because their external
  services were not configured.
- `@fabrika/app` passed 59 tests across its runtime-neutral core and both
  adapters.
- Lint, format checking, and `git diff --check` passed.

Publishing `@fabrika/app` and retiring the external Trasa release surface remain
in [backlog 26](../backlog/26-retire-trasa-release-surface.md), blocked by CI and
release restoration in
[backlog 25](../backlog/25-bootstrap-npm-trusted-publishing.md).

**Goal.** Replace the standalone Trasa package with a tested `@fabrika/app`
workspace package for Worker and Bun applications.

**Theme.** Move the existing server framework into the Fabrika product boundary
without mixing request-time code with provider configuration.

## Refs re-verified at HEAD (2026-07-29)

- ✔ Trasa is one published package containing routing, middleware, RPC, errors,
  and a browser client — `../trasa/packages/trasa/src/index.ts`.
- ✔ Trasa duplicates an authorization shape that is intended to mirror Fabrika —
  `../trasa/packages/trasa/src/middleware.ts`.
- ✔ `@fabrika/auth` already owns the canonical `AuthContext`, `Scope`, and
  `Middleware` contracts — `packages/auth/src/index.ts`.
- ✔ Proxy gates and application object checks are separate responsibilities —
  `docs/decisions/0007-proxy-based-auth-enforcement.md`.

## Work units

### WU1 — Record the package boundary (effort S)

- **Problem.** The server framework and Fabrika are independently named and
  released despite sharing one application contract.
- **Verify first.** Compare the Trasa middleware and authorization types with
  `@fabrika/auth`.
- **Scope.** Accept ADR-0012 and document the runtime/deploy boundary.
- **Acceptance / witness.** The decision index and current architecture reference
  identify `@fabrika/app` as the sole server framework.
- **Touch points.** `docs/decisions/`, `docs/reference/`, package indexes.

### WU2 — Migrate the package (effort M)

- **Problem.** The implementation lives only under `../trasa` and publishes as
  `@trasa/core`.
- **Verify first.** Run the original package tests before migration.
- **Scope.** Move source and tests into `packages/app`, rename product identifiers,
  and consume Fabrika's canonical auth contracts.
- **Acceptance / witness.** The package typecheck and all migrated tests pass.
- **Touch points.** `packages/app/`, `packages/auth/src/`, workspace metadata.

### WU3 — Integrate documentation and verify the workspace (effort S)

- **Problem.** Root documentation currently describes only auth, deploy, and
  operations packages.
- **Verify first.** Search the Fabrika repository for stale Trasa references.
- **Scope.** Update package maps and run format, lint, typecheck, and tests.
- **Acceptance / witness.** No runtime source references Trasa and all repository
  gates pass.
- **Touch points.** `README.md`, `CLAUDE.md`, `docs/`, `bun.lock`.

### WU4 — Add the Bun lifecycle adapter (effort M)

- **Problem.** The request pipeline is Fetch-based, but its only lifecycle surface
  requires a Worker execution context.
- **Verify first.** Drive the existing Zerops app behavior through the framework
  without changing its proxy/auth boundary.
- **Scope.** Extract `defineApp()`, add `createBunHandler()` with explicit
  background-task draining, add terminal wildcard routes, and migrate the Zerops
  example.
- **Acceptance / witness.** Worker and Bun adapters share routing and RPC
  semantics; the Zerops app tests pass through the Bun adapter; shutdown drains
  `waitUntil()` work before closing Postgres.
- **Touch points.** `packages/app/`, `examples/zerops-app/`.

### WU5 — Isolate runtime adapter entrypoints (effort S)

- **Problem.** The package root and `server.ts` mix portable request APIs with
  Cloudflare and Bun lifecycle APIs.
- **Verify first.** Resolve both adapters through package exports and identify
  which lifecycle types the portable application actually needs.
- **Scope.** Keep `defineApp()` in the root API; expose Cloudflare and Bun through
  explicit subpath exports; migrate both example entrypoints.
- **Acceptance / witness.** The root exports no provider lifecycle symbols, both
  subpaths resolve during example typechecks, and adapter contract tests pass.
- **Touch points.** `packages/app/`, `examples/app/`,
  `examples/zerops-app/`.

## Out of scope (explicit)

- Archiving the external Trasa Git repository and deprecating the npm package
  follow after the replacement publishes — see
  [backlog 26](../backlog/26-retire-trasa-release-surface.md).
- Shrinking the legacy in-process enforcement surface in `@fabrika/auth` remains
  backlog item 18.

## Decisions

- `@fabrika/app` is the sole home of the framework — see
  [ADR-0012](../decisions/0012-fabrika-app-runtime.md).
- Runtime code does not move into provider authoring packages.

## Sequencing

WU1 establishes the boundary. WU2 migrates against it. WU3 updates the living
documentation. WU4 adds the second runtime adapter. WU5 isolates both adapters
behind explicit package entrypoints, and the final verification covers both.

## Run log

- Started from the released Trasa `v0.0.2` source and test suite.
- `@fabrika/app` consumes `AuthContext`, `Scope`, and `Middleware` directly from
  `@fabrika/auth`; the duplicate compatibility types are gone.
- The migrated package has 59 passing tests. The complete repository has 1,013
  passing tests and 114 backend-dependent skips.
- `defineApp()` owns the runtime-neutral request pipeline.
  `createCloudflareWorker()` and `createBunHandler()` are available only through
  explicit runtime subpaths — see
  [ADR-0013](../decisions/0013-explicit-runtime-adapter-entrypoints.md).
- The Zerops example now uses the Bun adapter, route-scoped authentication, and
  explicit background-task draining during shutdown.
- External repository and npm retirement remains tracked in
  [backlog 26](../backlog/26-retire-trasa-release-surface.md).
