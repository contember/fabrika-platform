# @fabrika/engine

The deploy engine + the `fabrika` CLI. Turns an `AnyAppConfig` + `DeployContext` into a deploy by looking
up the target's **`DeployDriver`** by `ctx.target.platform`, letting it derive the plan, and executing that
plan. Two drivers live here: **cloudflare** (a container, a shell, oblaka, `wrangler`) and **zerops** (pure
HTTP — no runner, ADR-0003). Assumes the root CLAUDE.md.

## Layout

- `driver.ts` — the `DeployDriver` seam (ADR-0002/0009). `open(run) → DeploySession { plan, execute(stepId) }`,
  plus `DriverRun` (the run's neutral parts) and `DriverRegistry` (the discriminant → driver map).
- `deploy.ts` — the orchestrator: looks the driver up by discriminant, opens a session, runs the plan's
  steps in the order the driver gave them, stops on first failure or cancellation (rest → `skipped`).
  Platform-neutral.
- `drivers/index.ts` — `defaultDrivers`: the registry. Adding a platform is adding a KEY here.
- `drivers/cloudflare/plan.ts` — **pure, side-effect-free**: derives WHICH Cloudflare steps apply and in
  WHAT order. Touches nothing external.
- `drivers/cloudflare/index.ts` — the Cloudflare driver: `createCloudflareDriver(collaborators)`
  materializes the oblaka resource graph once, derives the plan from it, and executes each of its six
  step kinds.
- `drivers/cloudflare/collaborators.ts` — the Cloudflare driver's OWN side-effect bundle (shell, oblaka)
  behind injectable interfaces, plus `defaultCloudflareCollaborators` (the real ones).
- `drivers/shared/schema.ts` — `SchemaReconciler` + `defaultReconcileSchema`. The ONE collaborator ADR-0002
  calls fully portable (it talks to propustka, not to a cloud), so BOTH drivers use it.
- `drivers/zerops/plan.ts` — **pure**: derives the Zerops step list. A genuinely different shape (below).
- `drivers/zerops/compile.ts` — **pure**: compiles the app's declaration into `zerops-import.yaml` (incl. a
  tiny hand-rolled YAML emitter). **This is where ADR-0004's two invariants are enforced.**
- `drivers/zerops/api.ts` — the `ZeropsApi` interface + the real REST client. Every member is annotated
  `VERIFIED:` (read off Zerops' OpenAPI doc) or `UNVERIFIED:`. Keep that annotation honest.
- `drivers/zerops/collaborators.ts` — `{ api, reconcileSchema, sleep }` behind a FACTORY (`(target) => …`),
  because the Zerops client is authenticated per-run from `ctx.target.accessToken`.
- `drivers/zerops/index.ts` — the Zerops driver: compiles + plans in `open()`, executes its four kinds.
- `types.ts` — `CloudflareTarget` / `ZeropsTarget` / `DeployTargets` / `DeployContext` / `JobSpec` /
  `DeployPlan` / `DeployResult`.
- `cli.ts` — `fabrika deploy --env=<env> [--config=<path>] [--dry-run]`; reads creds + secrets from env
  and builds the `cloudflare` target arm.

`deploy(config, ctx, options?)` — `options` is `{ log?, signal?, drivers? }`, all optional.

## Two seams here — do not confuse them

- **WHAT happens and in WHAT ORDER → `DeployDriver`** (a PLATFORM seam). One per target; it owns plan
  derivation AND step execution. A driver may emit an entirely different SET of steps in a different
  ORDER — that is the point, not an accident (ADR-0002).
- **WHAT actually touches the network/filesystem → the DRIVER'S OWN collaborator bundle** (a TESTING
  seam). It is a construction parameter of the driver, NOT of `deploy()` (ADR-0009): Cloudflare's
  `runCommand`/`provision`/`reconcileSchema` are meaningless to a driver that is five HTTP calls, so a
  second driver is constructed with its own bundle. Each driver keeps exactly ONE seam where all its
  side effects live — that is what makes dry-run and unit tests work per driver.

The only collaborators that travel with the RUN (and so reach every driver) are the genuinely neutral
ones: `log` and `signal`. Plus `dryRun`, which is a property of the deploy, not of a bundle.

## Invariants

- **The engine never interprets a step.** `JobSpec.kind` is an OPEN string whose vocabulary belongs to
  the driver; `deploy.ts` only logs and reports it, and executes steps BY ID via the session. Never add
  an `if (kind === …)` / `switch (kind)` to the orchestrator — that logic belongs in a driver.
- **The engine never branches on the platform either.** `ctx.target.platform` selects a driver through
  the `DriverRegistry` MAP and nowhere else — there is no `switch (platform)` outside that map, and the
  lookup stays cast-free (`openSession` is generic over the platform so the registry entry and the run
  stay correlated). If you find yourself reaching for `as`, the union is modelled wrong.
- **The target union is the ONLY per-platform data in the engine.** `DeployContext` keeps what every
  platform has (`env`, `domain`, `secrets`, `vars`, `cwd`, `dryRun`, `propustkaUrl`, `adminKey`); every
  credential and platform handle lives in the discriminated `target`.
- **The CONFIG is narrowed the same way as the target.** `DriverRun<K>.config` is `AppConfigs[K]`
  (`@fabrika/config`), so the Cloudflare driver reads `config.resources` and the Zerops driver reads
  `config.target.services` with no cast and no check. The two arms are inferred independently, so
  `openSession` pairs them once (`appPlatform(config) === ctx.target.platform`) BEFORE any driver sees the
  run. That check names no platform — it compares two discriminants — so the "no branching" rule holds.
- **Plan derivation is pure.** A driver's `open()` gathers the impure inputs (Cloudflare: materializing
  the resource graph); the derivation itself stays a side-effect-free function that is independently
  testable. Keep it that way in every driver.
- **CLOUDFLARE DRIVER — step order is fixed and meaningful:** build → provision-resources → migrate →
  deploy-worker → reconcile-schema → sync-secrets. This is the _driver's_ invariant, not the engine's:
  on Zerops build and deploy are one platform-side step and migrations are a container-start hook, so
  that plan has a different shape. Steps that don't apply are ABSENT, not skipped. propustka is fully
  native (no Cloudflare Access), so there is NO `reconcile-access` step and no `AppAccess` — per-path
  gates are runtime SDK config in each app. A first `reconcile-schema` SELF-REGISTERS the app in
  propustka (`PUT /admin/apps/:app/schema`, no `ACCESS_APPS` gate, so no 404 "unknown app"); it
  authenticates with `ctx.adminKey` (the seeded `px_` provisioning bearer). Any reconcile error is fatal.
- **ZEROPS DRIVER — the plan is a different SHAPE, not Cloudflare's with no-ops:** apply-import →
  trigger-deploy → await-deploy → reconcile-schema. There is **no** `build` (Zerops has its own CI), no
  `deploy-worker` (build+deploy is ONE platform-side operation — what fabrika splits is TRIGGERING from
  OBSERVING, which is the seam ADR-0003's crash-safe reconcile needs), no `migrate` (a container-start
  `run.initCommands` hook), and above all **no `sync-secrets`** — on Zerops the platform is the system of
  record and secrets change without a redeploy (ADR-0004), so pushing them at deploy time would silently
  overwrite a client's GUI edit. `reconcile-schema` is the one shared kind. Never add a no-op step to make
  the two plans rhyme.
- **ZEROPS — ADR-0004's two invariants are enforced STRUCTURALLY, at three layers.** (1) TYPE:
  `ZeropsServiceSpec`/`ZeropsProjectSpec` are the platform contract MINUS `envIsolation`, `envSecrets`,
  `dotEnvSecrets`, `override`, and project-level `envVariables` — an app cannot type them. (2)
  CONSTRUCTION: `compile.ts` BUILDS each entry field by field and writes `envIsolation: 'service'` +
  `override: true` itself; never widen that to `...spec`. (3) ASSERTION: every document passes
  `assertZeropsInvariants` before it is serialized. Plus the `ZeropsApi` has **no project-env write
  method at all** — the absent method IS the invariant. Do not "complete" the client with one.
- **ZEROPS — `startWithoutCode: true` is the provisioning lever** (`compileProvisioningYaml`), which is how
  a service exists before it has code so its secrets can be written: register → import code-free → write
  secrets through the SERVICE-level env API → deploy later. It is NOT set by a normal deploy.
- **ZEROPS — anything marked `UNVERIFIED` must not be able to fail a deploy.** The log service behind
  `GET /project/{id}/log` is a guess; `await-deploy` therefore treats a log-relay failure as a warning and
  decides success/failure from `/app-version` status alone.
- **Nothing spawns a process / calls oblaka / hits propustka directly** — neither the orchestrator nor a
  driver; only via that driver's collaborators. Add new side effects to the bundle, not inline.
- **CANCELLATION is on the run, next to `log`.** `deploy(config, ctx, { signal })`: the orchestrator
  ABANDONS the in-flight step the moment the signal fires (it stops awaiting it — that step is reported
  `failed` with `deploy cancelled`), marks every remaining step `skipped`, and returns `failed`. A run
  cancelled between steps skips the step that never started; a run cancelled after its last step still
  succeeded. Drivers get the SAME signal and must honour it in anything long-running: Cloudflare passes
  it into `CommandSpec.signal` (the `wrangler` child is killed) and re-checks it before each real
  mutation and between the secrets of `sync-secrets`. Ignoring the signal in a driver leaks work; it
  cannot wedge the run.
- **`dryRun` MUST skip every real mutation** (`wrangler deploy` / `d1 migrations apply` / `secret put`,
  the propustka reconciles) and log what it WOULD do; oblaka still runs in plan-only mode. It reaches a
  driver as `DriverRun.dryRun` — wire it through any new step.
- **Shell args are an argv array, never a single shell string** (`CommandSpec.args`) — no shell, no injection.
  Exception: the user's `pipeline.build` runs via `sh -c` by design.
- **Creds are required even in dry-run** (oblaka needs them to materialize the resource graph).
- **`pipeline.vars` injection stays in the engine.** `deploy()` writes `ctx.vars` into `process.env` and
  asserts every declared var resolved BEFORE opening the driver, because a driver materializes the app's
  config and the config reads its vars via `process.env['NAME']`. It's a `@fabrika/config` surface, not a
  platform one. A declared var with no value throws (it does not become a failed step).
- **oblaka state is per-app: `<app id>-state`** (overridable via `ctx.target.stateNamespace`). oblaka keys
  state by env WITHIN the namespace, so apps sharing one account MUST have distinct namespaces or they
  overwrite each other; the default matches the legacy `--state-namespace=<app>-state` pipelines, so a
  migrated app's first fabrika deploy continues its existing state instead of re-provisioning.

## Tests

`bun test` — `src/__tests__/deploy.test.ts` drives the engine + the Cloudflare driver by constructing it
over fake collaborators (`createCloudflareDriver(fakes)`) and passing it in `options.drivers` (no
Cloudflare). `src/__tests__/zerops.test.ts` does the same for Zerops over a fake `ZeropsApi` (no network,
no clock): plan shape, both ADR-0004 invariants at every layer, `startWithoutCode`, dry-run, cancellation.
`fixtures/dryrun-verify.ts` walks the whole path offline with only the oblaka provisioner substituted.
