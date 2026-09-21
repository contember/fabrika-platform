> **OUTCOME — shipped 2026-09-21.** Control and Operations now expose their existing RPC contracts as the sole administrative transport. Duplicate REST adapters and unused helpers were removed; local readiness, namespace CLI and the seed script migrated to RPC. Protocol HTTP and IAM provisioning remain intact. Independent code reviews found no defects; baseline domain/security assertions were transferred to real RPC dispatch or typed use cases. Commit map: WU1 → `34cbae9`, WU2 → `f8f0db7`, WU3 → `8a6989e`; decision/spec → `2aa60a6`. Leader verification: full typecheck, format and lint pass; **3,430 tests pass, 203 existing skips, zero failures**. Lint retains 17 baseline warnings (1,195 informational diagnostics). Release validation passes for 28 public packages; frozen installation passes after approved Bun type lockfile refresh. No live Postgres/S3/Zerops, Docker smoke or browser E2E run; no push or deploy. No backlog item was consumed.

# Sprint — Remove duplicate administrative REST (2026-09-21)

**Goal.** Use the existing RPC contracts as the only administrative transport for Control and Operations.

**Theme.** Remove compatibility complexity explicitly rejected by the project owner; preserve behavior through the canonical API.

## Refs re-verified at HEAD (2026-09-21)

- Baseline `b738886`: clean tree; previous integrated gates passed with 3,425 tests passing, 203 skipped, no failures.
- `packages/control/src/api/router.ts` duplicates registry, namespaces, runs and vault RPC operations. `ControlRpcContract` includes both log and tail procedures.
- `packages/operations/src/app.ts` mounts RPC followed by operator REST. Ingest, upload and private synchronization have separate protocol handlers.
- `packages/cli/src/control.ts` already calls `/api/rpc`. `packages/local-stack/src/machine-key.ts` still probes namespaces through REST.
- User approved removal, internal consumer migration, independent agents/review and commits. [ADR-0041](../decisions/0041-one-administrative-transport-for-control-and-operations.md) records the boundary.

## Work units

| Unit                                | Territory                                                                           | Contract                                                                                                                                 | Acceptance                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| WU1 — Control                       | `packages/control/`                                                                 | Existing RPC contract unchanged; remove administrative REST adapters and restrict Operations gateway to RPC; preserve protocol endpoints | Package typecheck/tests; transfer domain/security assertions and test removed routes            |
| WU2 — Operations                    | `packages/operations/`                                                              | Existing RPC contract unchanged; remove operator REST and unused transport helpers                                                       | Package typecheck/tests; preserve host isolation, authorization, validation and domain coverage |
| WU3 — Consumers                     | Consumer code/tests outside the two service packages; excludes root config and docs | Migrate real REST callers to existing RPC; retain protocol-specific calls                                                                | Caller inventory, affected package tests/typechecks; no disruptive local-stack commands         |
| WU4 — Documentation and integration | `docs/` and root-owned integration                                                  | Current docs describe RPC-only administration; record test dispositions and verification                                                 | Independent review per code unit; integrated checks and clean commits                           |

**Verify first.** Read package guidance and ADR-0022, trace all callers before removing exports, and distinguish transport-only assertions from domain/security coverage. A missing RPC operation or dependency change is a blocker to report, not an invitation to add a framework.

## Out of scope

IAM provisioning REST, builder/CLI separation, changes to enforcement or authorization architecture, provider behavior, database schemas, deployments and publishing.

## Decisions

- No compatibility shims or dual transport. Existing RPC types are the shared frozen seam.
- Preserve meaningful tests by migrating their call path. Transport-only parity/status assertions may be retired with explicit reasons; no new skips or weakened domain assertions.
- Missing API routes must not become SPA success responses.

## Sequencing

Three implementers work in disjoint territories in one tree. Independent reviewers inspect frozen diffs, including new files. The leader reruns narrow checks and commits verified units. Integrated typecheck, tests, lint, formatting and release validation run before closure, with CPU-heavy work under `cpu-lease`.

## Run log

- Scope confirmed; three implementation units dispatched. Existing protocol endpoints and IAM provisioning remain in scope as preservation requirements.
- Consumer inventory also found Zerops namespace CLI create/adopt/reconcile calls. WU3 now includes direct workspace dependencies on the existing public `@fabrika/app` and `@fabrika/control-contract` packages for that CLI and local-stack, plus the corresponding lockfile metadata. The contract remains runtime-neutral and introduces no dependency cycle.
- Documentation review found no introduced defects: RPC procedure names and the curl request match the existing contract, retained protocols are explicit, and new links resolve. Backlog 79 already contains two broken links to retired backlog 73; this change only updates its removed-router references.
- WU2 — `f8f0db7`: Operations REST handler, exports and lazy loaders removed. Independent review found no defects and checked preservation of baseline domain/security assertions. Leader package typecheck and `bun test packages/operations` passed: 141 pass, five existing backend skips, zero failures. Thirteen domain tests now use typed use cases; RPC integration retains validation, authorization, token, isolation and safe-error tests. A 320-case matrix proves removed route families do not dispatch. REST-only envelopes/statuses and lazy-body validation precedence were deliberately retired.
- WU3 — `8a6989e`: local machine-key readiness and Zerops namespace CLI now use typed RPC; navigation/gate probes use current paths. Independent review clean; leader verified both package typechecks and 23 tests across five focused suites. Frozen installation also passes after the user-approved lockfile regeneration. The original `b738886` lockfile independently failed frozen resolution; regeneration updates affected Bun type resolutions from 1.4.1 to 1.4.2 without changing manifest ranges. Full integrated checks will validate the refreshed types across all packages.
- WU1 — `34cbae9`: Control router/adapters and obsolete REST contexts removed; Operations gateway restricted to RPC; explicit API 404 fallbacks prevent SPA responses. Seed now uses typed RPC. Independent review confirmed production/test router equivalence and preserved baseline ACL, vault, registry, namespace, audit and run assertions. REST 201/405 and cross-transport assertions migrated to canonical RPC behavior. No domain tests were deleted.
- Final gates ran under `cpu-lease run -n 4`: `bun run typecheck`, `bun run test`, `bun run lint` all exit zero. Test breakdown: 3,022 main + 310 agent-interface + 98 builder passes, 203 backend/live-account skips. Full `bun run format` passes. `bun run release:validate --tag=v0.0.4` validates 28 public packages. `bun install --frozen-lockfile --ignore-scripts` passes. Leader also exercised the seed's `--dry-run` with example coordinates, with no requests sent.
