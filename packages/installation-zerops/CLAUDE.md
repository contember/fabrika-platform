# @fabrika/installation-zerops

The Zerops implementation of `@fabrika/installation-contract` plus the typed
platform topology and generated installation artifacts.

Four public commands. `fabrika platform plan --provider=zerops` validates the
generated artifacts against Zerops' published schemas. `fabrika platform deploy
--provider=zerops` brings an EXISTING installation to this checkout, unattended
and idempotently — the full surface is in the `usage` string in `src/index.ts`,
which is also what the generated workflow is written against. `fabrika platform
init --provider=zerops <installation>` creates and maintains the operator's
sidecar repository that calls it. `fabrika platform install --provider=zerops`
CREATES one, in a project the operator made empty.

**`install` is the only command that creates an installation; `init` and `deploy`
both refuse to.** It runs first and hands `init` the provisioning key it generated.
The bring-up is two passes, because `zeropsSubdomain` names nothing until the proxy
has deployed HTTP ports while the manifest must be written before the proxy is
built: pass 1 gives the proxy the legal EMPTY manifest and builds it, and only then
can the three public hosts be READ off the subdomains it published.

**On Zerops `platform deploy` owns the WHOLE ordered sequence; on Cloudflare it
stays narrow and the scaffolded workflow keeps the order.** That asymmetry is
[ADR-0027](../../docs/decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md)
and is deliberate — someone reading only one path will guess wrong about the other.

## Layout

- `src/index.ts` — exported `installationCli`, the `usage` text, and the real collaborators.
- `src/deploy.ts` — the ordered deploy sequence. `src/deploy-options.ts` — its flags and variables.
- `src/install.ts` — the from-scratch bring-up: the two passes and the whole environment matrix.
  `src/install-options.ts` — its flags. `src/secrets.ts` — the seven values it generates.
- `src/init.ts` — the sidecar-repository flow, its prompts and its confirmed outward steps.
- `src/sidecar.ts` — what the sidecar repository contains + the tag rule. `src/templates/` — its four files.
- `src/manifest.ts` — composing the platform's apps with an installation's application entries.
- `src/hosts.ts` — where one installation answers. `src/log.ts` — progress, with no secret-taking helper.
- `src/proxy-manifest.ts` — the proxy manifest TEMPLATE type and `resolvePlatformProxyManifest`.
- `zerops/setups.ts` — typed IAM, Operations, source, proxy, and control setup definitions.
- `zerops/topology.ts` — project and service topology.
- `zerops/proxy-manifest.ts` — the three fronted apps and their gates. **Dev-time only.**
- `zerops/console-schema.ts` — the console's `AppSchema`, copied from `@fabrika/control`. **Dev-time only.**
- `zerops/render.ts` — generated artifact writer and `--check` verifier.
- `zerops/generated/` — committed installation artifacts.
- `zerops/schemas/` — pinned published schemas and refresh script.

## Invariants

- The generated root `zerops.yaml` is the only platform build specification.
  Do not add per-package `zerops.yaml` files.
- Keep credentials out of generated artifacts.
- Do not claim real-account support from schema validation or dry runs.
- Preserve the import-without-code → write service secrets → deploy bring-up
  order. `platform install` is that order, executed.
- **`platform install` GENERATES credentials, which is why it is a third command
  and not a flag on either of the other two.** It writes seven generated secrets plus
  a minted Zerops integration token, and prints exactly ONE value — the provisioning
  key, once, at the end, because it is stored nowhere else and `platform init` asks
  the operator for it. That is the only exception to the no-secret-in-a-log rule on
  this path; `src/log.ts` still has no helper that takes a value.
- **`install` is a BRING-UP and never a reconcile.** It refuses a project that
  already carries its generated secret KEYS (checked by key, never by value) —
  re-rolling the vault KEK is unrecoverable and re-rolling the signing keys logs
  everyone out — and it skips the provisioning import when the services already
  exist, because re-applying `startWithoutCode` at a service carrying code activates
  an EMPTY app version. A partial set of services is refused, not completed.
- **The import step WAITS on every process it is handed, before it reads or writes
  anything.** Live-measured: `importServices` returns immediately, the services are
  created sequentially in `priority` order ~15 s apart, and a service holds NO
  environment at all — not even the platform's generated keys — until it leaves
  `NEW`. Never replace that wait with a sleep, and never assume the process count:
  it is 1 per managed service and 2 per runtime one. A service already reading `NEW`
  when the command starts is refused, because no process id for it exists here.
- **`install` never restates the deploy order.** Pass 2 is `deployPlatform`, whole;
  pass 1 reuses `deployPlatformService` for the proxy alone. One service is not an
  order.
- **`platform deploy`'s order is IAM → Operations → source → proxy → control, and the
  proxy's position is a SECURITY property, not a dependency.** Since ADR-0022 the
  application enforces nothing, so control at a new version behind the previous,
  more permissive manifest is an open `/api/*` for the length of the deploy.
  Operations owns separate `operationsdb` and `operationsstorage` services; only
  the proxy may expose its ingest and source-map paths.
- **`platform deploy` MERGES the proxy manifest, never replaces it.** On the light
  tier an application shares the project and therefore the platform proxy's one
  `FABRIKA_PROXY_MANIFEST_JSON`; the generator emits only the three platform apps,
  so composing them with the application entries is the deploy's job. A live entry
  standing on one of the platform's own public hosts is superseded and reported —
  a host belongs to exactly one app.
- **`platform deploy` writes no credential, and reads every credential it holds
  from the environment.** There is no `--token` and no `--admin-key`; an unknown
  flag is an error precisely so one cannot arrive on a command line. Every secret
  an installation holds is placed at bring-up.
- **`platform init` keeps deployment credentials off disk.** Both GitHub Environment
  secrets already belong to the installation (the operator's Zerops integration
  token, and the `px_` provisioning key IAM was seeded with). The source upgrade
  generates one RPC key only when neither source nor control has one, and writes
  it directly to those Zerops services. A valid key on only one side repairs the
  absent side; a matching pair is reused; invalid or mismatched values are refused.
  GitHub App creation is the narrow exception: its one-time PEM and webhook secret first enter an
  owner-only recovery file under `${XDG_STATE_HOME}/fabrika-platform/zerops-init/`, then init fills only
  absent live keys and deletes the file after durable Zerops credentials and exact App identity and
  webhook configuration verify. Installation access is checked independently on every rerun. The
  private key ends on source and the independent webhook secret on control; neither enters the sidecar
  or GitHub Environment. A partial or mismatched live bundle is refused rather than overwritten.
  The loopback lock coordinates this host only. Run one operator per Zerops project; cross-host safety
  relies on create-only remote writes and final repeated readback, which detects rather than serializes
  a concurrent writer.
- **`init` confirms before every step that leaves the operator's disk**: reading
  the project, configuring source, creating or pushing the repository, writing
  the Environment, and triggering the run.
  Declining stops the outward steps and prints what to run; a re-run is safe.
- **The sidecar pin is a published TAG and a branch is refused twice** — by
  `assertPinnedTag` when init writes `fabrika.ref`, and by the generated workflow
  at run time, because that file is operator-owned afterwards. What the tag pins is
  what the pipeline DOES; it does not pin the revision Zerops BUILDS, because a
  Zerops build source names a repository and not a revision. The generated README
  says so; do not quietly imply otherwise.
- **The sidecar Environment holds no admission list.** No bootstrap-admin variable
  is written, because the deploy neither reads nor writes one — so there is no
  escape hatch here for an operator to remember to close later.
- **Every write is read-compare-write, so a re-run changes nothing.** `GET
  /service-stack/{id}/env` works on every service (`docs/reference/zerops-platform.md`),
  which is what makes the comparison possible; `putServiceEnv` stays write-first
  because it must also work on a service that has never been deployed.
- Every managed service names its `profile` explicitly. An import cannot change
  one afterwards, and omitting it silently buys `oltp-production` on HA.
- Every setup declares both `run.healthCheck` (liveness) and
  `deploy.readinessCheck` (the deploy gate), with every duration written as a
  quoted Go duration inside `[10s, 1h]`. `zerops/validate.ts` retypes the six
  duration properties the published schema gets wrong; do not widen that list
  without a live observation.
- A PostgreSQL URL is always
  `${<host>_connectionString}/${<host>_dbName}?sslmode=require`.
- **`zerops/proxy-manifest.ts`, `zerops/console-schema.ts` and `zerops/render.ts` are EXCLUDED from the
  published `files`, and that is load-bearing.** All three import `@fabrika/control` — a PRIVATE package
  — through a devDependency, so shipping any of them would put an unresolvable import in the tarball.
  What ships instead is `src/proxy-manifest.ts` (types + resolver) plus
  `zerops/generated/platform-proxy-manifest.ts` (the gate sets) and
  `zerops/generated/platform-console-schema.ts` (the console's vocabulary), both as DATA. `src/deploy.ts`
  reads the generated pair and never reaches a generator; if you add a file here that imports a
  devDependency, exclude it in the same change.
- **The proxy manifest is split into a committed template and a deploy-time placement.** The template
  is installation-independent (ids, upstreams, listener ports, gates) and `gen:check` proves it still
  matches the gate modules. Hosts and scheme are one installation's, so they are arguments. A
  `ProxyManifest` cannot carry the template alone — `parseProxyManifest` refuses an app with no hosts —
  which is why the template is a type of its own rather than a manifest with the hosts left empty.
- `enableSubdomainAccess` in a generated artifact is a DECLARATION, never a mechanism: the platform
  accepts it and drops it. Applying a `zerops-subdomain` artifact publishes nothing until an operator
  calls `PUT /service-stack/{id}/enable-subdomain-access` on the deployed proxy, and the artifact's
  generated header says so. Do not remove that header note without removing the field too.
