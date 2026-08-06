# @fabrika/installation-zerops

The Zerops implementation of `@fabrika/installation-contract` plus the typed
platform topology and generated installation artifacts.

Three public commands. `fabrika platform plan --provider=zerops` validates the
generated artifacts against Zerops' published schemas. `fabrika platform deploy
--provider=zerops` brings an EXISTING installation to this checkout, unattended
and idempotently — the full surface is in the `usage` string in `src/index.ts`,
which is also what the generated workflow is written against. `fabrika platform
init --provider=zerops <installation>` creates and maintains the operator's
sidecar repository that calls it.

**Neither `init` nor `deploy` creates an installation.** The first bring-up
(import the topology without code → write every secret → deploy once, so the proxy
has HTTP ports and therefore a public address) is still a hand sequence: before it,
`zeropsSubdomain` names nothing, so the manifest — which has to be written before
the proxy is built — has no hosts to carry.

**On Zerops `platform deploy` owns the WHOLE ordered sequence; on Cloudflare it
stays narrow and the scaffolded workflow keeps the order.** That asymmetry is
[ADR-0027](../../docs/decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md)
and is deliberate — someone reading only one path will guess wrong about the other.

## Layout

- `src/index.ts` — exported `installationCli`, the `usage` text, and the real collaborators.
- `src/deploy.ts` — the ordered deploy sequence. `src/deploy-options.ts` — its flags and variables.
- `src/init.ts` — the sidecar-repository flow, its prompts and its confirmed outward steps.
- `src/sidecar.ts` — what the sidecar repository contains + the tag rule. `src/templates/` — its four files.
- `src/manifest.ts` — composing the platform's apps with an installation's application entries.
- `src/hosts.ts` — where one installation answers. `src/log.ts` — progress, with no secret-taking helper.
- `src/proxy-manifest.ts` — the proxy manifest TEMPLATE type and `resolvePlatformProxyManifest`.
- `zerops/setups.ts` — typed IAM, Operations, control, and proxy setup definitions.
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
  order.
- **`platform deploy`'s order is IAM → Operations → proxy → control, and the
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
- **`platform init` GENERATES no credential and persists none.** Both Environment
  secrets already belong to the installation (the operator's Zerops integration
  token, and the `px_` provisioning key IAM was seeded with), so a value invented
  here would not be one the installation accepts. They are read from a hidden
  prompt or the environment, sent to GitHub over `gh` stdin, and — unlike the
  Cloudflare init — never written to a `.env`.
- **`init` confirms before every step that leaves the operator's disk**: creating
  the repository, pushing it, writing the Environment, triggering the run.
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
