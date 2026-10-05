# Static validation — execution territory ledger

Parent: [static validation sprint](sprint-2026-10-05-static-validation.md).

Baseline: `ab534ea`. An existing-file allowlist is the set of paths from
`git ls-tree -r --name-only ab534ea` beneath the roots below, minus the stated
exclusions. This pins the exact existing-file set without duplicating a changing
repository listing. New source/test files beneath those roots inherit the same
owner. Existing files outside that baseline require leader assignment.

Global exclusions: package manifests, lockfiles, export-only barrels, tool/CI/TS
configuration, generated artifacts, `CLAUDE.md`, and `docs/**` belong to the leader.
An `index.ts` with actual runtime logic is not an export-only barrel. For WU01,
the existing mixed `index.ts` modules are reserved to the leader explicitly; the
implementer provides replacement modules and integration instructions.

| Owner     | Roots                                                                                                | Additional exclusions                                   |
| --------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| WU01      | `packages/operations-contract/`, `packages/control-contract/`, `packages/proxy-contract/`            | `src/index.ts`; self-contained approval parser          |
| WU02      | `packages/operations/`                                                                               | None                                                    |
| WU03      | `packages/iam/`                                                                                      | None                                                    |
| WU04      | `packages/auth/`, `packages/jwks/`, `packages/proxy-core/`, `packages/proxy/`                        | None                                                    |
| WU05      | `packages/control/`                                                                                  | Embedded approval page                                  |
| WU06      | `packages/provider-zerops/src/source/`                                                               | `index.ts` barrel                                       |
| WU07      | `packages/provider-zerops/`                                                                          | WU06 root; WU09 paths                                   |
| WU08      | `packages/installation-zerops/`                                                                      | None                                                    |
| WU09      | `packages/provider-zerops/scripts/generate-zerops-types.ts`, `packages/provider-zerops/src/types.ts` | Deferred; no writer                                     |
| WU10      | `packages/provider-cloudflare/`, `packages/runner-container/`, `packages/runner-cloudflare/`         | None                                                    |
| WU11      | `packages/github-app/`, `packages/source-zerops/`                                                    | None                                                    |
| WU12      | `packages/installation-cloudflare/`, `packages/installation-init/`                                   | None                                                    |
| WU13      | `packages/builder/`                                                                                  | None                                                    |
| WU14      | `packages/canvas-kernel/`, `packages/annotations/`                                                   | None                                                    |
| WU15      | `packages/dashboard/`, `packages/iam-ui/`, `packages/operations-ui/`                                 | None                                                    |
| WU16      | `packages/cli/`, `examples/`                                                                         | None                                                    |
| WU17      | `packages/local-stack/`                                                                              | None                                                    |
| WU18      | `packages/platform/`, `packages/platform-node/`, `packages/email/`                                   | None                                                    |
| WU19      | `scripts/`                                                                                           | None                                                    |
| WU00/WU20 | All global exclusions; cross-package integration tests                                               | Pause affected package owner before shared-file changes |

The only nested implementation roots are WU06/WU07 and WU09/WU07; explicit
subtraction makes both disjoint. All other roots are pairwise disjoint. Tests
follow their path, not the module they exercise. In particular WU06 may run
provider-root tests but only WU07 may edit them.

## Frozen initial conventions

- Zod 3.25.76 minimum, import from `zod`, Standard Schema at RPC seams.
- Preserve public parser signatures and domain types for the first pass. Expose
  schemas only when consumers actually need them; leader integrates exports.
- Schema inference may replace local duplicate types without changing ownership.
- No shared generic `parse<T>` library, global error map, global config parser,
  or cross-package import from a private runtime into a public contract.
- Parser acceptance is boundary-specific: strict wire DTOs, tolerant provider
  projections, and recovery filtering are separate contracts.
- All agents report actual changed paths and verify no path crosses this ledger.

## Initial dispatch

WU01, WU03, WU06 and WU14 run concurrently. WU01-dependent consumers wait for
its integration. All four have the same baseline and no overlapping source/test
writes. Source-identity work is committed through `ab534ea` before this dispatch.
