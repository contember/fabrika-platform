# fabrika-platform

An application platform: identity/policy/audit (the IAM half) plus declare-provision-deploy (the
control-plane half), for a small fleet of apps, on more than one cloud. Merged from **propustka**
(IAM) and **vozka** (deploy control plane), both of which were Cloudflare-only.

**Status.** The merge has landed, the Cloudflare path works, and the multi-cloud seams are built: the
platform ports, the `DeployDriver` seam and its target union, a Postgres/S3/Bun implementation set, a
Zerops driver, and the auth proxy. **None of it has been run against a real Zerops account** — the
generated artifacts validate against Zerops' published JSON schema and the driver is proven in
dry-run, which is not the same as a deploy that worked. Treat "Zerops support" as well-formed but
unexercised until someone with an account says otherwise.

Read `docs/decisions/` before changing anything structural: much of what looks odd here is odd on
purpose, and some invariants have already been retired by a later ADR (ADR-0010 amends ADR-0008;
ADR-0009 extends ADR-0002).

## Tech Stack

- **Bun** — runtime + workspaces. Libraries run TypeScript directly (`exports.bun` → `src`); no build step.
- **TypeScript** strict, ESM (`"type": "module"`) everywhere.
- **Cloudflare Workers** — Worker + Durable Objects + Containers + D1 + Queues + R2. **Zerops** is the second
  target: `@fabrika/config` has a discriminated `target` arm for it and `@fabrika/engine` a driver (pure HTTP,
  no runner — ADR-0003). Not yet exercised against a real account.
- `oblaka-iac` (CF provisioning DSL), `@buzola/*` (SPA router), `jose` (token signing).

## Commands

```bash
bun install
bun run typecheck                    # all packages (bun run --filter '*' typecheck)
bun test                             # all tests; some suites skip without Postgres/S3 (see below)
bun test packages/engine/src/__tests__/deploy.test.ts   # a single file
bun run lint                         # biome
bun run format                       # dprint fmt  (format:check to verify only)
```

CPU-heavy runs (full typecheck, full test suite) go through `cpu-lease run -n 4 -- …`.

Suites that need a real backend **skip cleanly** when it is absent and print the variables and the
docker command to get one: `FABRIKA_TEST_POSTGRES_URL` (the Postgres driver, and the Postgres schemas
for `iam`/`control`) and `FABRIKA_TEST_S3_*` (the S3 blob store). A green `bun test` with everything
skipped does NOT mean the Postgres path works — run them before trusting that half.

Per-package dev/build commands live in each package's own CLAUDE.md.

## Project Structure

Two halves that meet at the config surface (`@fabrika/config`).

```
packages/auth-core/   # @fabrika/auth-core — pure kernel: action matcher, permits(), token build/parse,
                      #   gate types, the IamRpc contract. No I/O, no deps.
packages/auth/        # @fabrika/auth — the app-facing SDK (the only published package).
packages/iam/         # @fabrika/iam — the IAM service: OIDC login, token minting, /admin API, D1.
packages/iam-ui/      # @fabrika/iam-ui — the IAM admin SPA.
packages/config/      # @fabrika/config — the app-authoring surface (defineApp + re-exports).
packages/platform/    # @fabrika/platform — the runtime PORTS (SqlDatabase, BlobStore, JobQueue, DeployLocks,
                      #   AssetServer, WaitUntil) + the implementations that need nothing but a port.
packages/platform-node/ # @fabrika/platform-node — those ports for a long-running Bun process
                      #   (Postgres, S3/MinIO, a jobs table, a directory). Second impl set behind the ports.
packages/engine/      # @fabrika/engine — deploy engine + the `fabrika` CLI.        → CLAUDE.md
packages/control/     # @fabrika/control — the control-plane Worker.                → CLAUDE.md
packages/cli/         # @fabrika/cli — operator bring-up (`fabrika init <account>`). → CLAUDE.md
packages/dashboard/   # @fabrika/dashboard — the control-plane SPA.                 → CLAUDE.md
packages/runner/      # @fabrika/runner — the CF deploy runner + the runner executor worker. → CLAUDE.md
packages/proxy/       # @fabrika/proxy — the auth ENFORCEMENT point: a Caddy `forward_auth` service.
                      #   Nothing reaches an app until its gates pass. → ADR-0007, ADR-0008, ADR-0010
examples/app/         # a worked example app (authz vocabulary, gates, audit).
```

`@fabrika/config` is the single import an app authors from — it bundles `defineApp` with every oblaka
resource primitive and the authz declaration types, so a `fabrika.config.ts` never imports
`oblaka-iac` or `@fabrika/auth-core` directly.

## Code Conventions

- **Format = dprint** (`dprint.json`): tabs, **no semicolons** (ASI), single quotes, line width 150. Run `bun run format` before committing.
- **Lint = biome** (`biome.json`, recommended ruleset with many rules relaxed). `noConsole` allows `info/warn/error/debug/log`.
- Generate caller-side IDs (UUIDv7), never in SQL. snake_case row shapes mirror the migration files.
- No `as` casts, `@ts-ignore`, `@ts-expect-error`, or `any`. Solve it properly or ask.

## Critical Invariants

- **The toolchain is PINNED, deliberately.** `@cloudflare/workers-types` is pinned to `4.20260610.1`
  via a root `overrides` entry and biome to `2.5.0` — the versions the merged code was written
  against. A float to newer versions surfaces real findings (a newer `ExecutionContext` requires
  `tracing`; a newer biome flags an unsafe optional chain in `engine`'s tests), but mixing those fixes
  into the merge would make it impossible to tell merge damage from toolchain drift. Bumping the
  toolchain and fixing what it finds is its own task — see `docs/backlog/`.
- **`wrangler.jsonc` is generated but COMMITTED for `control` and `runner`** (and ignored everywhere
  else — see `.gitignore`). Its `migrations` array is the only durable record of a worker's Durable
  Object migration history; regenerating from scratch shifts tags when a DO class is added or removed
  and `wrangler deploy` fails with code 10074. Regenerate with `bun run oblaka` after a resource-graph
  change and commit the result. Never hand-edit it.
- **`oblaka-iac` resolves from npm, pinned to `^0.0.18`.** fabrika + oblaka are co-versioned — bump the
  pin deliberately, in every package plus the runner image's `docker/package.json`.
- **`config`, `engine`, `control`, `runner` relax exactly two strict flags**
  (`noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`) ONLY to tolerate oblaka's raw-TS
  source. Keep our own code strict; never widen the relaxation and never work around oblaka with a
  cast — ask first.
- **NEVER log credentials or secret values.** They flow control-plane → `RunnerJob` → child env only;
  on error log a short message, never an error object that may carry a clone URL with an embedded token.
- **`fabrika.config.ts` is the single source of truth** for a worker's own resources; `oblaka.ts` is a
  thin shim over it. Never re-declare resources in `oblaka.ts`. (`packages/iam` currently VIOLATES
  this — its two files are near-duplicate graphs that have already drifted. Known; do not copy the pattern.)
- **The deploy EXECUTOR is a separate worker** reached via a service binding, because a deploy's final
  step runs `wrangler deploy` inside a container — a container hosted in the control plane would reset
  itself mid-deploy. It is deployed out-of-band.

## Module-Specific Context

- `packages/engine/CLAUDE.md` — the deploy engine, the driver seam, the target union, the plan, the CLI.
- `packages/control/CLAUDE.md` — the control plane: API/ACL, vault, secret resolution, run lifecycle, webhook, D1.
- `packages/runner/CLAUDE.md` — the container image, the Worker↔container protocol, the executor worker.
- `packages/dashboard/CLAUDE.md` — the SPA: routes, API client, DTOs, buzola codegen.

<!-- AGENT-DOCS:POINTER (managed by the agent-docs skill — edit the body freely,
     keep the markers) -->

## Docs

Project docs live in [`docs/`](./docs/) and follow a fixed structure — start at
[`docs/CLAUDE.md`](./docs/CLAUDE.md) (the operating manual) and
[`docs/INDEX.md`](./docs/INDEX.md) (the map). In short:

- `docs/reference/` — how the system works now.
- `docs/decisions/` — ADRs (the _why_), immutable.
- `docs/backlog/` — decided work not yet scheduled · `docs/sprints/` — active
  work-plans · `docs/archive/` — shipped.
- `docs/ideas/` — proposals, no commitment.

Path is the status (no `status:` fields); when you finish or supersede something,
move/delete it per `docs/CLAUDE.md`.

<!-- /AGENT-DOCS:POINTER -->
