# fabrika-platform

An application platform with three planes: **Delivery** (declare/provision/deploy), **Access**
(identity/policy/audit), and **Operations** (runtime errors, releases, source maps, triage, alerts,
health). It targets a small fleet of apps on more than one cloud — Cloudflare and Zerops today.

Read `docs/decisions/` before changing anything structural: much of what looks odd here is odd on
purpose, and some invariants have already been retired by a later ADR (ADR-0022 supersedes ADR-0007,
ADR-0008, ADR-0010 and ADR-0021; ADR-0009 extends ADR-0002). **For anything touching authentication
or authorization, ADR-0022 is the one to read** — the four it supersedes are kept for their
reasoning, not as a description of current behaviour. Before touching the Zerops path read
[`docs/reference/zerops-platform.md`](./docs/reference/zerops-platform.md) — it records platform
facts settled against a real account, several of which contradict Zerops' published documentation.

## Tech Stack

- **Bun** — runtime + workspaces. Libraries run TypeScript directly (`exports.bun` → `src`); no build step.
- **TypeScript** strict, ESM (`"type": "module"`) everywhere.
- **Cloudflare Workers** — Worker + Durable Objects + Containers + D1 + Queues + R2. **Zerops** is the
  second target: it uses its platform API directly and has no runner (ADR-0003). Each installation
  statically composes ONE provider bundle; the shared engine and control core depend only on
  `@fabrika/provider-contract` (ADR-0011).
- `oblaka-iac` (CF provisioning DSL), `@buzola/*` (SPA router), `jose` (token signing).

## Commands

```bash
bun install
bun run typecheck          # every package + scripts/
bun test                   # all tests; some suites skip without Postgres/S3 (see below)
bun test packages/engine/src/__tests__/deploy.test.ts   # a single file
bun run lint               # biome
bun run format             # dprint fmt  (format:check to verify only)

bun run local:up           # the Docker stack: both Postgres, MinIO, a Zerops emulator, all planes
bun run local:status       # …:smoke (disruptive end-to-end), :reset (wipes volumes), :down
bun run test:browser       # opice suites in tests/browser/ (browser:up/reset/down manage the stack)

bun run release:validate   # publishability + dependency direction; also :pack :smoke :publish
```

CPU-heavy runs (full typecheck, full test suite, docker builds) go through `cpu-lease run -n 4 -- …`.

Suites that need a real backend **skip cleanly** when it is absent and print the variables and the
docker command to get one: `FABRIKA_TEST_POSTGRES_URL` (the Postgres driver and the
IAM/control/Operations schemas) and `FABRIKA_TEST_S3_*` (the S3 blob store). A green `bun test` with
everything skipped does NOT mean the Postgres path works — run them before trusting that half.

`release:validate` enforces that every package is either `private: true` or declares
`publishConfig.access: "public"`, and that no public package depends on a private one.

Per-package dev/build commands live in each package's own CLAUDE.md.

## Project Structure

Runtime ports and the provider contract are independent axes. A composition root binds one runtime
implementation set to one provider bundle.

```
packages/
  auth-core auth app              # authz kernel · app-facing IAM SDK (verify only) · application runtime
  iam iam-contract iam-ui         # Access plane: login, token minting, /admin API, admin SPA
  operations operations-{contract,ui}  # Operations plane: ingest, grouping, triage, console views
  control control-contract        # Delivery control plane — Worker AND long-running Bun process
  dashboard                       # the unified console SPA (all three planes)
  engine                          # provider-neutral deploy executor
  platform platform-node          # runtime PORTS · the Postgres/S3/Bun implementation set
  provider-{contract,cloudflare,zerops}       # authoring, deploy, and control per cloud
  installation-{contract,cloudflare,zerops}   # `fabrika platform init/plan/deploy` per cloud
  runner-{contract,container,cloudflare}      # the Cloudflare out-of-band deploy executor
  proxy proxy-contract            # the ONLY auth enforcement point (ADR-0022)
  cli email local-stack           # the `fabrika` command · outbound email · the Docker dev stack
examples/app examples/zerops-app  # a worked app per provider
tests/browser                     # opice end-to-end suites against the local stack
```

An app imports `defineApp` and provider-owned resource types from its selected provider package —
Cloudflare configs import `@fabrika/provider-cloudflare`, Zerops configs `@fabrika/provider-zerops`.
There is no shared `@fabrika/config` package and no closed provider union. The public `fabrika` CLI
infers an app's provider from the object returned by that provider's `defineApp()`; `--provider` is
needed only when there is no app config. Platform commands load the provider's
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
- **The proxy is the ONLY thing that enforces authorization** (ADR-0022). App services are not
  publicly routed; an application reads the proxy-injected `X-Fabrika-Token`, verifies it locally,
  and enforces nothing. Never add a second gate evaluator — not in `@fabrika/auth`, not in Caddy
  config, not in a provider package. There is exactly one gate matcher, in `@fabrika/auth-core`.
- **`fabrika.config.ts` is the single source of truth** for a worker's own resources; `oblaka.ts` is a
  thin shim over it. Never re-declare resources in `oblaka.ts`.
- **Postgres migration identity is `(bundle, filename)` in a service-owned
  ledger** (ADR-0017). IAM, control, and Operations keep separate ledger tables
  and stable advisory locks. Do not rename a bundle or migration file; the old
  `schema_migrations` table is read-only legacy evidence.
- **The deploy EXECUTOR is a separate worker** reached via a service binding, because a deploy's final
  step runs `wrangler deploy` inside a container — a container hosted in the control plane would reset
  itself mid-deploy. It is deployed out-of-band.

## Module-Specific Context

Read the package's own CLAUDE.md before editing it. Beyond the packages that only carry a short
contract note (`*-contract`), the substantial ones are:

- `packages/auth-core/` — the authz kernel all three auth components share (gate matcher, token
  claims, `IamRpc`) · `packages/auth/` — the app-facing IAM SDK, which verifies the injected token
  and nothing else · `packages/app/` — the request pipeline, typed RPC, runtime adapters ·
  `packages/iam/` — the Access service, on both runtimes.
- `packages/control/` — API/ACL, vault, secret resolution, run lifecycle, webhook (+ `DATABASE.md`
  for its SQL and migration rules) · `packages/engine/` — the provider-neutral executor.
- `packages/platform/` + `packages/platform-node/` — the runtime ports and their Postgres/S3/Bun
  implementations · `packages/provider-cloudflare/` + `packages/provider-zerops/` — the provider bundles.
- `packages/installation-cloudflare/` + `packages/installation-zerops/` — platform installation ·
  `packages/cli/` — command routing and provider inference.
- `packages/proxy/` — the enforcement point · `packages/operations/` + `packages/operations-ui/` —
  the Operations kernel and console views · `packages/dashboard/` — the SPA.
- `packages/runner-container/` + `packages/runner-cloudflare/` — the deploy container and its Worker ·
  `packages/local-stack/` — the Docker dev stack behind every `local:*` command.

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
