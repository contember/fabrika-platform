# fabrika-platform

An application platform: identity/policy/audit (the IAM half) plus declare-provision-deploy (the
control-plane half), for a small fleet of apps, on more than one cloud. Merged from **propustka**
(IAM) and **vozka** (deploy control plane), both of which were Cloudflare-only.

**Status.** The merge has landed, the Cloudflare path works, and the multi-cloud seams are built: the
platform ports, static provider bundles, a Postgres/S3/Bun implementation set, a Zerops provider, and
the auth proxy. **None of it has been run against a real Zerops account** — the generated artifacts
validate against Zerops' published JSON schema and the provider is proven in
dry-run, which is not the same as a deploy that worked. Treat "Zerops support" as well-formed but
unexercised until someone with an account says otherwise.

Read `docs/decisions/` before changing anything structural: much of what looks odd here is odd on
purpose, and some invariants have already been retired by a later ADR (ADR-0010 amends ADR-0008;
ADR-0009 extends ADR-0002).

## Tech Stack

- **Bun** — runtime + workspaces. Libraries run TypeScript directly (`exports.bun` → `src`); no build step.
- **TypeScript** strict, ESM (`"type": "module"`) everywhere.
- **Cloudflare Workers** — Worker + Durable Objects + Containers + D1 + Queues + R2. **Zerops** is the second
  target. Each installation statically composes one provider bundle; the shared engine and control core
  depend only on `@fabrika/provider-contract` (ADR-0011). Zerops uses its platform API directly and has no
  runner (ADR-0003). Not yet exercised against a real account.
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

The runtime ports and provider contract are independent axes. A composition root binds one runtime
implementation set to one provider bundle.

```
packages/auth-core/   # @fabrika/auth-core — pure kernel: action matcher, permits(), token build/parse,
                      #   gate types, the IamRpc contract. No I/O, no deps.
packages/auth/        # @fabrika/auth — the app-facing SDK.
packages/app/         # @fabrika/app — HTTP routing, middleware, typed RPC, object authorization, client.
packages/iam/         # @fabrika/iam — the IAM service: OIDC login, token minting, /admin API, D1.
packages/iam-contract/ # @fabrika/iam-contract — browser-safe IAM admin REST DTOs.
packages/iam-ui/      # @fabrika/iam-ui — the IAM admin SPA.
packages/operations-contract/ # @fabrika/operations-contract — browser/runtime-safe Operations DTOs.
packages/operations/  # @fabrika/operations — portable error ingest, grouping, triage, and event-detail kernel.
packages/operations-ui/ # @fabrika/operations-ui — reusable Operations console views and display helpers.
packages/platform/    # @fabrika/platform — the runtime PORTS (SqlDatabase, BlobStore, JobQueue, DeployLocks,
                      #   AssetServer, WaitUntil) + the implementations that need nothing but a port.
packages/platform-node/ # @fabrika/platform-node — those ports for a long-running Bun process
                      #   (Postgres, S3/MinIO, a jobs table, a directory). Second impl set behind the ports.
packages/provider-contract/ # @fabrika/provider-contract — open runtime/control contracts + JSON envelopes.
packages/provider-cloudflare/ # @fabrika/provider-cloudflare — Cloudflare authoring, deploy, control + internal executor.
packages/provider-zerops/ # @fabrika/provider-zerops — Zerops authoring, manifest, API, deploy, control.
packages/engine/      # @fabrika/engine — provider-neutral deploy executor.          → CLAUDE.md
packages/control/     # @fabrika/control — the control-plane Worker.                → CLAUDE.md
packages/control-contract/ # @fabrika/control-contract — browser-safe control REST DTOs + run-log shape.
packages/installation-contract/ # @fabrika/installation-contract — open platform init/plan/deploy CLI contract.
packages/installation-cloudflare/ # @fabrika/installation-cloudflare — Cloudflare installation workflow. → CLAUDE.md
packages/installation-zerops/ # @fabrika/installation-zerops — Zerops topology, artifacts, and installation plan. → CLAUDE.md
packages/cli/         # @fabrika/cli — the single public `fabrika` command.           → CLAUDE.md
packages/dashboard/   # @fabrika/dashboard — the control-plane SPA.                 → CLAUDE.md
packages/runner-contract/ # @fabrika/runner-contract — provider-neutral Worker↔container protocol. → CLAUDE.md
packages/runner-container/ # @fabrika/runner-container — the plain-Bun deploy container. → CLAUDE.md
packages/runner-cloudflare/ # @fabrika/runner-cloudflare — the out-of-band executor Worker. → CLAUDE.md
packages/proxy-contract/ # @fabrika/proxy-contract — proxy manifest wire contract and strict parser.
packages/proxy/       # @fabrika/proxy — the auth ENFORCEMENT point: a Caddy `forward_auth` service.
                      #   Nothing reaches an app until its gates pass. → ADR-0007, ADR-0008, ADR-0010
examples/app/         # a worked Cloudflare app (authz vocabulary, gates, audit).
examples/zerops-app/  # a worked Zerops app and static manifest build.
```

An app imports `defineApp` and provider-owned resource types from its selected provider package.
Cloudflare configs import `@fabrika/provider-cloudflare`; Zerops configs import
`@fabrika/provider-zerops`. There is no shared `@fabrika/config` package or closed provider union.
The public `fabrika` CLI infers an app provider from the object returned by that provider's `defineApp()`;
`--provider` is needed only when there is no app config. Platform commands load the provider's
`@fabrika/installation-*` package through the open installation contract.

## Code Conventions

- **Format = dprint** (`dprint.json`): tabs, **no semicolons** (ASI), single quotes, line width 150. Run `bun run format` before committing.
- **Lint = biome** (`biome.json`, recommended ruleset with many rules relaxed). `noConsole` allows `info/warn/error/debug/log`.
- Generate caller-side IDs (UUIDv7), never in SQL. snake_case row shapes mirror the migration files.
- No `as` casts, `@ts-ignore`, `@ts-expect-error`, or `any`. Solve it properly or ask.

## Critical Invariants

- **`wrangler.jsonc` is generated but COMMITTED for `control` and `runner-cloudflare`** (and ignored everywhere
  else — see `.gitignore`). Its `migrations` array is the only durable record of a worker's Durable
  Object migration history; regenerating from scratch shifts tags when a DO class is added or removed
  and `wrangler deploy` fails with code 10074. Regenerate with `bun run oblaka` after a resource-graph
  change and commit the result. Never hand-edit it.
- **`oblaka-iac` resolves from npm, pinned to `^0.0.18`.** fabrika + oblaka are co-versioned — bump the
  pin deliberately, in every package plus `runner-container/docker/package.json`.
- **`provider-cloudflare`, `installation-cloudflare`, `control`, and `runner-cloudflare` relax exactly two strict flags**
  (`noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`) ONLY to tolerate oblaka's raw-TS
  source. Keep our own code strict; never widen the relaxation and never work around oblaka with a
  cast — ask first.
- **NEVER log credentials or secret values.** They flow control-plane → `RunnerJob` → child env only;
  on error log a short message, never an error object that may carry a clone URL with an embedded token.
- **`fabrika.config.ts` is the single source of truth** for a worker's own resources; `oblaka.ts` is a
  thin shim over it. Never re-declare resources in `oblaka.ts`.
- **The deploy EXECUTOR is a separate worker** reached via a service binding, because a deploy's final
  step runs `wrangler deploy` inside a container — a container hosted in the control plane would reset
  itself mid-deploy. It is deployed out-of-band.

## Module-Specific Context

- `packages/engine/CLAUDE.md` — the provider-neutral executor and runtime provider contract.
- `packages/app/CLAUDE.md` — the application request pipeline, typed RPC, and auth integration.
- `packages/control/CLAUDE.md` — the control plane: API/ACL, vault, secret resolution, run lifecycle, webhook, D1.
- `packages/cli/CLAUDE.md` — the provider-neutral command router and provider inference.
- `packages/installation-cloudflare/CLAUDE.md` and `packages/installation-zerops/CLAUDE.md` — provider-specific platform installation.
- `packages/runner-contract/CLAUDE.md`, `packages/runner-container/CLAUDE.md`, and
  `packages/runner-cloudflare/CLAUDE.md` — transport contract, container process, and executor Worker.
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
