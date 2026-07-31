# Sprint — Automated release readiness (2026-07-31)

## OUTCOME

Shipped the repository-side automation for honest CI, co-versioned `@fabrika/*` package releases, and account-local Cloudflare runner rollouts.

- `39bb5b1` adds the reusable CI workflow, trusted-publishing tag workflow, deterministic nineteen-package release graph, validated tarball staging, isolated consumer smoke test, retry-safe registry integrity checks, and proxy build witness.
- `127ae69` makes each Cloudflare installation build its runner from the exact pinned source, removes the obsolete cross-account image pin, adds a 20-minute active-container rollout grace, and guards the slim Docker workspace dependency closure.

Local verification:

- PostgreSQL 17 and MinIO-backed tests passed: 1,516 tests across 176 files with 5,562 expectations and no failures.
- Full repository typecheck, format check, lint, Zerops generated-artifact check, dashboard build, and proxy build check passed.
- All nineteen packages validated, packed, installed, and exercised in an isolated consumer. Publish completed in dry-run mode without npm mutation.
- The account-owned runner image built successfully; its CLI smoke and provider dry-run deploy passed.

Hosted GitHub Actions and live npm verification are deliberately deferred to [backlog 25](../backlog/25-bootstrap-npm-trusted-publishing.md). That item owns the clean hosted CI witness, protected first publish, trusted-publisher binding, live test tag, registry consumer, and verified retry. No package was published and no account was deployed in this sprint.

**Goal.** Turn every accepted revision into honestly verified code and every version tag into a co-versioned, installable, provenance-bearing `@fabrika/*` release.

**Theme.** The merged platform now has a large public package surface and working per-account deployment composition, but this repository has no CI or release workflow. This batch restores the upstream verification and distribution boundary without making the upstream repository an account deployment authority.

## Refs re-verified at HEAD (2026-07-31)

- ✔ No `.github/` directory exists, so pull requests, pushes, and tags have no repository automation — repository root.
- ✔ The root exposes format, lint, typecheck, unit/integration test, local smoke, and browser gates, but no aggregate build, generated-artifact, or package-distribution gate — `package.json:9`.
- ✔ Nineteen packages are explicitly public under the `@fabrika/*` scope. Their workspace dependency graph has no public-to-private edge, but every internal published dependency still uses `workspace:*` — `packages/*/package.json`.
- ✔ Cloudflare installation generates a per-account root-of-trust workflow that checks out an exact `fabrika.ref`; upstream automation is not an account deployment authority — `packages/installation-cloudflare/src/templates/platform.yml:3`.
- ⚠ The generated per-account workflow builds the runner image only when a manual `build_runner_image` input is true. A routine `fabrika.ref` rollout defaults that input to false — `packages/installation-cloudflare/src/templates/platform.yml:14` and `packages/installation-cloudflare/src/templates/platform.yml:156`.
- ⚠ `packages/runner-cloudflare/image.json` still claims a missing central `runner-image.yml` publishes an account-local Cloudflare registry tag. That single-account ancestor model cannot supply images to independent account registries — `packages/runner-cloudflare/image.json:2`.
- ✔ PostgreSQL and S3 integration suites deliberately skip when `FABRIKA_TEST_POSTGRES_URL` or the `FABRIKA_TEST_S3_*` set is absent, so a plain green `bun test` is incomplete evidence — `packages/platform-node/src/__tests__/helpers/postgres.ts:3` and `packages/platform-node/src/__tests__/helpers/s3.ts:9`.
- ✔ Zerops installation owns an explicit generated-artifact drift command, and the dashboard and proxy own deployable build commands that the root typecheck does not execute — `packages/installation-zerops/package.json:25`, `packages/dashboard/package.json:7`, and `packages/proxy/package.json:17`.

## Work units

### WU1 — Freeze the upstream release contract (effort S)

- **Problem.** There is no executable definition of which packages ship, their dependency order, or the boundary between upstream release and per-account deployment.
- **Verify first.** Inventory every workspace package, its public/private state, publish metadata, internal dependencies, executable surface, and package contents.
- **Scope.**
  1. Treat every non-private package with public publish metadata as the release set.
  2. Enforce one version for the public monorepo and a topologically valid dependency graph.
  3. Fail when a public package depends on a private workspace package or when an internal dependency cannot be released.
  4. Keep account deployment in generated installation repositories; upstream tags publish code and packages only.
  5. Re-scope backlog 25 and current reference text to the live architecture.
- **Acceptance / witness.** One deterministic command reports all nineteen public packages in publish order and rejects cycles, private edges, inconsistent versions, or incomplete publish metadata.
- **Touch points.** Root scripts and package metadata, `docs/backlog/25-bootstrap-npm-trusted-publishing.md`, release/reference documentation.

### WU2 — Add honest repository CI (effort M)

- **Problem.** No required gate runs at all, and the normal test command silently omits the real PostgreSQL and object-storage contracts when their services are absent.
- **Verify first.** Enumerate every opt-in backend test and its exact environment variables; verify build and generated-artifact commands that typecheck does not cover.
- **Scope.**
  1. Add pull-request and main-branch CI with least-privilege permissions and superseded-run cancellation.
  2. Install with the lockfile frozen.
  3. Run format, lint, typecheck, tests, Zerops generated-artifact drift, dashboard build, and proxy build.
  4. Supply PostgreSQL 17 and MinIO/S3 services with readiness checks and all required environment values.
  5. Make missing or unreachable backend services fail instead of turning the backend suites into skips.
- **Acceptance / witness.** A clean workflow run executes all PostgreSQL and S3 suites, both deployable builds, generated checks, and static gates. Stopping either backend makes the workflow fail.
- **Touch points.** `.github/workflows/ci.yml`, root/package scripts, integration-test helpers only if an explicit CI-required mode is needed.

### WU3 — Prove package artifacts before publication (effort M)

- **Problem.** Published manifests currently contain `workspace:*`, and source-tree tests do not prove that the tarballs are complete or consumable outside the monorepo.
- **Verify first.** Pack every public package without mutation and inspect filenames, manifests, exports, binaries, and internal dependency ranges.
- **Scope.**
  1. Stage manifests at the tag version and translate internal workspace dependencies to the co-version range without modifying source manifests.
  2. Pack every public package in dependency order.
  3. Reject forbidden files, unresolved workspace ranges, missing exports, and unexpected package names.
  4. Install the tarballs into an isolated consumer and exercise the CLI plus representative app/provider imports.
- **Acceptance / witness.** All nineteen tarballs install without workspace access; `fabrika --help` and representative imports run from the isolated consumer.
- **Touch points.** Release tooling, root scripts, package metadata where an actual packaging defect is found.

### WU4 — Publish trusted, retryable tagged releases (effort L)

- **Problem.** A `v*` tag currently produces nothing, while publishing nineteen dependent packages can leave a partial immutable npm release if a later package fails.
- **Verify first.** Confirm the `@fabrika` npm scope, package ownership, current trusted-publisher requirements, and whether each tag version is absent or already published.
- **Scope.**
  1. Add a tag workflow with `id-token: write`, no npm token, provenance, and least-privilege repository access.
  2. Run the same artifact and consumer preflight before the first publish.
  3. Publish in dependency order.
  4. Make retries accept an already-published package only when its registry artifact matches the locally staged artifact; reject mismatches.
  5. Install representative packages from the registry after publication.
- **Acceptance / witness.** A test release tag publishes one co-versioned set with provenance, and a clean registry consumer succeeds. Re-running the same tag is a verified no-op rather than a conflict or silent mismatch.
- **Touch points.** `.github/workflows/release.yml`, release tooling, package metadata.

### WU5 — Make runner rollout account-correct (effort M)

- **Problem.** The source pin assumes a missing upstream workflow can populate every account-local registry, while the generated account workflow does not rebuild on a normal pinned-ref rollout.
- **Verify first.** Trace the exact Dockerfile inputs, the Cloudflare container build path, first bring-up, manual dispatch, and routine `fabrika.ref` push behavior.
- **Scope.**
  1. Keep the per-account installation repository as the only deployment authority.
  2. Build the runner from the exact pinned source during a routine `fabrika.ref` rollout so a missing cross-account image tag cannot be selected.
  3. Keep manual dispatch explicit and safe for a deliberate no-change redeploy.
  4. Remove stale central-workflow claims and pin behavior that no longer represents the account-local lifecycle.
  5. Extend scaffold/config tests to pin first bring-up and routine rollout behavior.
- **Acceptance / witness.** A freshly generated account workflow builds from its pinned checkout on first bring-up and on a routine ref rollout, while no upstream workflow requires Cloudflare account credentials or writes an account registry.
- **Touch points.** `packages/installation-cloudflare/src/templates/`, scaffold tests, `packages/runner-cloudflare/fabrika-runner.config.ts`, `packages/runner-cloudflare/image.json`, current reference docs.

## Out of scope (explicit)

- Credentialed Zerops bring-up and live semantics remain `../backlog/05-bring-up-on-a-real-zerops-account.md` plus questions 06 and 09.
- Zerops source-map publication and managed-environment activation remain `../backlog/36-complete-zerops-release-artifact-correlation.md` and `../backlog/37-activate-zerops-managed-environment-transactionally.md`; the latter cannot close without a real-account witness.
- DNS-safe Operations egress remains `../backlog/38-add-dns-safe-operations-egress.md`; it needs its own cross-runtime security design.
- Existing Poplach state adoption, Trasa deprecation, and downstream SDK migration remain separate external work.
- This repository does not deploy `main` or tags into customer accounts.

## Decisions

- Upstream automation verifies and distributes Fabrika; generated per-account repositories deploy it.
- Public workspace packages are co-versioned from one `v<semver>` tag.
- CI evidence is valid only when the opt-in PostgreSQL and S3 suites actually run.
- Runner images are account-local deployment artifacts built from the pinned source. A source tag in this repository is not evidence that an image exists in another account's registry.

These decisions align the automation with the existing per-account root-of-trust composition. They do not introduce a new deployment boundary, so no new ADR is required.

## Sequencing

| Phase | Work                                 | Dependency                     |
| ----- | ------------------------------------ | ------------------------------ |
| 1     | WU1 release contract                 | none                           |
| 2     | WU2 honest CI and WU5 runner rollout | WU1 facts; may run in parallel |
| 3     | WU3 package artifacts                | WU1 release graph              |
| 4     | WU4 tagged publication               | WU2 and WU3                    |
| 5     | Full verification and close          | all work units                 |

## Current status

| Work unit | State       | Evidence / blocker                                                                                                        |
| --------- | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| WU1       | Implemented | `bun run release:validate --tag=v0.0.0-ci.0` reports the nineteen-package release graph.                                  |
| WU2       | Implemented | The reusable CI workflow supplies PostgreSQL and MinIO and runs the full static, generated, test, build, and pack gates.  |
| WU3       | Implemented | All nineteen staged tarballs pass manifest validation and the isolated consumer smoke test.                               |
| WU4       | Deferred    | All nineteen npm package names are absent; backlog 25 owns hosted CI, protected bootstrap, and live release verification. |
| WU5       | Implemented | The generated account workflow always builds its runner from the exact pinned source checkout.                            |

The repository implementation closes here. Backlog 25 owns the external activation and verification witnesses.

## Run log

- 2026-07-31 — Sprint started. CI, release tooling, and runner rollout were dispatched as independent implementation streams; root owns integration, documentation lifecycle, and full verification.
- 2026-07-31 — Agent-docs lint reports only the existing compatibility symlink `docs/AGENTS.md -> CLAUDE.md` as a stray root file; the sprint/index changes add no structural error.
- 2026-07-31 — Registry verification found all nineteen public package names absent from npm. Current npm trusted-publisher configuration requires an existing package, confirming the first-publish prerequisite already recorded by the post-merge readiness sprint. Implementation and dry-run verification continue; a live release cannot pass WU4 acceptance until an authorized CI bootstrap creates the packages and binds `release.yml` as their trusted publisher.
- 2026-07-31 — CI, release tooling, and account-local runner rollout landed in the working tree. Independent reviews added registry artifact integrity checks, a post-publish npm consumer witness, complete packed export/bin validation, a 20-minute active-container rollout grace, and scaffold `[skip ci]` commits so Environment configuration precedes the first deploy dispatch.
- 2026-07-31 — Backlog 25 was re-scoped to the external npm bootstrap only; current verification and release behavior is documented in `../reference/release-process.md`.
- 2026-07-31 — The first clean deployable-build gate exposed that the proxy's normal build expects deployment-provided `proxy.manifest.json`. Added a dedicated build check over a committed empty fail-closed manifest; production builds retain their generated manifest input.
- 2026-07-31 — The account-owned runner Docker build exposed an incomplete slim workspace after the new contract dependencies landed: `@fabrika/control-contract` now reaches `@fabrika/app`, but the image omitted it. Added the missing package and a dependency-closure/COPY contract test before rebuilding the image.
- 2026-07-31 — Full backend verification passed with PostgreSQL 17 and MinIO: 1,516 tests passed across 176 files with 5,562 expectations and no failures. The exact temporary backend containers were removed after the run.
- 2026-07-31 — Final artifact verification passed: all nineteen packages validated, packed, installed, and exercised in isolation; the publish command completed in dry-run mode without mutating npm.
- 2026-07-31 — Final deployable checks passed: dashboard build, proxy build check, runner Docker build, runner CLI smoke, and a provider dry-run deploy. Full repository typecheck also passed after the Docker workspace fix.
- 2026-07-31 — Hosted Actions and live npm verification were explicitly postponed to backlog 25; the implementation sprint closed without publishing or deployment.
