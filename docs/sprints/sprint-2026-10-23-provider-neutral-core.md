# Sprint — provider-neutral core (2026-10-23)

**Goal.** A provider package holds what is true of its cloud and nothing else, so the next provider writes only that.

**Theme.** About 5,000 of `provider-zerops`' 16,000 lines are knowledge about fabrika, not about Zerops: the IAM
schema reconcile, the managed environment's families, the contract application's build recipe, the proxy entry, the
installation's secrets, service environment, proxy manifest, admin, sidecar and upgrade. The Cloudflare provider
implements much of the same a second time, and the two copies have drifted (IAM retry, managed-environment
validation, the deploy-time checker, the provisioning key's length). Each unit below moves one piece to Control or to
a neutral library, inside ADR-0011: no shared step engine, no shared plan, no provider registry. The batch succeeds
when a third container provider would touch no shared package except to add its own composition root.

## Refs re-verified at HEAD (2026-10-23, `10b52be64`)

- ✔ Both providers apply the approved IAM schema after a deploy succeeds: Zerops as its last step
  (`packages/provider-zerops/src/plan.ts:63`, `provider.ts:993`) and in `cancel`/`reconcile` on an ACTIVE version
  (`control.ts:265`); Cloudflare in `settleOutcome` (`packages/provider-cloudflare/src/control.ts:378`). Control hands
  both `returnOrigins` and its own IAM credentials only for this.
- ⚠ They disagree on an unavailable IAM during `reconcile`: Cloudflare keeps the run `running` on 5xx/408/429 and fails
  on a refusal; Zerops keeps it `running` on any error.
- ✔ The managed environment is an untyped record (`packages/provider-contract/src/control.ts:19`). Zerops parses it
  (`packages/provider-zerops/src/managed-env.ts:42-183`); Cloudflare does not and keeps its own list of the public
  names (`packages/provider-cloudflare/src/managed-secrets.ts`).
- ✔ Only Zerops runs the application's tests, `fabrika-check` and `tsc` at deploy
  (`packages/provider-zerops/src/execution.ts:327`); the Cloudflare runner runs none of them
  (`packages/runner-container/src/runner.ts`), although `ProviderApprovedAccess.checker` says the build checks with it.
- ✔ Shared Control checks a provider name: `packages/control/src/api/registry/environments.ts:181`. `zerops.yaml` is
  hard-coded in `packages/control/src/api/workspaces.ts:313` and `packages/control/src/mcp/handler.ts:207`; approval
  text says "one client on Zerops" (`packages/control/src/approval/diff.ts:277`).
- ✔ `packages/control/src/zerops/{server,runtime}.ts` are the Bun composition root; only `zerops/provider.ts` is Zerops.
- ✔ The provisioning key is 20 random bytes on Cloudflare (`packages/provider-cloudflare/src/installation/init.ts:395`)
  and 32 on Zerops (`packages/provider-zerops/src/installation/secrets.ts:31`).

## Work units

### WU1 — Control applies the approved IAM schema (effort M)

- **Problem.** Each provider calls IAM's admin surface with Control's own credentials after its deploy succeeds, and
  the two copies disagree on failure.
- **Verify first.** Every path that settles a run `succeeded` goes through `executeDeploy`, `settleUnfinishedRun` or
  `settleRunCancellation` (`packages/control/src/run-lifecycle.ts`).
- **Scope.** Control applies `environment.access.schema` and the projected return origins under `<app>@<env>` before
  it marks a run `succeeded`, on all three paths, and logs the dry run. On the awaited deploy any IAM failure fails the
  run; on `reconcile` and `cancel` an unavailable IAM (no answer, 5xx, 408, 429) keeps the run unsettled for the next
  pass and a refusal fails it. The contract loses `returnOrigins`; the providers lose the step, the options and the
  credentials. Cloudflare keeps validating its runner's report. The installation's own schema registration is untouched.
- **Acceptance / witness.** Control tests: a succeeded deploy applies the schema and origins before the row turns
  terminal; an IAM failure fails it; a reconcile with IAM unavailable stays `running` and a refusal fails; a cancel that
  settles `succeeded` applies it; a dry run applies nothing. Provider tests no longer reach IAM.
- **Touch points.** `packages/control/src/{run-lifecycle,services,iam-schema}.ts`, `packages/provider-contract/src/control.ts`,
  `packages/provider-zerops/src/{plan,provider,control,collaborators,types}.ts`,
  `packages/provider-cloudflare/src/control.ts`, `packages/runner-container/src/runner.ts`, both composition roots.

### WU2 — One parsed managed environment (effort M)

- **Problem.** Control assembles the managed environment; Zerops re-parses it and Cloudflare trusts it; each keeps
  its own list of which names are credentials.
- **Verify first.** Every name Control writes is one `parseManagedEnvironment` accepts.
- **Scope.** The families, the credential rule and the parser move to `@fabrika/auth-core` beside
  `FRAMEWORK_VARIABLE_NAMES`. Control parses once and hands `ProviderManagedEnvironment` entries that carry
  `credential: boolean`; a shared helper names the framework variables a deploy no longer hands. Both providers write
  what they are handed and delete what the helper names.
- **Acceptance / witness.** One credential rule; a managed value Control would not produce fails before any provider
  effect on both providers.
- **Touch points.** `packages/auth-core/src/framework-variables.ts`, `packages/control/src/run-lifecycle.ts`,
  `packages/provider-zerops/src/managed-env.ts`, `packages/provider-cloudflare/src/managed-secrets.ts`.

### WU3 — Control states the environment's facts (effort S)

- **Problem.** Providers re-derive what Control already knows: whether a contract application needs the proxy secret,
  that a non-dry deploy needs approved access, the Operations origin.
- **Scope.** `ProviderEnvironment.operationsOrigin`; Control refuses a non-dry deploy without approved access and
  hands the proxy secret only to a contract application. Cloudflare's framework-release gate stays in Cloudflare.
- **Acceptance / witness.** The provider copies are deleted; Control tests cover each rule.
- **Touch points.** `packages/control/src/run-lifecycle.ts`, `packages/provider-contract/src/control.ts`, both providers.

### WU4 — A conformance suite for `ControlProvider` (effort M)

- **Problem.** The contract's semantics (`dryRun`, boundaries, lease loss, envelopes, checkpoints) are tested once per
  provider, by hand.
- **Scope.** `@fabrika/provider-contract/conformance`, on the pattern of `@fabrika/email/conformance`: a provider's own
  test calls it once with a harness over its fake cloud.
- **Acceptance / witness.** Both providers pass it; a negative control (a provider that cancels on lease loss) fails it.
- **Touch points.** `packages/provider-contract/src/conformance.ts`, a test file in each provider.

### WU5 — The contract application's build recipe as data (effort M)

- **Problem.** The build, init and start of a contract application are fabrika's, and live in
  `packages/provider-zerops/src/execution.ts`. Cloudflare runs none of the checks.
- **Scope.** The recipe moves to `@fabrika/app/build`; Zerops renders it into its setup. Running it on the Cloudflare
  runner is a separate decision (it adds the tests and the checker to every Cloudflare deploy) — ask first.
- **Touch points.** `packages/app/src/build.ts`, `packages/provider-zerops/src/execution.ts`.

### WU6 — One proxy entry for an application (effort S)

- **Scope.** A `proxy-core/manifest` helper builds a contract application's manifest entry (host, scheme, endpoint
  table, `operationsOrigin`, `crossOrigins`); the Zerops namespace manifest and the Cloudflare proxy Worker use it.
- **Touch points.** `packages/proxy-core/src/manifest.ts`, `packages/provider-zerops/src/namespace/manifest.ts`,
  `packages/provider-cloudflare/src/{proxy,provider}.ts`.

### WU7 — The Bun host, and capabilities instead of names (effort M)

- **Scope.** `packages/control/src/zerops/{server,runtime,cron,migrate,iam-admin,mcp,operations}.ts` move to
  `packages/control/src/bun/`, taking the provider as a parameter; `zerops/` keeps `provider.ts` and an entry.
  MCP authoring and its protected paths become a provider capability; the strings that name Zerops go.
  `OlderProxyReaders` moves out of `provider-zerops`.
- **Rollout.** The root `zerops.yaml` names the entry; an existing installation reads it at the deployed tag.
- **Touch points.** `packages/control/src/{zerops,bun}/`, `packages/control/src/api/{registry/environments,workspaces}.ts`,
  `packages/control/src/mcp/handler.ts`, `packages/provider-contract/src/control.ts`, `packages/local-stack`.

### WU8 — An open application CLI and checker rules per provider (effort M)

- **Scope.** A provider's `/cli` module declares its entry runtime, `app build`/`register` and its namespace commands,
  loaded the way `installationCliFromModule` loads the installation; the checker takes descriptor rules from the
  provider. `packages/cli/src/index.ts` loses its closed switches.
- **Touch points.** `packages/cli/src/index.ts`, `packages/check/src/rules/crontab.ts`, both providers' `/cli`.

### WU9 — The installation kit (effort L)

- **Scope.** `@fabrika/installation-init` takes the fabrika half of both installations: generated secrets (one copy,
  one provisioning-key length), the service environment of IAM, Control, Operations and the proxy, the platform proxy
  manifest and console schema, MCP/OAuth, the first admin, the sidecar and its pin, `upgrade`, the secrets file. The
  provider keeps topology, provisioning, writing the environment, deploying a service and the order (ADR-0027).
- **Rollout.** Generated files and variable names must not change; any that does states its upgrade path.
- **Touch points.** `packages/installation-init/`, `packages/provider-zerops/src/installation/`,
  `packages/provider-cloudflare/src/installation/`, `packages/platform-artifacts/`.

## Out of scope (explicit)

- **A provider-neutral contract-application target** (an application declares a database, files and runtime scale;
  the provider derives its resources). It changes the framework API and the stored artifact, so it needs its own ADR
  after this sprint.
- A third provider.

## Decisions

- ADR-0011 states the boundary: a provider package holds what is true of its cloud; behaviour that is the same on
  every cloud belongs to Control or to a neutral library.
- WU1 takes Cloudflare's failure rule for `reconcile` (unavailable IAM retries, a refusal fails) and the existing rule
  for the awaited deploy (any failure fails).

## Sequencing

WU1 → WU2 → WU3 touch the same run lifecycle and go in order. WU4 follows WU3, so the suite tests the smaller contract.
WU5, WU6, WU7 and WU9 are independent of each other. WU8 follows WU7.

## Run log

- **WU1.** Control writes the schema through `IamSchemaPort` (`packages/control/src/iam-schema.ts`). A dry run logs
  the write only when the environment already has approved access: a dry run publishes nothing, so a first dry run
  has no schema to name. The Cloudflare platform path (`platformResources: 'allow'`) still registers its own
  component's schema and reads `FABRIKA_IAM_RETURN_ORIGINS` from the installation workflow; only application deploys
  moved.
- **WU2.** `packages/auth-core/src/managed-environment.ts`. The job's wire shape is unchanged (a record of strings),
  so the Cloudflare executor parses it again in `command.ts` and gets the credential flags from the same rule; a runner
  and a Control of different releases still agree. `staleManagedVariables` names only what Control writes (its twelve
  names and the families), not every framework name: Zerops writes framework names of its own (the storage
  provenance, the source-map upload key), and Zerops refuses to delete the descriptor's `FABRIKA_RELEASE`. Cloudflare's
  secret sweep keeps the wider rule (every framework name it does not write), because its executor writes no framework
  secret of its own. Control refuses a run whose environment lacks one of the twelve names, which the Zerops schema
  used to refuse. Cloudflare's
  check that a handed `FABRIKA_CONTRACT_DIGEST` matches the served contract went: the parser refuses the name.
- **WU3.** Every non-dry deploy now publishes a contract first (`ContractMissing` refuses a commit without one), so
  "a contract application" and "a non-dry deploy" are the same set: Control refuses a non-dry deploy without approved
  access, and hands the proxy secret to every non-dry deploy behind a namespace proxy or on a provider with
  `applicationHopSecret`. `operationsOrigin` reaches Cloudflare as a new optional job field; the executor still derives
  the origin from the DSN for a job from an older Control, and an older runner strips the field.
- **WU4.** `packages/provider-contract/src/conformance.ts`: six cases over a harness that reports the cloud's
  mutations, its stops and the provider's own credentials. A lost lease is simulated as Control does it (the signal
  aborts, every later event rejects): at the first event, at EACH event of a complete deploy in turn (the sweep reaches
  Zerops' upload and await-version boundaries, which a single hook did not), and when the fake cloud accepts the
  operation, which then also calls `reconcile` and `cancel` under the same lost signal. Cancel and checkpoint-recovery
  semantics differ by design (Zerops leaves a reserved version to `cancel()`, Cloudflare stops its job), so the suite
  does not fix them. The negative control is `src/__tests__/fixtures/cancelling-provider.ts`, run in a child process;
  a Zerops wait that cancels on lease loss fails the sweep (checked by hand).
- **WU6.** `contractProxyEntry` (`packages/proxy-core/src/manifest.ts`) checks the entry with the proxy's own
  `contractProxyAppSchema` instead of a copy of its rules, so Zerops' hand-written origin and cross-origin checks went.
  Cloudflare's proxy Worker and `@fabrika/app/testing`'s `endpointProxy` build through it too. The wire form is unchanged.
- **WU5.** `contractRecipe` (`packages/app/src/build-recipe.ts`, exported from `@fabrika/app/build`) is the build,
  init, start and jobs as data; `provider-zerops` now depends on `@fabrika/app`, as `provider-cloudflare` already did.
  The rendered `zerops.yaml` is byte-identical: the exact-output tests in `execution*.test.ts` and
  `released-manifest.test.ts` pass unchanged. The file jobs' names moved to a leaf module (`files/job-names.ts`), so the
  recipe loads without the file stack. Not done: running the recipe on the Cloudflare runner, which is a decision.
- **WU7.** The Bun host is `packages/control/src/bun/`: `createRuntime(composition, …)` takes a
  `BunProviderComposition` (the provider and its commit source), and `runControlServer`, `runMaintenanceProcess` and
  `runMigrationProcess` replace the `import.meta.main` blocks. `src/zerops/` keeps `provider.ts` (`zeropsComposition`)
  and thin entries at the old paths, so `zerops.yaml`, the package exports `./zerops/runtime` and `./zerops/server`,
  and the local stack run unchanged. `ControlProvider.authoring` (`{ protectedFiles }`) replaces the `zerops` id check
  of an authoring target and the hardcoded `zerops.y[a]ml` of `isProtectedPath` and the `apply_changes` description.
  `OlderProxyReaders` lives in `@fabrika/proxy-core/manifest`; `provider-zerops` re-exports it. The Zerops-specific
  `zerops/older-proxies.ts` stays in Zerops' composition. `controlMcpRoute` takes the provider and refuses to start
  when it declares no `authoring`, so MCP never runs with an empty protected list. Reviewed by an independent agent:
  no P1; both P2s (that default, and no test of the runtime's wiring) and the stale paths fixed.
- **WU8 (the CLI).** `@fabrika/provider-contract/app-cli`: a provider's `/cli` exports `appCli` (entry runtime,
  `build`, `deploy`, `registrationManifest`, `namespaces`), loaded by `appCliFromModule` from
  `@fabrika/provider-<id>/cli`. `packages/cli/src/index.ts` lost its provider switches; a command a provider does not
  declare is refused with its id. Zerops' namespace planning moved to `provider-zerops/src/namespace-cli.ts`; the CLI
  keeps the Control RPC half (origin, credential, transport, printing), so no provider depends on `control-contract`.
  Not done: the checker's descriptor rule (`check/src/rules/crontab.ts`). `fabrika-check` runs in the build as
  `bun x -p @fabrika/check@<release>` with no provider installed, so taking the rule from the provider changes what the
  checker depends on or how the build runs it — a decision. App and namespace commands take a provider id only, and the
  Control token stays out of the provider's environment. Reviewed by an independent agent: its P1 (a test that did not
  typecheck), its P2 (a module specifier on `/cli`) and the cheap P3s fixed.
- **WU9 (first slice).** `@fabrika/installation-init` now holds the generated secrets (`secrets.ts`), fabrika's half of
  the service environment for a bring-up and for a deploy, the IAM proxy secret's derivation
  (`service-environment.ts`), the secrets file (`secrets-file.ts`), the manifest template type with
  `resolvePlatformProxyManifest` (`proxy-manifest.ts`), MCP/OAuth (`mcp.ts`) and the tag rule (`pin.ts`). Zerops supplies
  its `${db_…}`/`${storage_…}` references, `iam:3000` and control's `FABRIKA_ZEROPS_*` variables. Every value and
  name is unchanged (a before/after dump of the bring-up matrix, the deploy's writes, the served manifest and the
  secrets file differs only in the order control's variables are PUT: the `FABRIKA_ZEROPS_*` ones now follow
  fabrika's, and the mail variables precede them). One provisioning-key length: Cloudflare generated `px_` + 20 bytes,
  Zerops `px_` + 32 bytes with the leading `-`/`_` re-roll; both now use `randomPxKey` (32). No existing installation
  sees it: Cloudflare resumes its key from the env file, Zerops never regenerates one, and IAM checks no length. The
  Cloudflare Operations sync and runner keys gain the same re-roll. Not done: `upgrade` (Zerops only; Cloudflare has no
  roll command), moving the generated template and console schema out of `provider-zerops` (their ports and upstreams
  are Zerops topology, so the template first needs splitting into tables and placement), and a Cloudflare use of the
  service environment (its per-component environment lives in the scaffolded workflow and each `fabrika.config.ts`,
  which an upgrade must not change).
