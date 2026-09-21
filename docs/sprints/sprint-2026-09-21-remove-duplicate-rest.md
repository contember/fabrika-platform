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
