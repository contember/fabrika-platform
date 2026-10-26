# @fabrika/provider-cloudflare

The Cloudflare provider bundle: app authoring (`defineApp`), the deploy plan and its executor, the
control-side provider, and the proxy topology. Assumes the root CLAUDE.md. Implements the open
contracts in `@fabrika/provider-contract`; `createCloudflareDeployer` runs the plan through the
contract's `runSteps`.

It re-exports `oblaka-iac` wholesale, so an app's `fabrika.config.ts` gets its resource types from
this one import.

## Invariants

- **This package OWNS `CloudflareRunnerJob` and its validator.** The Worker↔container transport
  schemas, types and endpoint constants live in `src/runner-protocol.ts`, re-exported from the oblaka-free
  `./runner` entry; `@fabrika/runner-container` owns the Bun process and
  image; `@fabrika/runner-cloudflare` owns the executor Worker. Provider job semantics stay here.
- **Installation credentials never enter a persisted envelope.** `CloudflareStoredTarget` holds
  coordinates only; the account credentials go to `createCloudflareDeployer` when it is constructed,
  and never into a `CloudflareDeployRun`.
- **The container gets the Cloudflare account credential and NOTHING else.** `job.credentials` is
  exactly `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`, `cloudflareRunnerJobSchema` refuses any other
  key, and the checkout's own `pipeline.build` child runs with those names removed from its
  environment (`CommandSpec.omitEnv`). IAM's provisioning key never leaves the control plane.
- **Neither the executor nor this provider calls IAM for an application (ADR-0011).** The executor writes
  `RunnerOutcomeFile` (`$FABRIKA_RUNNER_OUTCOME_FILE`); the control-side `deploy` and `reconcile` only validate its
  report: a report without Control's approved access, or from a dry run, fails the run. Control writes the approved
  contract's `access.schema` (ADR-0050) and the return origins itself once the run succeeds, whatever the runner reported.
- **A platform deploy (`allow`) registers its component's schema with IAM ITSELF** (ADR-0058). The installation's own
  deploy runs fabrika's code and holds IAM's provisioning key, so `reconcile-schema` calls IAM at
  `CloudflareDeployerOptions.platformIam` (`FABRIKA_IAM_ISSUER` + `FABRIKA_IAM_PROVISIONING_KEY`, read by
  `installation.ts`) with the run's return origins, and fails naming them when they are absent. There is no outcome
  file outside the runner. IAM's own config declares no schema: its keys sync after its Worker deploys, so the pair
  form (executor + control plane) reconciles IAM's vocabulary (`IAM_APP_SCHEMA`, ADR-0058) after the console's.
- **An application deploys only with a contract.** With `platformResources: 'refuse'` the deployer refuses a
  checkout without `fabrika.contract.ts` before anything runs, and always builds the proxy Worker from the
  contract's endpoint table. `platformResources: 'allow'` (fabrika deploying its own components) needs none.
  `configSchema` refuses a config that declares `gates` on either path, and reads the IAM `schema` ONCE, before
  `resources()` runs the checkout's code (parsed with `appSchemaSchema`, deep-frozen); never read `config.schema`
  after it. An application (`refuse`) may declare no schema: the plan then has no `reconcile-schema`, nothing is
  reported, and Control writes the approved contract's schema as it always does. A platform deploy (`allow`) that
  serves a contract registers the schema itself, so it must declare one. A declared one must say `contract: true`
  (`assertContractSchema`). `createCloudflareProxyWorker` takes an endpoint table or an installation table, and refuses `gates`.
- **The job carries Control's approved access** (`CloudflareRunnerJob.approvedAccess`: the contract and its
  digest). Control refuses a non-dry deploy without it, the job schema refuses one too, and it parses the contract and
  checks its digest. The runner writes it to `<workspace>/<runId>.access.json` beside the checkout and names it in
  `FABRIKA_APPROVED_ACCESS_FILE`, set after every job-supplied name; the executor reads it (`readApprovedAccess`)
  before the config runs. Unset outside a runner (a local deploy).
- **A contract application from framework 0.9 runs in its Durable Object; an older one keeps its stateless Worker**
  (ADR-0065, ADR-0062). The release gate is `runsInObject` (`src/contract-support.ts`), read from the release the
  application pins: `applicationRelease(ProviderEnvironment.access)` in `control.ts`, which also fills
  `CloudflareRunnerJob.approvedAccess.framework`, the release the deployer reads. Before 0.9, `control.ts` refuses a job's, a webhook's
  or a public procedure's key, installation mail and token purposes (`assertStatelessEnvironment`) before the runner is
  asked, and sends no `FABRIKA_PROXY_SECRET`; the deployer gives that Worker no object, bucket or tick. An approved
  access that names no release (a Control older than the runner) deploys the stateless shape; a run without approved
  access (a local deploy) deploys the object.
- **What an application on Cloudflare cannot run is refused twice** (`assertCloudflareContract`): in `control.ts`
  before the clone, and in the deployer from the contract it serves. A file kind or collection with `scan: true` (no
  scanner runs there), and a procedure's or a webhook's `timeoutMs` above `CLOUDFLARE_MAX_HANDLER_MS` (25 s): the
  handler holds the object's transaction, and workerd resets an object whose transaction runs about 30 s. By the release
  it runs as (`CloudflareContractGates`): from `capsJobSegments` (`0.9.0-dev.5`, see below), a job's `timeoutMs` above
  `CLOUDFLARE_MAX_JOB_SEGMENT_MS` (14 min) too, while an older pin and a Control that names no release are not capped;
  below `servesRawSql` (`0.9.0-dev.5`), a site that declares `sql`, whose boot that release refuses on SQLite, and a
  Control that names no release refuses it too. A local deploy runs the object as this release (ADR-0062).
- **The platform writes the application Worker's runtime** (`withApplicationRuntime` in `src/provider.ts`, from 0.9):
  `FABRIKA_APPLICATION` bound first to its own `FabrikaApplication` (`new_sqlite_classes`, so oblaka numbers its one
  migration `v0001` whatever else the application binds, and the tag never moves), `FABRIKA_FILES` to the environment's
  bucket `<env>-<app>-files`, and `triggers.crons` always written when the contract has a job or a file kind: from
  `servesAlarms`, for a release Control names, the hourly repair tick `<m> * * * *` at a minute derived from
  `<env>-<app>` (stable across deploys; the object's alarm runs the jobs); otherwise, for a local deploy or a 0.9.0
  prerelease before the alarm, `* * * * *`.
  Without a job or a file kind it is `[]`, which clears an older tick (wrangler leaves schedules alone when `triggers`
  is absent). The names are
  `@fabrika/app/build`'s. `assertNoFrameworkVariables` refuses an authored binding of either name and authored
  `triggers` before anything is generated; `assertApplicationRuntime` (`src/bounds.ts`) refuses any other object binding of that name or
  class, a `script_name` on it, a migration history that does not open with that `v0001` or names the class again
  (a committed `wrangler.jsonc` with a history of its own), another `FABRIKA_FILES` bucket, and triggers the platform
  did not write.
- **Two kinds of release gate** (`src/contract-support.ts`). `releaseAtLeast` counts a prerelease as its minor:
  `runsInObject`, `pinsGeneratedEntry` and `servesOps` hold from every 0.9.0 prerelease. `releaseFrom` compares the whole
  version in semver precedence: `servesDataOperations` (the barrier's `state` and `migrate`, the backups, the migration
  phase, the side restore), `servesAlarms`, `capsJobSegments` and `servesRawSql` hold from `0.9.0-dev.5`, because the prereleases on
  npm before it (`dev.0`–`dev.4`, `cloudflare.1`–`cloudflare.2`) run in the object without any of them, and a platform
  upgrade keeps deploying them as they ran (ADR-0062). Every `cloudflare.<n>` sorts below `dev.5` and keeps the older
  behaviour. A new gate on something those prereleases lack uses `releaseFrom`; `published-prereleases.ts` lists them
  for the tests. Every gate reads the application's pin (`applicationRelease`: `ProviderApprovedAccess.framework`),
  never `checker`, which is this platform's patch of the pin's minor and would pass every `releaseFrom` gate for a
  prerelease pin. An access approved before Control recorded the pin reads as `<major>.<minor>.0-0` of its reader:
  the minor gates hold, every `releaseFrom` gate fails closed. An older Control still sends `checker` as the job's
  `framework`, so its runs keep that error until Control is upgraded; an older runner reads the pin as it read
  `checker`. `dataOperations` on the control provider answers `servesOps && servesDataOperations`.
- **From `servesOps` the platform composes Control's ops channel** (ADR-0069, `src/provider.ts`): `platformProxied`
  builds the proxy's table with `contractProxyTable(…, { ops: true })`, which adds the canonical ops row, and
  `withApplicationRuntime` writes `FABRIKA_APPLICATION_OBJECT` and `FABRIKA_APPLICATION_OBJECTS` as plain vars from the
  pointer Control records (`ProviderDeployInput.applicationObjects`, which the runner forwards as
  `FABRIKA_RUNNER_APPLICATION_OBJECTS`), by default `application` and `application,rehearsal` (the ops channel also
  reaches the object a backup is rehearsed in, ADR-0070); a side restore moves it (ADR-0070 §9). Only for a release Control names; an environment without a domain gets no row (no Custom Domain carries it). An
  older pin, a Control that names no release and a local deploy get neither, and a later deploy without them drops
  them with the version's vars. The proxy Worker forwards the row's request to `APP` with `Authorization` and no token,
  as the decision marks every `protocol` row; authored copies of the variables are refused by the framework-variable
  rules below.
- **From `pinsGeneratedEntry` the application Worker runs only the entry the deploy regenerates** (`src/contract-support.ts`).
  For a release Control names at or above that gate, `assertGeneratedEntry` (`src/bounds.ts`) requires the Worker's
  `main` to resolve to `fabrika/entry.generated.ts` beside the config, and refuses `workflows`, `containers` and any
  Durable Object binding but `FABRIKA_APPLICATION`: the generated entry exports none of them. The plan then always has
  `build`: `pipeline.build` first, if any, then the application's own `fabrika app build --provider=cloudflare` in the
  config's directory, so the entry and the inlined migrations come from the pinned commit, not the committed copies.
  The CLI is the first `node_modules/.bin/fabrika` from the config's directory up to the executor's working directory
  (where the runner installed), never above. It is checkout code whose failed output is logged, so it inherits nothing
  of the executor's environment, which carries the application's and the managed secrets: it gets `PATH`, `HOME` and
  `TMPDIR` only. An older release, a Control that
  names no release, and a local deploy keep their authored `main` and the old plan (ADR-0062).
- **Every managed credential is a Worker secret, uploaded with the version** (`src/managed-secrets.ts`): token keys,
  workload keys, mail, the platform transport, the Operations DSN, the IAM RPC key and the proxy secret. The executor
  parses what its job carries with `parseManagedEnvironment` (`@fabrika/auth-core`, in `command.ts`), and an entry is a
  secret exactly when it is a `credential` (`isManagedCredential`, fail closed); the identities, origins and the release
  are plain vars. `wrangler deploy --secrets-file` (wrangler 4.74 or newer) reads them from a 0600 file in a
  directory of its own, removed however the deploy ends; never write one into a generated config. After the deploy,
  `deleteStaleSecrets` deletes each framework secret the Worker still holds that this deploy no longer writes.
- **Control issues a proxy secret per environment** because the provider declares `applicationHopSecret`
  (`createCloudflareControlProvider`): the application Worker forwards every request to its object with it, and the
  object refuses a request without it.
- **Every framework variable of each generated config is the platform's** (`assertFrameworkVariables` in
  `src/bounds.ts`, before provisioning and before each deploy): a binding's `configureBinding` writes the config
  after the deployer injected its values, so the config is where `FABRIKA_CONTRACT_DIGEST` is checked.
- **`checkoutRelativeDirectory` is the one application-root normalization.** The runner resolves `workerDir`
  with it, and `applicationRoot` hands it to Control, which reads the run's snapshot there. Never add a second.
- **`cloudflareRunnerJobSchema` validates VALUES.** UUID run id, `https:` repo URL, a ref with no leading
  `-` and no whitespace, `[a-z0-9-]` env, contained relative `workerDir`/`configPath`, literal
  `domain`. Every field becomes an argv element, a path or a hostname inside the container. `crossOrigins` passes
  `isCrossOrigin`, at most `MAX_CROSS_ORIGINS`, each once, never `domain`'s host.
- **The environment's cross-origin list reaches the proxy Worker it builds** (ADR-0022 "Cross-origin endpoints"):
  `ProviderEnvironment.crossOrigins` → `CloudflareRunnerJob.crossOrigins` → `FABRIKA_CROSS_ORIGINS` (a JSON array the
  runner sets last, like `FABRIKA_INSTALLATION_APPS`) → `CloudflareDeployRun.crossOrigins` → `createCloudflareProxyWorker`.
  There is no namespace proxy to republish: an operator's change applies on the environment's next deploy.
- **The generated wrangler configs are the one thing checked** (`src/bounds.ts`), never the objects that
  emitted them: a checkout's own `Bindable`, a `ServiceReference` subclass or a raw option writes whatever it
  likes into a config. `generateWranglerConfigs` runs oblaka's own `ResourceProcessor` (a deep import of
  `oblaka-iac/src/commands/…`, so a pin bump re-checks it) with every resource applied in dry-run mode and a
  client that refuses to authenticate, before provisioning; `assertGeneration` checks those configs, every
  resource the run applies by the remote name it adopts (a KV namespace's config holds only its id), and that
  every D1 `database_id` and KV `id` is one this run handed out. `assertGeneratedConfigs` runs again in
  `deploy-worker` on the configs oblaka really wrote, before the first `wrangler deploy`, because a stateful
  binding can emit differently the second time. `platformResources: 'allow'` exists for fabrika deploying its
  OWN components (the installation CLI and `dryrun-verify`); it keeps only the route bound. A checkout is
  never opened with it.
- **What a generated config may carry:**
  - keys only from `CONFIG_KEYS`; anything else (`build`, `site`, `tail_consumers`, an unreviewed binding
    kind) is refused. Adding a key is a security decision: it must not be able to name a resource, run a
    command, or publish a directory. The platform proxy's config alone may also carry `define`, exactly the one
    `PROXY_MANIFEST_DEFINE` literal the deployer baked (`assertBakedManifest`);
  - exactly one application config beside the platform proxy's: "only the application Worker and its proxy
    are deployable";
  - on every name it binds — the Worker's own name, `services`, D1, R2, queues, containers, workflows, a
    Durable Object's `script_name` — no `PLATFORM_RESOURCE_NAMES` name and no other application's name. The
    bound is on the REMOTE name: an env name may contain `-`, so env `prod-propustka` + Worker `worker` lands on
    IAM's `prod-propustka-worker`; a remote name that equals or ends with `-<platform name>` is refused. The
    state namespace is matched exactly, because `KVStateStorage` uses it verbatim;
  - an application config has no `routes`, and `workers_dev` and `preview_urls` are `false`. Cloudflare turns
    both URLs on by default. Only the proxy the deployer built is routed, and only on the run's own domain.
    Repository code holds the account token, so on Cloudflare this is a strong default, not a boundary
    (backlog 86).
- **An app binds IAM only at its `PropustkaApplication` entrypoint** (`iamServiceReference()`,
  `IAM_APPLICATION_ENTRYPOINT` in `src/proxy.ts`), and so does the proxy Worker the deployer builds. IAM's
  default export also issues and revokes keys and approves devices, which only platform components
  (`platformResources: 'allow'`) may bind. The entrypoint name is pinned against IAM's exports by
  `packages/iam/src/__tests__/index.test.ts`.
- **Every IAM binding names its own application in `props`** (ADR-0067 §3). The deployer wraps the application Worker's
  `IAM` binding in `IamApplicationReference`, which stamps `props: { app: '<app>@<env>' }` on the generated entry, and
  the proxy Worker's binding carries the same. IAM reads it as `ctx.props.app`, the caller's transport identity, so the
  bounds refuse an IAM binding under any name whose `props` are not exactly that.
- **A checkout's Worker graph is rebuilt from this package's `Worker` class** (`runnerWorkerGraph`,
  `src/checkout.ts`). The checkout installs its own `oblaka-iac`, so `instanceof Worker` fails on its objects,
  and oblaka's processor itself recurses only into Workers of its own class. A Worker is recognised by
  `getId().resource === 'worker'`; its options are carried over as they are, and other bindings stay the
  checkout's objects. `isolated-checkout.test.ts` deploys a config with a second copy of `oblaka-iac`.
- **`assets` is ALLOWED but BOUNDED** (on the generated config). Its `directory` is resolved against the
  generated `wrangler.jsonc`'s own directory and uploaded publicly, and wrangler's walk ignores only
  `.assetsignore`/`_redirects`/`_headers` — no dotfile or `.git` skip — so `.` on a root `workerDir` would
  publish the checkout's `.git/config` and the clone token in it. It must be a relative path with no `..`,
  no `.git` segment, and at least one real segment; sub-keys are their own allowlist (`ASSETS_KEYS`).
- **A contained `assets.directory` is then WALKED on disk** (`src/assets.ts`). wrangler `stat`s each asset
  instead of `lstat`ing it, so a committed symlink to `/proc/self/environ` or to `.git/config` would upload
  publicly; the walk uses `lstat` and refuses the first link, or anything that is neither a regular file nor
  a directory, bounded at 50 000 entries. A missing directory is wrangler's own error and is left to it.
  `platformResources: 'allow'` skips the walk.
- **That walk runs in the `deploy-worker` step, immediately before each `wrangler deploy` spawn** — NOT in
  the deployer's checks before the first step, which stay pure of it. The checkout's own `pipeline.build` runs between the two, so a build
  line `ln -s /proc/self/environ public/x` would defeat a check made any earlier. One check, at the only
  moment the tree wrangler reads is final; never add an early duplicate, which would imply a guarantee
  those checks cannot give.
- **Codecs validate on the way in.** A module default imported from a runner checkout is untrusted —
  narrow it with `isCloudflareAppConfig`, never assume the shape.
- **`defineApp` without `resources` builds the application Worker itself** (`src/authoring.ts`), from the values the
  bounds require: name `<app>` (remote `<env>-<app>`, the deployment's own prefix), `main`
  `./fabrika/entry.generated.ts`, `routes: []`, `workers_dev` and `preview_urls` off, `IAM` as
  `iamServiceReference()` after the author's `worker.bindings`; only `worker.bindings`, `compatibility_date` and
  `compatibility_flags` are the author's. It does so inside the checkout's own package, and the config it returns
  always carries `resources`, so `isCloudflareAppConfig` reads it as before. Never move the default into the
  deployer. An executor older than this release still refuses a schema-less contract config (`assertContractSchema`);
  it never meets one, because such an application pins a framework release Control refuses until the platform is at
  least as new (`readerFor`, ADR-0062), and an installation deploys its runner with its Control from one `fabrika.ref`
  (the pair form: the runner first, then Control).
- **The local run is composed by the deploy's code** (`composeLocalApplication`, `src/provider.ts`): the platform proxy,
  the IAM identity, the connector bindings, the object, the files bucket and the repair tick of a release that serves
  alarms, with the framework values and a fresh proxy secret written as plain vars into the ignored `wrangler.jsonc`.
  The composition helpers take an `ApplicationTarget`, the part of a run they read, so both paths share them. No deploy
  calls it.
- **This package is one of the four that relax two strict flags for oblaka** — see the root
  CLAUDE.md. Keep our own code strict; never work around oblaka with a cast.
- **The plan is ordered step kinds**, not free-form work: `build` → `provision-resources` →
  `migrate` → `deploy-worker` → `reconcile-schema` → `sync-secrets`. `build` is present when the config sets
  `pipeline.build` or the release pins the generated entry. `runSteps` executes them in the
  order supplied and never interprets a step's `kind`.
- **The proxy topology is: public Worker owns the route, private application Worker is bound to it.**
  IAM remains a global service binding, at its application entrypoint. See ADR-0022.
- **Every application's proxy Worker is the platform's (ADR-0048).** The config's `resources` returns the
  application Worker; a Worker that binds `APP` (a proxy of its own) is refused. The deployer wraps it in
  `createCloudflareProxyWorker`, named `<app>-proxy`, from this package's own entrypoint and directory — the
  runner image's copy, never a checkout's `node_modules` copy. The proxy enforces the contract application's
  endpoint table (`contractProxyTable(artifact)`). The contract is the one Control approved
  (`CloudflareDeployRun.contract`). Only outside Control is it read from the config's directory by
  `@fabrika/check/contract`'s static reader (`readContract` collaborator) — never evaluated. The deployer writes
  `FABRIKA_CONTRACT_DIGEST` into the application Worker. The proxy's manifest is baked into its bundle through
  wrangler's `define` (`PROXY_MANIFEST_DEFINE`, read by `proxy-worker.ts` as `__FABRIKA_PROXY_MANIFEST__`), not a
  Worker variable, which Cloudflare caps at 5,120 bytes; the wire format is unchanged. An IAM schema whose `contract: true` disagrees with the
  contract is refused. The manifest entry carries the contract's CSP origins and the origin of the run's
  Operations ingest (`operationsOrigin`, never the key): Control names it (`ProviderEnvironment.operationsOrigin`, the
  job's `operationsOrigin`, `FABRIKA_OPERATIONS_ORIGIN` set last by the runner); a job from an older Control names none,
  and the executor derives it from `FABRIKA_OPERATIONS_DSN`. The Worker replaces every header of the policy on
  the application's answer, or applies the file treatment for a download endpoint or a `response: 'file'` row, sets a cacheable row's lifetime
  on its 200 (`applyAnswerCache`), deletes the reporting
  headers, and answers a throwing `APP` binding with a fixed 502 and a missing one with a 503 under the same
  treatment (to a navigation that selects no download, the status's page from `@fabrika/proxy-core`); on an `https` entry both carry HSTS, and on `http` the application's own is dropped. A Worker that
  cannot initialize (no `IAM`, no issuer) answers its fixed 503 with the treatment of the host the manifest names
  (ADR-0022).
  `createCloudflareProxyWorker` takes exactly one of `endpoints` or `installation`. `installation`
  (an installation service's `serviceProxyTable`) is the trusted marker of ADR-0022 "Installation
  entries": only the platform's own service configs pass it, and the deployer never builds it from an
  application's config. Its `IAM` binding is also the delegation issuer the proxy asks for grants. An authored variable under a `FRAMEWORK_VARIABLE_NAMES` name is refused.
- **Another application's names are refused** (ADR-0048). Control sends `<app>@<env>` of every Cloudflare
  deployment in its registry (`CloudflareRunnerJob.installationApps` → `FABRIKA_INSTALLATION_APPS` →
  `CloudflareDeployRun.installationApps`). A remote name belongs to the deployment with the longest
  `${env}-${app}` prefix (exact, or followed by `-`); one that belongs to another application is refused on
  every name the generated configs and the applied resources carry. It is a naming rule, not an ownership
  record (backlog 86). The one exception is the deployer's own: each import of the served contract gets a
  `FABRIKA_CONNECT_<IMPORT>` service binding to the owner's proxy Worker (`<env>-<owner>-proxy`), and
  `DeploymentBounds.connectors` admits exactly that binding, by name and remote, on the application Worker. An
  authored binding under a framework name is refused like an authored variable. Control writes the import's
  `_KEY` (a Worker secret) and `_URL` as managed values.
- **Proxy invocation logs stay disabled.** The reserved handoff callback carries a one-time code in
  its query string, and Cloudflare's automatic invocation metadata is outside the proxy's redaction
  layer. Structured application logs remain enabled and redact request queries.
- **Never log credentials or secret values** — including an error object from a failed `wrangler`
  invocation, whose output can quote a clone URL with an embedded token.

## Application CLI (`./cli`, `src/cli.ts`)

`appCli` (`@fabrika/provider-contract/app-cli`) is what `fabrika app build` and `app deploy` run: the Cloudflare entry
runtime, `build` (nothing beyond the generated entry, and refused without a contract) and `deploy`. `runCloudflareCli`
stays the runner container's `fabrika-cloudflare-executor`.

## Platform installation (`./installation`, `src/installation/`)

The Cloudflare implementation of `@fabrika/provider-contract/installation`; `@fabrika/cli` loads it.
`fabrika platform init --provider=cloudflare <account>` stands up an account's platform base and
scaffolds a workflow that deploys IAM, Operations, then the runner/control pair — every stage through
`platform deploy`, because each names a platform resource. `plan` and `deploy` take either the
runner/control pair (`--runner-config` + `--worker-config`) or one component (`--component-config`);
the two forms are mutually exclusive. Each component deploys through `deployCloudflareConfig`.

- `installation.ts` — `installationCli`: init, plan, and deploy dispatch. `index.ts` — the subpath surface.
- `init-options.ts` — `parseInitArgs`: every init input is a flag or the variable beside it (flag first; the
  variables are the Environment's own names), credentials from the environment only, `--yes` for unattended.
- `init.ts` — the orchestrator: CF token → account/zones → IAM and email config → vault key → provisioning
  key → runner key → scaffold repo → GitHub Environment → trigger. It creates no GitHub App: the operator
  connects GitHub from the console at **Settings → Source** after install (ADR-0029), as on Zerops.
- `scaffold.ts` — which files `<org>/fabrika-platform` carries (`templates/`: `platform.yml`, `fabrika.ref`,
  `README.md`, `gitignore`) and the legacy two-ref migration that must stop a refresh.
- `cloudflare.ts` — CF API helpers and response schemas. `envfile.ts` — env-file resume.
- Confirmations, console formatting, child processes, `gh`, the GitHub Environment write and the repository
  mechanics live in `@fabrika/installation-init`. This code decides only the Cloudflare-specific flow. The
  Cloudflare and Zerops inits are not mirror images (ADR-0027).

Invariants:

- **NEVER print a secret VALUE.** The single intentional exception is the vault KEK, printed ONCE (the
  operator must capture it — unrecoverable if lost). Secret values flow only into the env file, `gh`
  over stdin, and the GitHub Environment.
- **The env file lives at `$XDG_CONFIG_HOME/fabrika/cloudflare/<account>/.env`** (0700 directory, 0600
  file), never in the cwd — it holds the account API token, the vault KEK and IAM's signing key, and the
  cwd is routinely an unrelated repository. `envPath()` is the single source of that path and
  `openEnvFile(account)` binds it, loads it into `process.env` (Bun no longer auto-loads it) and must run
  before any `persistEnv`. Never claim the file is gitignored. A `$PWD/.env` is warned about, because Bun
  loaded it first and its values outrank the per-account file.
- **`init` prompts for nothing.** A missing value is an error naming its flag and variable; the only
  questions are the confirmations (`Confirmations`), which `--yes` answers. The env file is opened BEFORE
  the arguments are parsed, so a resumed run reads its earlier answers as environment variables. It saves
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, the two `FABRIKA_IAM_*_ENABLED` switches,
  `FABRIKA_IAM_OIDC_ISSUER`/`_CLIENT_ID`/`_CLIENT_SECRET`, every `FABRIKA_EMAIL_*` the mail transport collected
  (`readInstallationEmail`: the provider, the sender and the provider's own variables) and the generated keys. The hosts, the repository, the checkout and the admins are NOT saved; a re-run
  names them again (the rerun command init prints on a declined step carries them).
- **Idempotent + resumable.** Every captured value persists to that file; a re-run reuses generated
  values (vault key, provisioning, runner and signing keys) instead of rolling them.
- **No GitHub credential in the Environment.** Every GitHub App key lives in Control's vault; the
  Environment and the Worker secrets carry none.
- **The provisioning key is a SEEDED `px_` key:** the CLI generates one opaque `px_` bearer
  (`FABRIKA_IAM_PROVISIONING_KEY`, `@fabrika/installation-init`'s `randomPxKey`: 256 bits, as on Zerops; a 160-bit key
  an earlier release generated is resumed unchanged, and IAM checks no length); IAM admits a bearer matching it as a
  synthetic admin (`resolveCaller`), and fabrika reconciles its schema with it. No local IAM mint. Stage 1 deploys IAM from the shared
  `contember/fabrika-platform` checkout and needs its OIDC and signing config in the Environment.
- **Operations deploys between IAM and control.** Init records `OPERATIONS_HOSTNAME`, creates
  `OPERATIONS_SYNC_KEY`, and supplies the public IAM issuer. The Operations hostname exposes only ingest
  and source-map upload; control reaches catalog and operator surfaces through a private service binding.
- **`platform init` triggers the scaffolded GitHub Actions pipeline; it does not deploy from the laptop.**
  `platform plan` and `platform deploy` execute the runner and control configs and remain distinct from
  app deployment.
- **Runner images are account-owned.** Every scaffolded workflow run builds the image from the exact
  `fabrika.ref` checkout into the target account. Upstream CI never publishes a shared runner image.
- **Scaffold pushes never deploy.** Both initial and refresh commits use `[skip ci]`; init dispatches the
  workflow explicitly only after it writes the target GitHub Environment.
