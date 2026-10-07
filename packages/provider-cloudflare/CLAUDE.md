# @fabrika/provider-cloudflare

The Cloudflare provider bundle: app authoring (`defineApp`), the deploy plan and its executor, the
control-side provider, and the proxy topology. Assumes the root CLAUDE.md. Implements the open
contracts in `@fabrika/provider-contract`; `createCloudflareDeployer` runs the plan through the
contract's `runSteps`.

It re-exports `oblaka-iac` wholesale, so an app's `fabrika.config.ts` gets its resource types from
this one import.

## Invariants

- **This package OWNS `CloudflareRunnerJob` and its validator.** `@fabrika/runner-contract` holds
  only transport types and endpoint constants; `@fabrika/runner-container` owns the Bun process and
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
  `ServiceReference` target (IAM's `propustka-worker` is the one binding every app may keep) — no
  Worker off the `APP` chain, and every route on the run's own domain. `platformResources: 'allow'` exists for fabrika deploying its OWN components (the
  installation CLI and `dryrun-verify`); a checkout is never opened with it.
- **The bound is on the name oblaka ADOPTS, `${env}-${name}`, not the authored one.** An env name may
  contain `-`, so env `prod-propustka` + Worker `worker` lands on IAM's `prod-propustka-worker`. A
  remote name that equals or ends with `-<platform name>` is refused, whatever the env/name split.
  The state namespace is the one exception — `KVStateStorage` uses it verbatim, so it is matched exactly.
- **`Worker.options` is an ALLOWLIST for an app (`APP_WORKER_OPTIONS`), not a denylist.** oblaka spreads
  every option but `dir`/`bindings`/`deleteDurableObjectsOnRemoval` verbatim into the generated wrangler
  config, so a raw `services`, `durable_objects`, `r2_buckets` or `build` key would bind or run what the
  typed `bindings` walk never sees. Adding a key to the allowlist is a security decision: it must not be
  able to name a resource, run a command, or publish a directory. Only `platformResources: 'allow'` skips it.
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
  IAM remains a global service binding. See ADR-0022.
- **Proxy invocation logs stay disabled.** The reserved handoff callback carries a one-time code in
  its query string, and Cloudflare's automatic invocation metadata is outside the proxy's redaction
  layer. Structured application logs remain enabled and redact request queries.
- **Never log credentials or secret values** — including an error object from a failed `wrangler`
  invocation, whose output can quote a clone URL with an embedded token.
