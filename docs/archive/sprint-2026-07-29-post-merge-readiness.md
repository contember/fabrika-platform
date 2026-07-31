> **OUTCOME — shipped 2026-07-29.** The merged repository now has one IAM
> resource graph, one-repository bootstrap scaffolding, a self-contained runner
> image, coherent examples and Zerops sources, propagated request correlation,
> strict optional-backend test configuration, and an updated toolchain. Commit
> map: WU1 → `44cfd83`, WU2 → `882263e`, WU3 → `138ea6d`, WU4 → `add6f49`,
> WU5 → `dcd200a`. No push, publish, or deploy was performed. Verification: all
> 17 workspace typechecks;
> 989 tests passed, 115 opt-in Postgres/S3 tests skipped, 0 failed across 86
> files; lint checked 337 files with 0 errors; dprint and frozen install passed;
> the leased Docker build and baked CLI dry-run smoke passed; 14 Zerops YAML
> tests and all 5 generated artifacts passed. Docs lint reported only the
> pre-existing ignored `docs/AGENTS.md` → `CLAUDE.md` symlink as a stray root
> file. Backlog 20, 23, 24, 26, and 27 was deleted. CI/release item 25,
> environment-prefix item 07, and the Zerops control-plane path remain deferred
> as planned.

# Sprint — Post-merge readiness (2026-07-29)

**Goal.** Remove five merge-time faults so the single repository has one IAM
resource graph, one bootstrap checkout, a buildable runner image, coherent
operational examples, and an unpinned green toolchain.

**Theme.** Backlog items 20, 23, 24, 26, and 27 are all bounded cleanup from the
propustka + vozka merge. Together they make the merged shape internally honest
before new Zerops control-plane work builds on it.

## Refs re-verified at HEAD (2026-07-29)

`✔` = confirmed live · `⚠` = drift or nuance caught while planning.

- ✔ IAM still declares two Worker graphs. `fabrika.config.ts` exports the intended
  shared builder, but `oblaka.ts` independently constructs another `Worker` and
  uses four forbidden casts — `packages/iam/fabrika.config.ts:59`,
  `packages/iam/oblaka.ts:75`, `packages/iam/oblaka.ts:91`.
- ⚠ The two IAM paths disagree beyond the backlog summary:
  `fabrika.config.ts` defaults three required non-secret variables to empty values,
  while `oblaka.ts` requires those variables plus hostname and two secrets. The
  common contract must be chosen explicitly, not inherited accidentally —
  `packages/iam/fabrika.config.ts:19`, `packages/iam/fabrika.config.ts:42`,
  `packages/iam/oblaka.ts:60`.
- ✔ The CLI scaffold still creates `vozka.ref` and `propustka.ref`, then the
  generated workflow checks out `contember/vozka` and `contember/propustka`
  separately — `packages/cli/src/scaffold.ts:20`,
  `packages/cli/src/templates/platform.yml:55`.
- ⚠ The generated workflow also uses pre-merge package paths
  (`packages/admin-ui`, `packages/worker`) and old working-directory names. This is
  a full single-repository template migration, not only a checkout edit —
  `packages/cli/src/templates/platform.yml:87`,
  `packages/cli/src/templates/platform.yml:119`.
- ✔ The runner image workspace contains only config, engine, and runner. The
  Dockerfile copies only those packages while the slim root asks npm for
  `@fabrika/auth` and `@fabrika/auth-core`; neither name currently exists on npm —
  `packages/runner/docker/package.json:5`,
  `packages/runner/docker/package.json:11`,
  `packages/runner/Dockerfile:44`.
- ✔ The example app points at an absent root `scripts/provision-schemas.ts` from
  both its package script and README —
  `examples/app/package.json:5`, `examples/app/README.md:44`.
- ⚠ The two obsolete per-package Zerops files remain, but the root source already
  preserves both schema deviations that mattered: omitted protocol spelling and
  OS-qualified build bases — `deploy/zerops/setups.ts:12`,
  `deploy/zerops/setups.ts:97`, `deploy/zerops/setups.ts:215`.
- ⚠ `.dev.vars.example` is the committed contract and contains the two IAM runtime
  secrets. The differing `.dev.vars` is ignored local state and must not be edited
  by this sprint — `packages/iam/.dev.vars.example:1`.
- ✔ IAM still uses `cf-ray` or a fresh UUID for admin and OIDC audit correlation,
  while the proxy already normalizes `X-Request-Id` and sends that value in IAM
  mint requests — `packages/iam/src/admin/router.ts:60`,
  `packages/iam/src/auth/routes.ts:131`, `packages/proxy/src/service.ts:91`.
- ✔ A partially configured S3 test environment silently becomes a skip. The
  helper requires bucket, access key, and secret key but returns `null` when any
  one is absent; its skip text incorrectly describes endpoint as required —
  `packages/platform-node/src/__tests__/helpers/s3.ts:24`,
  `packages/platform-node/src/__tests__/helpers/s3.ts:27`.
- ✔ Biome is exact-pinned and Workers types are forced by a root override —
  `package.json:17`, `package.json:23`.
- ✔ The known toolchain findings remain: several IAM tests implement the full
  `ExecutionContext` instead of the existing narrow `RequestContext`, and the
  engine test dereferences an optional provision through a double cast with an
  eslint suppression — `packages/iam/src/env.ts:77`,
  `packages/iam/src/__tests__/admin-router.test.ts:28`,
  `packages/engine/src/__tests__/deploy.test.ts:428`.

## Work units

### WU1 — Make IAM config the only resource graph (backlog 20, effort M)

- **Problem.** Local oblaka and fabrika deploys materialize different graphs and
  validate different variables. The duplicate graph also violates the repository's
  explicit source-of-truth and no-casts rules.
- **Verify first.**
  - Materialize both current local paths under controlled environment values and
    record their Worker option differences.
  - Run `bun run --filter @fabrika/iam typecheck` and the IAM config-focused tests
    before editing.
- **Scope.**
  1. Move all environment validation and Worker construction behind exports from
     `fabrika.config.ts`.
  2. Make `oblaka.ts` a thin `define(...)` adapter that supplies `ResourceContext`
     and calls the shared builder.
  3. Preserve the existing secret boundary: secrets are required where appropriate
     but never enter generated plaintext `vars`.
  4. Test local and remote materialization, required-variable failures, route
     selection, and equality of the resulting graph.
  5. Remove the IAM exception from the root invariant and correct stale comments.
- **Acceptance / witness.**
  - `oblaka.ts` contains no resource declaration, cast, or second validation policy.
  - Tests prove both entry paths produce the same Worker for equivalent context,
    and missing remote input fails before provisioning.
  - `bun run --filter @fabrika/iam typecheck` and
    `bun test packages/iam` pass.
- **Touch points.** `packages/iam/fabrika.config.ts`,
  `packages/iam/oblaka.ts`, IAM config tests, `CLAUDE.md`.

### WU2 — Migrate the CLI scaffold to one repository (backlog 23, effort L)

- **Problem.** `fabrika init` emits two ref files, two checkouts, old package paths,
  and operator text for the pre-merge products. A newly generated platform
  repository cannot deploy this repository.
- **Verify first.**
  - Render the template into a temporary directory and inventory every
    `vozka`, `propustka`, legacy ref-file, repository, and package-path occurrence.
  - Compare each workflow command with the current package scripts and
    `fabrika platform deploy --help`.
- **Scope.**
  1. Replace the two source pins with one `fabrika.ref` and one checkout of
     `contember/fabrika-platform`.
  2. Rewrite workflow paths and commands for `packages/iam`,
     `packages/iam-ui`, `packages/runner`, and `packages/control`.
  3. Rename scaffold helpers, defaults, summaries, commit messages, and generated
     README text from product-specific legacy names to fabrika.
  4. Add offline scaffold tests for fresh creation and idempotent refresh.
  5. Detect an existing two-ref scaffold and emit explicit migration guidance.
     Do not guess which old ref maps to a merged-repository ref and do not silently
     delete operator-owned pin files.
- **Acceptance / witness.**
  - A rendered fresh scaffold contains one source repository and one ref.
  - No generated file references `contember/vozka`,
    `contember/propustka`, `vozka.ref`, `propustka.ref`,
    `packages/admin-ui`, or `packages/worker`.
  - Re-rendering an unchanged scaffold produces no staged diff.
  - CLI tests and `bun run --filter @fabrika/cli typecheck` pass without calling
    GitHub or deploying.
- **Touch points.** `packages/cli/src/scaffold.ts`,
  `packages/cli/src/init.ts`, `packages/cli/src/templates/`,
  `packages/cli/CLAUDE.md`, CLI tests.

### WU3 — Make the runner image self-contained (backlog 24, effort M)

- **Problem.** The Docker build expects two unpublished workspace packages to
  resolve from npm, so `bun install` cannot complete.
- **Verify first.**
  - Run the build only with a CPU lease:
    `cpu-lease run -n 4 -- bun run --cwd packages/runner docker:build`.
  - Confirm the failure is resolution of `@fabrika/auth*`, not an unrelated Docker
    or network failure.
- **Scope.**
  1. Add `packages/auth-core` and `packages/auth` to the slim workspace.
  2. Copy both package sources before the image install, matching the existing
     config/engine vendoring model.
  3. Update Docker comments and runner documentation so npm is named only for the
     dependencies that actually resolve there.
  4. Add the cheapest useful image smoke witness: invoke the baked `fabrika` CLI
     and exercise a fixture dry-run without cloud credentials.
- **Acceptance / witness.**
  - The leased Docker build completes from the repository root context.
  - `fabrika --help` runs inside the built image.
  - A Cloudflare fixture reaches a successful dry-run with the baked CLI, proving
    auth, config, engine, and oblaka resolve together.
- **Touch points.** `packages/runner/Dockerfile`,
  `packages/runner/docker/package.json`, runner image tests/documentation.

### WU4 — Close the bounded merge leftovers (backlog 26, effort L)

- **Problem.** Five small operational inconsistencies remain across examples,
  generated Zerops inputs, local configuration, request correlation, and opt-in
  backend tests.
- **Verify first.**
  - Re-run the five narrow searches recorded in the HEAD references above.
  - Regenerate the root Zerops artifacts and require a clean diff before deleting
    superseded source files.
  - Exercise S3 configuration parsing with none, complete, and each partial set of
    required variables.
- **Scope.**
  1. Restore the example's schema-reconcile command as an example-local utility
     using `exampleAppId`, `exampleAppSchema`, and the existing reconcile client;
     update its script, comments, and README. Do not recreate a global
     `DECLARATIONS` registry.
  2. Delete the superseded `packages/control/zerops.yaml`,
     `packages/iam/zerops.yaml`, and `packages/proxy/zerops.yaml`. Keep the protocol
     and build-base rationale in `deploy/zerops/setups.ts`, then regenerate the
     committed root `zerops.yaml`.
  3. Leave ignored `.dev.vars` untouched. Verify `.dev.vars.example` matches the
     runtime contract and remove the stale backlog claim rather than overwriting
     user-local state.
  4. Define one correlation rule for non-Cloudflare traffic: prefer
     `X-Request-Id`, then `cf-ray`, then generate a UUID. Ensure the proxy's
     normalized value reaches an allowed upstream request and IAM audit writes.
  5. Make S3 tests skip only when none of the required variables is configured;
     any partial set fails with the missing variable names. Keep endpoint optional
     and make the skip message match that contract.
- **Acceptance / witness.**
  - The example's documented dry-run command succeeds.
  - Only the generated root `zerops.yaml` remains, regeneration is clean, and the
    two schema-deviation comments remain in its TypeScript source.
  - No ignored local secret file is modified.
  - One request ID is observable in proxy logs and the corresponding IAM audit
    input; fallback behavior is covered by tests.
  - S3 helper tests cover unconfigured, complete, and partial configuration.
- **Touch points.** `examples/app/`, `packages/control/zerops.yaml`,
  `packages/iam/zerops.yaml`, `packages/proxy/zerops.yaml`,
  `deploy/zerops/setups.ts`,
  `packages/iam/src/admin/router.ts`, `packages/iam/src/auth/routes.ts`,
  `packages/proxy/src/`, `packages/platform-node/src/__tests__/helpers/s3.ts`.

### WU5 — Unpin the merge-time toolchain (backlog 27, effort M)

- **Problem.** Root overrides freeze the repository to the versions used during the
  merge. Removing them exposes real unsafe test code and newly required Workers
  types.
- **Verify first.**
  - Record `bun outdated` and the resolved versions in `bun.lock`.
  - Remove the two root constraints in a scratch patch, then run targeted typecheck
    and lint to capture the complete current finding set before choosing fixes.
- **Scope.**
  1. Remove the Workers-types override and the exact Biome pin; update the lockfile
     to current compatible releases.
  2. Type test helpers against the existing narrow runtime capabilities wherever
     production accepts `RequestContext`. Keep entrypoint wiring coverage without
     fabricating an abstract `Tracing` implementation.
  3. Rewrite the engine provision assertion with explicit runtime narrowing and
     ordinary expectations. Remove the double cast and irrelevant eslint
     suppression.
  4. Fix every additional finding caused by the same version movement without
     casts or suppressions.
- **Acceptance / witness.**
  - Neither merge-time pin remains.
  - No touched test implements a broader runtime interface than the code consumes.
  - `cpu-lease run -n 4 -- bun run typecheck`,
    `cpu-lease run -n 4 -- bun test`, `bun run lint`, and
    `bun run format:check` pass on the updated lockfile.
- **Touch points.** `package.json`, `bun.lock`,
  `packages/iam/src/__tests__/`,
  `packages/engine/src/__tests__/deploy.test.ts`, any file newly flagged by the
  updated tools.

## Out of scope (explicit)

- [25 — migrate CI workflows](../backlog/25-migrate-the-ci-workflows.md). As of
  planning, none of the seven non-private `@fabrika/*` package names with public
  metadata exists on npm. Trusted publishing cannot perform the first publication,
  and publishing from a laptop is forbidden. File the external namespace/bootstrap
  prerequisite before scheduling a release sprint; CI checks that do not publish
  may then land with it.
- The Zerops control-plane critical path
  ([10](../backlog/10-app-scope-secrets-on-zerops.md),
  [12](sprint-2026-07-29-zerops-control-path.md#wu1--ratify-the-proxy-manifest-path-backlog-12-effort-m),
  [13](sprint-2026-07-29-zerops-control-path.md#wu3--drive-zerops-deploys-in-process-backlog-13-effort-l),
  [14](sprint-2026-07-29-zerops-control-path.md#wu4--write-zerops-secret-edits-through-immediately-backlog-14-effort-m),
  [15](sprint-2026-07-29-zerops-control-path.md#wu5--reconcile-in-flight-zerops-runs-backlog-15-effort-m), and
  [16](sprint-2026-07-29-zerops-control-path.md#wu2--compile-app-config-to-a-static-manifest-backlog-16-effort-l)). This sprint makes the
  base honest; it does not add a Zerops caller.
- Environment-prefix renames from
  [07](07-rename-env-var-prefixes.md). Existing `VOZKA_*` and
  `PROPUSTKA_*` names remain unchanged here to avoid mixing an operational break
  into merge cleanup.
- Publishing, deployment, pushing branches/tags, or mutating generated
  per-account repositories. The sprint prepares and tests those paths locally; all
  external mutations require their own explicit authorization.

## Decisions

- The sprint consumes exactly backlog 20, 23, 24, 26, and 27. CI/release backlog 25
  stays separate because it has an external first-publish prerequisite.
- `fabrika.config.ts` owns IAM resources. `oblaka.ts` may adapt context only.
- A new scaffold has one `fabrika.ref`. An old two-ref scaffold fails with
  migration guidance until an operator chooses a valid merged-repository ref; the
  CLI does not invent that mapping.
- The runner image vendors unpublished first-party packages. Publishing them is
  not a prerequisite for a working runner.
- Ignored `.dev.vars` is user-local state. The sprint validates the committed
  example and never rewrites the local file.
- The example keeps an explicit schema-reconcile demonstration, but it is local to
  the example. A new root-level app registry would duplicate the deploy engine's
  schema source of truth.
- Toolchain fixes narrow types or validate runtime structure. Casts, `any`, and
  suppressions are not acceptable escape hatches.

## Sequencing

| Order | Work               | Dependency / parallelism                                                                 |
| ----- | ------------------ | ---------------------------------------------------------------------------------------- |
| 1     | WU1, WU2, WU3, WU4 | Independent; may run in parallel. WU3 owns Docker and must lease CPU.                    |
| 2     | WU5                | Runs after the functional work so the updated toolchain validates its final shape once.  |
| 3     | Final gate         | Format, lint, leased typecheck, leased full tests, leased runner image build, docs lint. |

Close the sprint only when all five backlog files can be deleted in the same
change, affected reference/CLAUDE files describe the shipped behavior, and the
closure record includes commit and verification witnesses.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0007"). -->

- 2026-07-29 — WU1: the standalone Oblaka entry now delegates to the shared IAM
  resource builder. Local and remote graph-equality, validation, secret-boundary,
  IAM typecheck, and 201 runnable IAM tests passed; 29 Postgres-backed tests
  skipped because no test database was configured.
- 2026-07-29 — WU4: the committed `.dev.vars.example` was already correct; the
  reported mismatch was ignored user-local `.dev.vars`, which the sprint left
  untouched.
- 2026-07-29 — WU4: both Zerops schema-deviation notes already lived in
  `deploy/zerops/setups.ts`. The final gate exposed a third superseded package
  file under `packages/control`; all three are now absent, guarded by 14 Zerops
  YAML tests, and `gen:check` remains clean.
- 2026-07-29 — WU4: targeted witness passed: example schema dry-run, 45 focused
  tests, and typechecks for example-app, proxy, and platform-node.
- 2026-07-29 — WU2: the single-repository scaffold, explicit legacy-ref
  migration stop, and three offline fresh/idempotent/migration tests passed.
  Generated YAML parsing, CLI typecheck, lint, and format checks are green.
- 2026-07-29 — WU3: the first leased Docker build exposed a third missing local
  workspace, `@fabrika/platform`, in addition to the two auth packages. Vendoring
  all three produced a passing leased build, 37 runner tests, and a baked CLI
  smoke that completed an offline Cloudflare dry-run.
- 2026-07-29 — WU5: Biome resolved to 2.5.6 and Workers types to the latest
  compatible v4, 4.20260702.1. Narrow request contexts and explicit runtime
  narrowing fixed every new diagnostic without a cast or suppression. The leased
  final gate passed 989 tests with 115 opt-in Postgres/S3 skips.
