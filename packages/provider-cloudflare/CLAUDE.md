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
- **`reconcile-schema` REPORTS, it does not call IAM.** The step writes `RunnerOutcomeFile`
  (`$FABRIKA_RUNNER_OUTCOME_FILE`) with the app id and the schema as JSON; the control-side `deploy`
  validates both fields after the runner validates the container's `/status` envelope, requires the
  reported app to be the deploying app, bounds and parses the JSON with `parseAppSchema` — which
  applies IAM's own `isActionAllowed` rule to every role permission — and only then calls the
  `SchemaReconciler` with its own key and the projected return origins.
- **`cloudflareRunnerJobSchema` validates VALUES.** UUID run id, `https:` repo URL, a ref with no leading
  `-` and no whitespace, `[a-z0-9-]` env, contained relative `workerDir`/`configPath`, literal
  `domain`. Every field becomes an argv element, a path or a hostname inside the container.
- **The authored graph is bounded before any Cloudflare call** (`assertAuthoredGraph`): no
  `PLATFORM_RESOURCE_NAMES` name — as a declared resource, as the oblaka state namespace, or as a
  `ServiceReference` target (IAM's `propustka-worker`, at its application entrypoint, is the one binding every app may keep) — no
  Worker off the `APP` chain, and every route on the run's own domain. `platformResources: 'allow'` exists for fabrika deploying its OWN components (the
  installation CLI and `dryrun-verify`); a checkout is never opened with it.
- **The bound is on the name oblaka ADOPTS, `${env}-${name}`, not the authored one.** An env name may
  contain `-`, so env `prod-propustka` + Worker `worker` lands on IAM's `prod-propustka-worker`. A
  remote name that equals or ends with `-<platform name>` is refused, whatever the env/name split.
  The state namespace is the one exception — `KVStateStorage` uses it verbatim, so it is matched exactly.
- **An app binds IAM only at its `PropustkaApplication` entrypoint** (`iamServiceReference()`,
  `IAM_APPLICATION_ENTRYPOINT` in `src/proxy.ts`), and so does the proxy Worker the provider builds.
  IAM's default export also issues and revokes keys and approves devices, which only platform
  components (`platformResources: 'allow'`) may bind. `assertApplicationServices` checks the `services`
  a Worker's config CARRIES, never the binding's class — a checkout's own `Bindable` or a
  `ServiceReference` subclass emits whatever it likes: an entry naming IAM's remote Worker without
  `PropustkaApplication`, or naming any other platform service, is refused. It runs twice: in
  `assertAuthoredGraph` on the bindings folded in oblaka's order (a later binding can rewrite an earlier
  entry), and in `deploy-worker` on each config oblaka generated, before its `wrangler deploy`, because a
  stateful binding can emit differently the second time. The entrypoint name is pinned against IAM's
  exports by `packages/iam/src/__tests__/index.test.ts`.
- **`Worker.options` is an ALLOWLIST for an app (`APP_WORKER_OPTIONS`), not a denylist.** oblaka spreads
  every option but `dir`/`bindings`/`deleteDurableObjectsOnRemoval` verbatim into the generated wrangler
  config, so a raw `services`, `durable_objects`, `r2_buckets` or `build` key would bind or run what the
  typed `bindings` walk never sees. Adding a key to the allowlist is a security decision: it must not be
  able to name a resource, run a command, or publish a directory. Only `platformResources: 'allow'` skips it.
- **An application Worker is reachable only through its proxy's `APP` binding (ADR-0048).**
  `assertUnexposedApplication` (`src/plan.ts`) refuses a non-empty `routes`, and any `workers_dev` or
  `preview_urls` other than `false` — Cloudflare turns both URLs on by default. Only the root that
  `createCloudflareProxyWorker` builds is exempt: `CLOUDFLARE_PROXY_WORKER_MAIN`, from this package's own
  `src` (the runner's copy or a checkout's `node_modules` copy), binding `APP`. Every other Worker, the root
  included, is an application Worker. `platformResources: 'allow'` skips it (IAM routes its own Worker). Repository code holds the account token, so on Cloudflare this is a
  strong default, not a boundary (backlog 86).
- **`assets` is ALLOWED but BOUNDED** (`assertBoundedAssets`). Its `directory` is resolved against the
  generated `wrangler.jsonc`'s own directory and uploaded publicly, and wrangler's walk ignores only
  `.assetsignore`/`_redirects`/`_headers` — no dotfile or `.git` skip — so `.` on a root `workerDir` would
  publish the checkout's `.git/config` and the clone token in it. It must be a relative path with no `..`,
  no `.git` segment, and at least one real segment; sub-keys are their own allowlist (`APP_ASSETS_OPTIONS`).
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
- **This package is one of the four that relax two strict flags for oblaka** — see the root
  CLAUDE.md. Keep our own code strict; never work around oblaka with a cast.
- **The plan is ordered step kinds**, not free-form work: `build` → `provision-resources` →
  `migrate` → `deploy-worker` → `reconcile-schema` → `sync-secrets`. `runSteps` executes them in the
  order supplied and never interprets a step's `kind`.
- **The proxy topology is: public Worker owns the route, private application Worker is bound to it.**
  IAM remains a global service binding, at its application entrypoint. See ADR-0022.
- **Proxy invocation logs stay disabled.** The reserved handoff callback carries a one-time code in
  its query string, and Cloudflare's automatic invocation metadata is outside the proxy's redaction
  layer. Structured application logs remain enabled and redact request queries.
- **Never log credentials or secret values** — including an error object from a failed `wrangler`
  invocation, whose output can quote a clone URL with an embedded token.

## Platform installation (`./installation`, `src/installation/`)

The Cloudflare implementation of `@fabrika/provider-contract/installation`; `@fabrika/cli` loads it.
`fabrika platform init --provider=cloudflare <account>` stands up an account's platform base and
scaffolds a workflow that deploys IAM, Operations, then the runner/control pair — every stage through
`platform deploy`, because each names a platform resource. `plan` and `deploy` take either the
runner/control pair (`--runner-config` + `--worker-config`) or one component (`--component-config`);
the two forms are mutually exclusive. Each component deploys through `deployCloudflareConfig`.

- `installation.ts` — `installationCli`: init, plan, and deploy dispatch. `index.ts` — the subpath surface.
- `init.ts` — the orchestrator: CF token → account/zones → smart-default prompts → vault key → provisioning
  key → runner key → scaffold repo → GitHub Environment → trigger. It creates no GitHub App: the operator
  connects GitHub from the console at **Settings → Source** after install (ADR-0029), as on Zerops.
- `scaffold.ts` — which files `<org>/fabrika-platform` carries (`templates/`: `platform.yml`, `fabrika.ref`,
  `README.md`, `gitignore`) and the legacy two-ref migration that must stop a refresh.
- `cloudflare.ts` — CF API helpers and response schemas. `envfile.ts` — env-file resume.
- Prompts, console formatting, child processes, `gh`, the GitHub Environment write and the repository
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
- **Idempotent + resumable.** Every captured value persists to that file; a re-run reuses generated
  values (vault key, provisioning, runner and signing keys) instead of rolling them.
- **No GitHub credential in the Environment.** Every GitHub App key lives in Control's vault; the
  Environment and the Worker secrets carry none.
- **The provisioning key is a SEEDED `px_` key:** the CLI generates one opaque `px_` bearer
  (`FABRIKA_IAM_PROVISIONING_KEY`); IAM admits a bearer matching it as a synthetic admin (`resolveCaller`),
  and fabrika reconciles its schema with it. No local IAM mint. Stage 1 deploys IAM from the shared
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
