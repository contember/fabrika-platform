# fabrika-platform

An application platform with three planes: **Delivery** (declare/provision/deploy), **Access**
(identity/policy/audit), and **Operations** (runtime errors, releases, source maps, triage, alerts,
health). It targets a small fleet of apps on more than one cloud — Cloudflare and Zerops today.

Read `docs/decisions/` before changing anything structural: much of what looks odd here is odd on
purpose. ADRs are living until 1.0 — each states its decision as it stands now (`docs/CLAUDE.md`).
**For anything touching authentication or authorization, ADR-0022 is the one to read.** Before touching the Zerops path read
[`docs/reference/zerops-platform.md`](./docs/reference/zerops-platform.md) — it records platform
facts settled against a real account, several of which contradict Zerops' published documentation.

## Tech Stack

- **Bun** — runtime + workspaces, at the exact release in `.bun-version` (bumping it: `docs/reference/release-process.md`).
  Libraries run TypeScript directly (`exports.bun` → `src`); no build step in the workspace. `release:pack` emits
  `.d.ts` declarations for the published `types` condition only (ADR-0067).
- **TypeScript** strict, ESM (`"type": "module"`) everywhere.
- **Cloudflare Workers** — Worker + Durable Objects + Containers + D1 + Queues + R2. **Zerops** is the
  second target: it uses its platform API directly and has no runner (ADR-0003). Each installation
  statically composes ONE provider bundle; each provider runs its own deploy steps, and the shared
  control core depends only on `@fabrika/provider-contract` (ADR-0011).
- `oblaka-iac` (CF provisioning DSL), `@buzola/*` (SPA router), `jose` (token signing).

## Commands

```bash
bun install
bun run typecheck          # every package + scripts/
bun run test               # all tests; isolates DOM-heavy agent-interface suites
bun test packages/provider-contract/src/__tests__/steps.test.ts   # a single file
bun run lint               # biome
bun run format             # dprint fmt  (format:check to verify only)
bun run check:ci           # every step of CI's verify workflow, with throwaway Postgres + SeaweedFS; run before pushing to main

bun run local:up           # the Docker stack: both Postgres, SeaweedFS, a Zerops emulator, all planes
bun run local:status       # …:smoke (disruptive end-to-end), :compat (older releases, ADR-0062), :reset (wipes volumes), :down
bun run test:browser       # opice suites in tests/browser/ (browser:up/reset/down manage the stack)

bun run release:bump --tag=v1.2.3   # set the next release's version in the source, before tagging
bun run release:validate   # publishability + dependency direction + tag = source version; also :pack :smoke :publish
bun run release:pack --local --artifacts=<dir>   # unreleased tarballs for an app outside the repo (app-setup.md)
```

CPU-heavy runs (full typecheck, full test suite, docker builds, `check:ci`) go through `cpu-lease run -n 4 -- …`.

Run `bun run check:ci` before a push to `main`: `release.yml` verifies a tag with the same workflow, so a red `main`
blocks a release. It starts each backend it needs with docker unless `FABRIKA_TEST_POSTGRES_URL` or
`FABRIKA_TEST_S3_ENDPOINT` already names one, and its summary lists everything it could not run. A test that fails
without a code change is made deterministic or deleted the same day; CI never retries it.

Suites that need a real backend **skip cleanly** when it is absent and say what to set to run them:
`FABRIKA_TEST_POSTGRES_URL` (the Postgres driver and the IAM/control/Operations schemas) and
`FABRIKA_TEST_S3_*` (the S3 blob store) each print the `docker run` that supplies one;
`FABRIKA_LIVE_ZEROPS_TOKEN` + `FABRIKA_LIVE_ZEROPS_PROJECT_ID` run the platform-facts table against a
real Zerops account, which no container can stand in for — it creates and deletes throwaway services in
that project, and `FABRIKA_LIVE_ZEROPS_SLOW=1` adds the build-length rows. `FABRIKA_TEST_RELEASE_PACK=1` packs locally, installs the set into a scratch application and checks it with `--packed` (`scripts/__tests__/release.test.ts`; needs npm). `FABRIKA_TEST_CADDY_BIN` names a
caddy 2.10.2 binary (copy it out of the `caddy:2.10.2-alpine` image) and runs the generated proxy chain in a real
Caddy (`packages/proxy/src/__tests__/caddy.live.test.ts`). `FABRIKA_TEST_CLAMSCAN_BIN` names a `clamscan` (or a wrapper
that runs the `clamav/clamav:1.4` image with the batch directory mounted at its own path) and runs the file scan against
a real ClamAV (`packages/app/src/__tests__/{clamscan,file-scan}.test.ts`). The scan refuses signatures older than three
days (`signatures_stale`), and the image's own go stale between releases: keep them in a volume refreshed with
`docker run --rm -v <volume>:/var/lib/clamav clamav/clamav:1.4 freshclam`, and mount that volume in the wrapper. A green `bun test` with everything skipped proves
nothing about any of them — run them before trusting those halves.

`release:validate` enforces that every package is either `private: true` or declares
`publishConfig.access: "public"`, that no public package depends on a private one, and that the tag
names the source version: installations run the git checkout of their tag, not the tarballs
([`release-process.md`](./docs/reference/release-process.md#the-source-version)).

Per-package dev/build commands live in each package's own CLAUDE.md.

## Parallel work

- **One git worktree per agent.** An agent that works while another agent works in this repository uses its own
  worktree on its own branch (`git worktree add <path> -b <branch> origin/main`). Two agents in one checkout break
  each other's typecheck, test runs and commits. The lead integrates the branches.
- **Never switch the branch of a checkout that another agent uses.** A hotfix is cut with `release:hotfix`, which
  works in a temporary worktree of its own ([`release-process.md`](./docs/reference/release-process.md#cutting-a-hotfix)).
- Run `bun install` in each new worktree; `node_modules` is not shared.
- The local Docker stack has a fixed compose project name, `fabrika-local`: one worktree at a time runs `local:*` or
  `browser:*`.

## Project Structure

Runtime ports and the provider contract are independent axes. A composition root binds one runtime
implementation set to one provider bundle.

```
packages/
  daemon-kit annotations canvas-kernel  # Reusable daemon, annotation, and interactive canvas foundations
  agent-canvas canvas-share         # the `agent-canvas` CLI, daemon and browser UI · its Cloudflare share worker
  builder                         # Guided specification and agent-assisted application builder
  auth-core auth jwks app         # authz kernel · app-facing IAM SDK (verify only) · the shared token verifier · application runtime
  iam iam-contract                # Access plane: login, token minting, /admin API
  operations operations-{contract,ui}  # Operations plane: ingest, grouping, triage, console views
  control control-contract        # Delivery control plane — Worker AND long-running Bun process
  dashboard                       # the unified console SPA (all three planes)
  platform platform-node          # runtime PORTS · the Postgres/S3/Bun implementation set
  provider-{contract,cloudflare,zerops}       # authoring, deploy, control, and `fabrika platform …` per cloud
  installation-init               # the operator-side `init` mechanics both installations share
  platform-artifacts              # private Zerops installation codegen: zerops.yaml, import YAMLs, schemas
  runner-{container,cloudflare}               # the Cloudflare out-of-band deploy executor
  github-app                      # the shared GitHub App client
  proxy-core proxy                # the auth enforcement decision and its `/manifest` wire contract · its Caddy deployment
  cli email local-stack           # the `fabrika` command · outbound email · the Docker dev stack
  check                           # the application checker (`fabrika-check`), for applications, not this repo
  ui                              # the paved road's React component kit, router and theme for application SPAs (ADR-0052)
  db                              # the scoped data layer applications use on Postgres (Kysely over Bun.SQL)
examples/app examples/zerops-app  # a worked app per provider
examples/crm                      # the CRM on the paved road: the acceptance application of the framework
tests/browser                     # opice end-to-end suites against the local stack
```

An app imports `defineApp` and provider-owned resource types from its selected provider package —
Cloudflare configs import `@fabrika/provider-cloudflare`, Zerops configs `@fabrika/provider-zerops`.
There is no shared `@fabrika/config` package and no closed provider union. The public `fabrika` CLI
infers an app's provider from the object returned by that provider's `defineApp()`; `--provider` is
needed only when there is no app config. Platform commands load the provider's
`@fabrika/provider-<cloud>/installation` subpath through the open installation contract.

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
- **`provider-cloudflare`, `control`, and `runner-cloudflare` relax exactly two strict flags**
  (`noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`) ONLY to tolerate oblaka's raw-TS
  source. Keep our own code strict; never widen the relaxation and never work around oblaka with a
  cast — ask first.
- **NEVER log credentials or secret values.** They flow control-plane → `RunnerJob` → child env only;
  on error log a short message, never an error object that may carry a clone URL with an embedded token.
- **The proxy is the ONLY enforcement point: exactly one enforcement decision, in `@fabrika/proxy-core`
  over `@fabrika/auth-core`'s planner, and only the proxy runs it** (ADR-0022). App services are not
  publicly routed; an application reads the proxy-injected `X-Fabrika-Token`, verifies it locally, and
  makes no enforcement decision. Never add a second one — not in `@fabrika/auth`, not in Caddy config,
  not in a provider package. Two other layers refuse requests and are **not** the enforcement decision:
  **authorization** (`.require`, `can()`, control's scoped use-case checks) and **admission** (the proxy's
  `Sec-Fetch-Site` and content-type checks; Control reads no `Origin`, and IAM's `/admin/*` is bearer-only).
  `docs/reference/overview.md` defines all three; keep the vocabulary.
  Every manifest entry is an endpoint table: a contract application's, or an installation service's. The
  most specific endpoint wins, with no fall-through, and a credentialed row is served only under the endpoint
  id the proxy sets in `X-Fabrika-Endpoint` (ADR-0022 rules 3 and 5). An installation service's `protocol`
  and `health` rows ignore that header, because they authenticate themselves and also arrive unfronted —
  so does a private gateway hop that still carries the console's endpoint id. Only an entry that platform composition marks
  `installation: true` may use the installation-only forms (`protocol`, `service`, method `*`, caller
  `oauth`, requirement `authenticated`); never let an application declare one.
- **`fabrika.config.ts` is the single source of truth** for a worker's own resources; `oblaka.ts` is a
  thin shim over it. Never re-declare resources in `oblaka.ts`.
- **Postgres migration identity is `(bundle, filename)` in a service-owned
  ledger** (ADR-0017). IAM, control, and Operations keep separate ledger tables
  and stable advisory locks. Do not rename a bundle or migration file. Before 1.0 a bundle's
  history may be squashed when installations are reinstalled; there is no legacy-ledger adoption.
- **The deploy EXECUTOR is a separate worker** reached via a service binding, because a deploy's final
  step runs `wrangler deploy` inside a container — a container hosted in the control plane would reset
  itself mid-deploy. It is deployed out-of-band.

## The rollout path of an existing installation

A fresh install and `fabrika platform upgrade` take different code paths. A change that alters generated
installation files, environment variables or provider state states, in its commit message, how an EXISTING
installation converges on upgrade. Answer each question that applies:

1. **Generated files.** Does `upgrade` rewrite the changed file (the sidecar workflow, `zerops.yaml`, an import
   YAML), or does only `init` write it?
2. **Environment variables.** Does a deploy write the new value on an existing service, and remove or rename the old
   one? A sensitive variable cannot be read back, so the code cannot compare it.
3. **Provider state.** Does a resource that an older version created (a service, a bucket, its provenance) still pass
   the new code's checks?
4. **Floating pins.** Does a version that floats (a toolchain, an image tag) resolve the same on an upgraded
   installation as on a fresh one?

If no upgrade step converges an existing installation, add that step, or document the operator step in
`docs/reference/`. Test the upgrade path where a test can reach it.

## Framework API versus platform protocol

The framework API (what an application's author writes: contract kinds, `ctx`, the data layer, the UI kit, the
checker's rules) may break in a minor release before 1.0, with a migration guide; an application meets the break only
when it raises its own pin. The protocol between an application and the platform (the contract artifact and digest,
manifest rows and row modes, `X-Fabrika-*` headers, token claims, workload key exchange, the IAM schema, `FABRIKA_*`
variables, the build step) must not break for any framework release inside the platform's support window: a platform
upgrade never forces an application to upgrade, redeploy or change code. Change the protocol additively, keep the old
side served until no release in the window uses it, and never let a platform release read an application's contract
with a reader other than its own release's ([ADR-0062](./docs/decisions/0062-a-platform-release-serves-older-framework-releases.md)).

## Module-Specific Context

Read the package's own CLAUDE.md before editing it. Beyond the packages that only carry a short
contract note (`*-contract`), the substantial ones are:

- `packages/auth-core/` — the authz kernel all three auth components share (endpoint planner, token
  claims, `IamRpc`) · `packages/auth/` — the app-facing IAM SDK, which verifies the injected token
  and nothing else · `packages/app/` — the contract framework, service contracts, typed RPC, runtime adapters ·
  `packages/iam/` — the Access service, on both runtimes.
- `packages/daemon-kit/` — reusable Bun daemon primitives · `packages/annotations/` — runtime-neutral
  annotation state and UI · `packages/canvas-kernel/` — the Agent Canvas compiler, store, renderer, and components.
  `packages/agent-canvas/` — the published `agent-canvas` host over those three, under its unscoped npm name ·
  `packages/canvas-share/` — the Cloudflare worker that serves shared canvases.
- `packages/builder/` — the guided application builder behind `fabrika builder …`, including its
  deterministic phase machine, local daemon/dashboard, agent skill, and stack decision catalog.
- `packages/control/` — API/ACL, vault, secret resolution, run lifecycle, webhook (+ `DATABASE.md`
  for its SQL and migration rules).
- `packages/platform/` + `packages/platform-node/` — the runtime ports and their Postgres/S3/Bun
  implementations · `packages/provider-cloudflare/` + `packages/provider-zerops/` — the provider bundles.
- `provider-<cloud>/src/installation/` — platform installation, each generating the operator's own
  sidecar repository over the shared `packages/installation-init/` · `packages/platform-artifacts/` —
  the private codegen behind the Zerops installation's generated files · `packages/cli/` — command
  routing and provider inference · `packages/check/` — the application checker and its rules.
- `packages/proxy-core/` — the enforcement decision, public and runtime-neutral · `packages/proxy/` —
  its Caddy deployment, private because it is an artifact · `packages/operations/` —
  the Operations kernel · `packages/dashboard/` — the console SPA for all three planes.
- `packages/db/` — the scoped data layer for applications: table policies, stores, the query guard.
- `packages/ui/` — the React component kit, router and theme of application SPAs; `@fabrika/app/react` holds their hooks.
- `packages/runner-container/` + `packages/runner-cloudflare/` — the deploy container and its Worker ·
  `packages/local-stack/` — the Docker dev stack behind every `local:*` command.

<!-- AGENT-DOCS:POINTER (managed by the agent-docs skill — edit the body freely,
     keep the markers) -->

## Docs

Project docs live in [`docs/`](./docs/) and follow a fixed structure — start at
[`docs/CLAUDE.md`](./docs/CLAUDE.md) (the operating manual) and
[`docs/INDEX.md`](./docs/INDEX.md) (the map). In short:

- `docs/reference/` — how the system works now.
- `docs/decisions/` — ADRs (the _why_), rewritten in place until 1.0.
- `docs/backlog/` — decided work not yet scheduled · `docs/sprints/` — active
  work-plans · `docs/archive/` — shipped.
- `docs/ideas/` — proposals, no commitment.

Path is the status (no `status:` fields); when you finish or supersede something,
move/delete it per `docs/CLAUDE.md`.

<!-- /AGENT-DOCS:POINTER -->
