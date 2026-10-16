# @fabrika/provider-zerops

The Zerops provider bundle: app authoring (`defineApp`), the `zerops-import.yaml` compiler, the typed
REST client, the deploy plan, deployment namespaces, and the control-side provider. Assumes the root
CLAUDE.md. A Zerops deploy is HTTP calls and nothing else — there is no runner (ADR-0003).

**Read [`docs/reference/zerops-platform.md`](../../docs/reference/zerops-platform.md) before changing
anything here.** It records facts settled against a real account, several of which contradict Zerops'
published documentation. Do not re-derive them.

## Commands (this package)

```bash
bun run gen:schema   # regenerate src/schema.generated.ts from Zerops' published JSON schema
bun test
```

## Invariants

- **`src/schema.generated.ts` is GENERATED — never edit it by hand.** It is a faithful transcription
  of the platform contract (a 202-value service-type enum and a nested `zerops.yaml` object, both of
  which move whenever Zerops adds a runtime version). It is deliberately NOT the authoring surface:
  what an app may declare is `src/types.ts`, which SUBTRACTS the fields fabrika owns.
- **ADR-0004's two invariants are enforced structurally at three layers in `src/compile.ts`**, so
  "someone forgot" is not a reachable state: the TYPES make `envIsolation`, `envSecrets`,
  `dotEnvSecrets`, `override`, and project-level `envVariables` unauthorable; the compiler BUILDS
  each entry rather than copying and patching, writing `envIsolation: 'service'` itself from the one
  construction site; and `assertZeropsInvariants` checks every document before serialization. The
  failure prevented is concrete — with `envIsolation: none` (legal, and not reliably the default)
  every service sees every other service's variables, so one app's credentials leak to another.
- **Deploy-time variables are substituted into the DOCUMENT, never into rendered YAML.**
  `interpolateManifest` (`src/provider.ts`) walks the import document's string leaves and returns a new
  document; `renderYaml` runs after it, so a value carrying `"`, a newline or `- hostname:` is emitted as
  a scalar and stays data — the `|-` block form is used ONLY for text that survives it (`blockScalarSafe`
  in `src/compile.ts`), everything else is JSON double-quoted. **That guarantee is stated against a YAML
  1.1 reader**, because Zerops parses with go-yaml: 1.1 ends a line on NEL/LS/PS and refuses a raw C1
  control, and Bun's 1.2 reader does neither. So `isYamlHostileCodePoint` keeps those out of a block and
  the double-quoted form escapes them `\uXXXX` (keys included — they share `scalar()`). Never certify the
  emitter with `Bun.YAML.parse` alone: it cannot see the difference, so assert on the rendered TEXT.
  Substitution then re-runs
  `assertZeropsInvariants`, refuses a value that moved a service's `hostname`/`type`/`envIsolation`/
  `override` or anything in `project`, refuses a placeholder in a key or one a value carried in, and
  refuses a value naming a foreign service. Never splice a value into the YAML text: every structural
  check in this package runs on the object.
- **`override: true` goes on EVERY service, managed ones included, and it is not an update.** Live-verified:
  without it a re-apply is `400 serviceStackNameUnavailable` and the whole document fails; with it an
  existing service is left exactly as it is, so a changed `profile`/`maxContainers`/`objectStorageSize`
  is silently ignored. `assertZeropsInvariants` refuses a document missing it. Never describe the
  steady-state import as "reconciling"; change a live field through the API that owns it.
- **A namespace's PostgreSQL profile moves only through `updates` (`src/namespace/update.ts`).** `plan`
  checks the requested payload STRICTLY (`namespaceUpdatePayloadSchema`: the target schema strips unknown
  keys, which would make a misspelt field a silent no-op), lays its top-level fields over the stored target,
  and refuses every other change, the PostgreSQL type included, as `PROVIDER_NAMESPACE_IMMUTABLE`
  (`FIXED_FIELDS` lists every target field, so a new one fails to compile until it is classified). The one other
  move is a re-pin: `proxySource: "current"` sets the installation's default pin and nothing else, touches no
  platform resource, and is refused while a proxy build is in flight; Control stores it `pending` and queues the
  reconcile that rebuilds the proxy (ADR-0045). `apply`
  calls `configureAutoscaling` and decides by reading `autoscalingProfileId` back, within ~90 s. A platform
  4xx on the PUT is a definite failure; anything once the PUT is sent is
  `PROVIDER_NAMESPACE_UPDATE_UNCONFIRMED`, and a retry must converge: `validateService`
  (`src/namespace/validation.ts`) reads a live service on the profile being applied, or on the one an
  earlier unconfirmed update planned (`input.unconfirmed`), as the change in progress, and any other
  profile than the declared one as drift. UNVERIFIED: how soon the read-back shows the new profile live.
- **`compileProvisioningYaml`'s output is first-bring-up only.** Re-applying it at a service that carries
  code activates an EMPTY app version and demotes the running one to `BACKUP`.
- Application registration uses `renderFabrikaProvisioningYaml` with `override: false` to refuse
  first-creation collisions (ADR-0044). Preserve `override: true` in the canonical manifest and
  steady-state imports; await every returned import process before completing registration.
- **An import document CANNOT establish a `.zerops.app` subdomain** — `enableSubdomainAccess` is accepted
  and dropped, on a service the document creates as much as on one `override` leaves alone. Only
  `PUT /service-stack/{id}/enable-subdomain-access` does, and only once the service publishes a DEPLOYED
  HTTP port (`400 serviceStackIsNotHttp` before that — and for up to a minute after the first version reads
  ACTIVE, so `enableSubdomainAccessWhenHttp` retries that answer for ~3 minutes). Its 2xx proves nothing — on an already-published
  service it returns a process that then fails — so decide by reading `subdomainAccess` back.
  `ensureSubdomainAccess` in `src/namespace/provisioning.ts` is the one place that does this; it runs after the proxy
  deploy, on reconcile too, and throws rather than leaving a namespace with no public entry point.
- **The published `zerops.yaml` schema is wrong about the six probe durations** (`integer`; the platform
  wants a Go duration string in `[10s, 1h]`). `src/types.ts` carries the corrected `ZeropsDuration` and
  the `*Spec` authoring types — do NOT try to fix `schema.generated.ts`.
- **The compiler is PURE** — no network, no filesystem, no clock.
- **Unverified API behavior stays marked `UNVERIFIED:`.** Every shape in `src/api/types.ts` was read off
  Zerops' published OpenAPI document; the log service and a handful of behaviors were not. Do not
  quietly promote one to fact — check it against a real account first.
- **The API token is a PERSONAL ACCESS TOKEN with account-wide admin rights.** Never log it, never
  put it in an error message, never return it from a method.
- **Service hostnames are constrained** (`^[a-z0-9]{1,25}$`). Shared-namespace names are derived
  deterministically from the app id (`src/service-names.ts`) — do not hand-build one.
- **A `${host_KEY}` reference may name only the app's OWN declared hostnames plus the namespace's shared
  services** (`src/service-references.ts`) — Zerops resolves one across services whatever `envIsolation`
  says. `parseFabrikaManifest` refuses a foreign host anywhere in a declared service or in the PARSED
  `sourceDescriptor`; never scan that as text, because a folded break, a `\x24` escape or a block scalar
  hides a reference the text does not spell. Hostnames are never rewritten at deploy. The rule covers every
  app-supplied path into a service's env — the manifest, `interpolateManifest`, and `secrets.put`
  (`src/control.ts`), which lands on the same resolver.
- **No application may reference a `superUserPassword` variable, of any host** (`platformOnlyServiceReference`,
  `src/service-references.ts`, ADR-0017). The superuser is the provisioning credential, in the same container
  environment as application code. The same three paths refuse it, and so does the source descriptor's executed setup.
- **An application service cannot expose itself or choose its own build (ADR-0043), with no approval
  path.** `REFUSED_APPLICATION_SERVICE_FIELDS` (`src/manifest.ts`) refuses an `objectStoragePolicy` other
  than `private`, any `objectStorageRawPolicy`, `buildFromGit`, `zeropsYaml`, `mount` or `startWithoutCode`, and an
  `enableSubdomainAccess`/`enableCdn` other than `false`, in `parseFabrikaManifest` — so on build AND on
  every decode. The same boundary writes `objectStoragePolicy: private` on an object-storage service that
  omits it, because nothing establishes Zerops' default. Keep both out of `compileService`: the installation and namespace topologies compile through
  it and set `enableSubdomainAccess`, `objectStoragePolicy` and `enableCdn` on their own services.
- **Persisted target envelopes hold coordinates only.** Credentials are composed for a live run.
- **The control provider's `deploy` decodes the artifact ONCE and runs `createZeropsDeployer` in-process**
  on that typed value.
- **Only `FABRIKA_RELEASE` (and, for a contract application, `FABRIKA_CONTRACT_DIGEST`) is bound to a
  version (ADR-0044).** `overlayRelease` (`src/managed-env.ts`) writes the release as a LITERAL into the
  selected setup's `run.envVariables` of the execution descriptor; it is never a service variable, and
  `write-service-env` never deletes one: `/env` lists a deployed version's descriptor variables, and Zerops
  refuses to delete them (`userDataDeleteForbidden`). The other managed keys (`FABRIKA_PROXY_SECRET` and the membership transport's
  `FABRIKA_IAM_RPC_URL` and `FABRIKA_IAM_RPC_KEY` among them) are plain service variables each deploy
  overwrites (null removes), all written before the build request so it never meets `userDataSyncRunning`.
  App vars, secrets and descriptors may not author any name of `FRAMEWORK_VARIABLE_NAMES` (`@fabrika/auth-core`,
  the one list Control refuses too); `MANAGED_KEYS` is the part of it Control hands every deploy.
  Beside them Control hands each job's and webhook's key (`FABRIKA_<KIND>_<NAME>_KEY`) and each connector
  import's `FABRIKA_CONNECT_<IMPORT>_KEY` and `_URL` (`parseManagedEnvironment`: a `px_` key, an https origin, or
  the deploy is refused, and so is any other family name): `write-service-env` writes each and deletes every
  service variable of those families that this deploy did not hand, so a removed workload's or import's key does
  not stay readable.
- **A contract application's setup is the platform's (ADR-0043, `src/execution.ts`).** A config with
  `target.contract` compiles to a manifest with `target.contract` (digest, health path, jobs) and optional
  `runtimePackages` from `ZEROPS_RUNTIME_PACKAGES`. `lockedAuthoredBuild` refuses every key of the selected
  setup except `build.base`, `build.os` and `build.buildCommands`, in `parseFabrikaManifest`, so on build AND
  decode. The manifest must also carry the endpoint table of the same contract (`proxy.snapshot` equals
  `contract.digest`, from `contractDigest`), and an endpoint table without the contract is refused.
  `renderLockedExecutionDescriptor` sends ONLY the generated setup: the SPA commands, the frozen install, the
  application's tests, then — because the tests are authored code — a reinstall, the regenerated entrypoint,
  the checker fetched by THIS package's version (`FABRIKA_CHECK_VERSION`: Control runs the git checkout of its
  tag, so it is the source version, which a release bumps before tagging), `tsc` with the platform tsconfig and
  the scripts. Keep the tests before every step that produces or checks what deploys. The start script runs
  `fabrika db migrate`, then `fabrika db codegen --verify`, then `fabrika db test-isolation` (the generated tests on
  a throwaway schema), then `exec`s the server, so a failed migration, a stale `schema.generated.ts` or a generated
  case that did not pass fails the httpGet readiness check whether or not a failed `initCommands` stops
  activation (it does, verified live 2026-10-16); the build has no database. The run section names the application's one PostgreSQL
  (`FABRIKA_APP_DATABASE_URL`) and its one object-storage service (`FABRIKA_APP_STORAGE_*`) only as `${<host>_…}`
  references, so no credential passes through this package. That database URL is the service's SUPERUSER on the direct
  port (`zeropsProvisioningDatabaseUrl`, `src/manifest.ts`) and only the provisioning credential of the application's
  role family (ADR-0017): `fabrika db migrate` creates `app_<id>` and `run_<id>` with it and the server and the jobs
  relaunch themselves as `run_<id>`. The `db` user can neither create roles nor create a schema, and pgBouncer on
  `portTls` refuses the roles fabrika creates (measured 2026-10-15), so never point it back at `db` or `portTls`. A
  `cheap` application gets the same URL for the shared `postgres`; its binding's `connectionString` is the `db` user's
  and is never the provisioning credential. A second database or bucket is refused in
  `parseFabrikaManifest`, and `verify-exposure` refuses a bucket without platform provenance before the build. Generated file lines go through
  `printf` single-quoted: they may hold no `'` and no `$`, which is why the app id must match
  `[a-z0-9][a-z0-9-]*` and the health path is a literal path.
- **A contract build uploads its SPA source maps last, and never fails on them (backlog 36).** When Control hands
  `artifactUpload`, `write-service-env` writes its bearer as the SENSITIVE service variable
  `FABRIKA_SOURCE_MAP_UPLOAD_KEY` (and removes it from a run without one), and the generated build lifts it with
  `build.envVariables: ${RUNTIME_FABRIKA_SOURCE_MAP_UPLOAD_KEY}` beside the literal `FABRIKA_SOURCE_MAP_UPLOAD` (the
  destination without the bearer, and `zeropsAssetRoots` of the APPROVED contract: each SPA mount and share link, by
  prefix). The descriptor never holds the bearer; a directory or prefix carrying `${` is refused. The last build command is
  `fabrika-source-maps` of `@fabrika/check@FABRIKA_CHECK_VERSION`, `|| true`. The relay reads its report line from the build
  log (`readSourceMapUploadReport`): a succeeded run reports `artifactState: 'complete'` only when that line said so, else
  `incomplete`. Every build command, the authored ones included, can read the bearer, and so can the runtime until the
  next deploy replaces it: it reaches only this run's release and expires two hours after the run started.
- **`raise-start-memory` raises the deploy service's minimum RAM before a version is reserved (ADR-0043).** The start
  script's `fabrika db test-isolation` peaks above the runtime's 0.125 GB faster than vertical autoscaling reacts, so
  `zeropsStartMinRam` (`src/execution.ts`) names the floor: 0.5 GB with a database, 2 GB with a scanner. An import
  cannot change an existing service, so the step reads `customAutoscaling` back, sends it WHOLE with only
  `minResource.memoryGBytes` changed, under the keys `verticalAutoscaling` / `horizontalAutoscaling`, and decides by
  reading `currentAutoscaling` back. Measured live: a field left out, and the whole object under the published OpenAPI's
  `…Nullable` keys, is silently RESET with a 200. The reader reads an autoscaling with any unreadable field as absent,
  and the step then refuses rather than reset a field. It only raises.
- **`size-database` sizes each process's database connections before a version is reserved (ADR-0043).** Pure in
  `src/database-budget.ts`: `max_connections` follows the database's minimum RAM step and profile; 7 are never an
  application role's and 5 are one container's start script; the rest is shared by twice the deploy service's maximum
  container count (10 when it reads none) and one process per crontab job (`zeropsJobProcesses`, the same list the
  crontab is rendered from), at most 10 each. Below 2 the step raises the application's OWN database through the same
  read-modify-write as `raise-start-memory` (`raiseMinRam`); measured live, `max_connections` follows in ~15 s through
  one restart of a single-node database. A namespace's shared `postgres` is never raised. The count is the literal
  `FABRIKA_APP_DATABASE_CONNECTIONS` of the generated run section (`sizedExecution`); a build of an application with a
  database is never sent without it. Change the budget's constants only with a measurement.
- **Before a version can activate, `verify-exposure` reads every declared service back (`src/exposure.ts`).**
  `subdomainAccess` must be exactly `false` (absent or unreadable is a refusal), and every object-storage
  service must be created by this run's import (`stack.create`) or named by the `FABRIKA_STORAGE_PROVENANCE`
  marker on the deploy service, or listed in the stored target's `createdBuckets`: the first registration keeps
  there the buckets its collision-refusing import created, and the deploy writes them into the marker. **The
  import's answer is the only evidence of creation**, so `apply-import` merges the buckets it created into the
  marker (`recordCreatedBuckets`) before any other step, on a signal only a lost lease aborts; never move that
  write later. A sensitive marker (releases up to v0.4.2) names nothing and is rewritten readable. An
  adopted bucket never gets evidence, and its refusal names the operator's remedies. A refusal fails the run before a
  version is reserved and raises an Operations alert through the application's own ingest DSN
  (`alertExposure`, best-effort).
- **The run checkpoint is `{ appVersionId, triggered }` and recovery never resumes (ADR-0044).** `appVersionId`
  is recorded before the upload and `triggered` before the build request; a failed write there means no
  build request. `triggered: false` → delete the exact version (`deleteVersion`, `src/version-attempt.ts`;
  `appVersionNotFound` counts as deleted). `triggered: true` → settle ONLY by polling, never by deletion;
  past run start + 75 min a non-terminal version is abandoned with a best-effort `cancelBuild`. A lost lease
  deletes and cancels nothing. Any other checkpoint shape fails the run without a platform call.
- **An application's proxy target carries its endpoint table, and nothing else.** `target.proxy` is
  `{ upstream, ...contractProxyTable(artifact) }`; the artifact parser refuses `proxy.gates` with a message that
  names it, and refuses a row whose digest does not describe its rules. The artifact's table is the build's
  self-report, so nothing publishes it.
- **Published access comes from Control's approved snapshot (ADR-0050), never from the artifact.**
  `src/namespace/manifest.ts` builds a member's endpoint table from `member.access`
  (`contractProxyTable(access.contract)`, the upstream from the artifact); a member without approved access is
  not routed and its artifact is not decoded, so a legacy `proxy.gates` artifact cannot stop a republish. `lockedExecutionFor` locks the descriptor down whenever `environment.access` is present — a config
  that drops `target.contract` cannot drop it — and refuses a non-dry deploy without it. `approvedSchemaOf` gives
  the IAM schema of deploy, cancel and reconcile: `access.schema`, otherwise none. Control refuses a commit
  without `fabrika.contract.ts` before it calls the provider.
- **The namespace proxy attempt follows the same rule** (`republishProxy`, `src/namespace/proxy-attempt.ts`).
  `proxyBuild` on the namespace target is `{ appVersionId, triggered, manifestSha256? }` and the codec
  refuses any other shape. An inherited untriggered attempt is deleted; a triggered one is polled, and with
  `wait: 'started'` a running build of the same manifest is answer enough. A fresh attempt writes the IAM
  variables, records the version untriggered, uploads the archive, records `triggered`, then sends the build on
  a signal that only a lost lease aborts. A cancelled deploy never cancels the proxy build; it stays recorded for
  `reconcile`.
- **The proxy manifest is the build archive's one data file, never a variable (ADR-0045).** The manifest (compiled
  from the members core passes, `src/namespace/manifest.ts`) rides as `proxy.manifest.json` beside the exact commit,
  and the upload must report its sha256 or the attempt fails. `zeropsProxyManifestCarrier` reads the PINNED
  descriptor: one whose proxy build still lifts `FABRIKA_PROXY_MANIFEST_JSON` gets the variable as before, bound by
  the client's ~32 KB check; any other gets the file, and a stale variable is deleted. Never lift the variable in the
  generated proxy setup again: every pin of that commit would be handed it.
- **A contract application gets the proxy secret on both sides, or nothing deploys** (ADR-0022 rule 5).
  `namespaceProxySecrets` (`src/namespace/proxy-secrets.ts`) maps each contract member of the manifest to
  `proxySecretVariable(id)` and refuses a member Control handed no `proxySecret`; the attempt writes each
  one to the proxy service, without read-back, before the version is reserved, and the attempt identity
  covers their digest. The deployer refuses a non-dry-run contract deploy whose managed
  `FABRIKA_PROXY_SECRET` is null, and writes none to any other application: only a contract application
  checks it, so another would merely hold a credential its own code can print. Never log either value.
- **A contract member's manifest entry carries `operationsOrigin`** when Control handed the member one (the origin
  of its active ingest DSN, never the DSN): the proxy's header policy admits it in `connect-src`, as the framework
  does (ADR-0022 "Response headers"). `compileNamespaceProxyManifest` refuses one that is not an exact http(s) origin.
- **No authored variable may copy a framework-only one.** `assertAuthoredManagedDocument` refuses, in every
  `envVariables`/`envSecrets` mapping at any depth, a framework-only name as a key and a reference to one in
  a key or a value (`frameworkVariableReference`: `${NAME}`, `${RUNTIME_NAME}`, `${<host>_NAME}`, nested).
  Commands are not variables: `start: echo ${FABRIKA_RELEASE}` reads the service's own environment.
  `secrets.put` refuses the same references.

## Platform installation (`./installation`, `src/installation/`)

The Zerops implementation of `@fabrika/provider-contract/installation` plus the typed platform topology
and the generated installation data; `@fabrika/cli` loads it. Seven commands; the full surface is the
`usage` string in `src/installation/index.ts`, which the generated sidecar workflow is written against:

- `install` CREATES an installation, in an empty project (`--project-id`) or one it creates
  (`--create-project`). It is the only command that creates one; `init` and `deploy` refuse to.
- `init <installation>` creates and maintains the operator's sidecar repository.
- `plan` validates the generated artifacts against the static installation schemas.
- `deploy` brings an EXISTING installation to this checkout, unattended and idempotently.
- `admin --email=<address>` admits the first human.
- `guide` prints `src/installation/guide.md`, the operator's whole procedure: the order, what to ask the human
  for, how an agent holds each credential, and the traps no single usage shows. It ships in the package, so
  the guide matches the release. It is the ONE copy of the procedure: `docs/reference/installing-on-zerops.md`
  points to it. `packages/cli/src/__tests__/guide.test.ts` fails when it names a command or flag the CLI lacks.
  A trap found in a live bring-up belongs there.
- `upgrade --to=<tag>` is the roll: it checks the tag on the public repository, writes `fabrika.ref`,
  regenerates the sidecar workflow when it differs (for the Environment the existing one names), commits
  both without `[skip ci]` (the push IS the trigger), pushes, prints the run URL and watches it.

The bring-up is two passes, because `zeropsSubdomain` names nothing until the proxy has deployed HTTP
ports while the manifest must be written before the proxy is built: pass 1 gives the proxy the legal
EMPTY manifest and builds it; only then are the three public hosts READ off the subdomains it published.
On Zerops `platform deploy` owns the WHOLE ordered sequence; on Cloudflare the scaffolded workflow keeps
the order ([ADR-0027](../../docs/decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md)).

Layout (under `src/installation/`):

- `index.ts` — `installationCli`, the `usage` text, the real collaborators, and the values
  `@fabrika/platform-artifacts` renders from. `topology/index.ts` is the `./installation/topology` subpath.
- `deploy.ts` + `deploy-options.ts` — the ordered deploy sequence and its flags.
- `install.ts` — the two passes, prompts and stable exports. `install-environment.ts` — the environment
  matrix and writes. `install-project.ts` — project creation. `install-provisioning.ts` — service
  provisioning. `install-collaborators.ts`, `install-options.ts`, `secrets.ts` (the six generated values).
- `init.ts` — the sidecar-repository flow. `sidecar.ts` + `templates/` — what the sidecar contains + the tag rule.
- `admin.ts` + `admin-options.ts` — the first administrator. `machine-key.ts` — the block `admin` and `init` end with.
- `hosts.ts` — where an installation answers. `log.ts` — progress, with no secret-taking helper.
  `proxy-manifest.ts` — the manifest TEMPLATE type and `resolvePlatformProxyManifest`.
- `mcp.ts` — the operator's MCP client list and IAM's `FABRIKA_IAM_OAUTH_CONFIG` built from it.
- `checker-release.ts` — the npm lookup of `@fabrika/check` at this checkout's version.
- `topology/` — `setups.ts` (typed setups), `topology.ts` + `invariants.ts`, `artifacts.ts` (every
  generated artifact, as values), `installation-schemas.ts` + `validate.ts` (static schemas).
- `generated/` — the proxy manifest template and the console schema, as DATA. Never hand-edit: the
  private [`@fabrika/platform-artifacts`](../platform-artifacts/CLAUDE.md) writes them, the root
  `zerops.yaml` and the import YAMLs (`gen`, `gen:check`, `check:schemas`).

Invariants:

- **Nothing here imports a private package, not even as a devDependency.** Generators that need
  `@fabrika/control` live in `@fabrika/platform-artifacts`; their output arrives as DATA in `generated/`.
  `release:smoke` imports `./installation` from the tarball, so a private import fails the release.
- The generated root `zerops.yaml` is the only platform build specification. No per-package `zerops.yaml`.
- **`--create-project` builds its project document from the SAME compiled topology as the services
  import**, because `envIsolation` and `corePackage` are settable at project CREATION only — a `project:`
  block with `services: []`, rendered by `renderYaml`. The id is printed BEFORE the wait for `ACTIVE`, so
  an interrupted run resumes with `--project-id=<id>`.
- Keep credentials out of generated artifacts. Do not claim real-account support from schema validation
  or dry runs. Preserve the import-without-code → write service secrets → deploy order; `install` is it.
- **`install` GENERATES credentials** (six secrets plus a minted Zerops integration token), prints none, and
  writes all of them to `--secrets-file` (new, outside the checkout, `0600`) BEFORE placing the first one.
- **No code reads a secret back from Zerops.** A sensitive value reads `REDACTED` outside sudo mode, so the
  client drops its `content` (`api/service-env-response.ts`) and every `putServiceEnv` states `sensitive`.
  A credential is written `true` and never compared; anything compared or merged later (origins, the
  provenance marker) is written `false`.
- **`install` refuses a non-terminal stdin unless `--yes` is passed** (`installPrompts`, before anything is
  contacted). Every confirmation defaults to yes, so a pipe of blank lines would consent to everything.
  `--yes` has no environment variable.
- **`install` is a BRING-UP, never a reconcile.** It refuses a project that already carries its generated
  secret KEYS (by key, never by value) — re-rolling the vault KEK is unrecoverable, re-rolling signing
  keys logs everyone out — and skips the provisioning import when the services exist, because
  `startWithoutCode` at a service carrying code activates an EMPTY app version. A partial set is refused.
- **The import step WAITS on every process it is handed** before reading or writing anything: services
  are created ~15 s apart and hold NO environment until they leave `NEW`. Never replace the wait with a
  sleep or assume the process count (1 per managed, 2 per runtime service). A service already `NEW` at
  start is refused.
- **`install` never restates the deploy order.** Pass 2 is `deployPlatform`; pass 1 reuses
  `deployPlatformService` for the proxy alone.
- **`platform deploy` builds iam and operations AT ONCE, then proxy, then control — the proxy's position
  is a SECURITY property.** The application enforces nothing (ADR-0022), so control at a new version
  behind the previous manifest is an open `/api/*`. Operations owns `operationsdb` and
  `operationsstorage`; only the proxy may expose its ingest and source-map paths.
- **MCP authoring is opt-in, and ONE input turns on both halves** (ADR-0049,
  [`mcp-authoring.md`](../../docs/reference/mcp-authoring.md)). `FABRIKA_PLATFORM_MCP_CLIENTS_JSON` /
  `--mcp-clients` makes `resolvePlatformProxyManifest` publish the console's MCP table with its `oauth` row
  and register its `oauthResource`, and `desiredServiceEnv` write `FABRIKA_IAM_OAUTH_CONFIG` for the SAME
  resource URI. Without it the manifest carries the console's `tableWithoutOAuth` and the IAM variable is left
  untouched — never cleared, because an empty write on Zerops is unverified. Control's half is
  `FABRIKA_SERVICE_TABLE_DIGEST`, which `desiredServiceEnv` writes from the resolved manifest
  (`platformServiceTableDigest`); Control refuses to start when it names neither table. The template's
  `oauthResource` is generated from `CONTROL_MCP_PATH` / `CONTROL_MCP_SCOPE`; `platform-artifacts`'
  `proxy-manifest.test.ts` pins the resolved tables to `controlServiceContract({ mcp })`.
- **There is no `source` service (ADR-0029).** A leftover one is ignored with one warning and never deleted.
- **The platform proxy's manifest is the platform's composition alone, shipped in the proxy's archive.** No
  application shares the platform proxy (ADR-0034). `install` pass 1 and `deploy` append the manifest to the
  snapshot archive (`platform-archive.ts`); only the proxy's archive carries one. `deploy` DELETES, unread, a
  `FABRIKA_PROXY_MANIFEST_JSON` left on the proxy: releases up to 0.4.2 wrote the manifest there SENSITIVE, and only
  sudo mode reads one back. Never read it, merge it or ask the operator for its value.
- **`platform deploy` writes no credential and reads every credential from the environment.** No `--token`,
  no `--admin-key`; an unknown flag is an error.
- **`platform init` keeps deployment credentials off disk and writes nothing to Zerops.** It reads
  `control` and `proxy` only to print origins. GitHub App setup is the Control UI's; init never touches a
  GitHub App key, webhook secret or XDG recovery file. It confirms before every step that leaves the disk;
  declining a write stops and prints what to run.
- **Keep the sidecar pin a published TAG** (`assertPinnedTag` and the workflow). Install and deploy require
  `--source-dir`, the clean checkout containing the executing module (`installation-source.ts` resolves the
  repository root from its own path). One committed archive is prepared before remote writes and shared by
  both passes; mutable Git-source flags are refused; no fallback after an upload failure. Namespace proxy
  source identity is a separate contract (ADR-0045).
- **`install` and `deploy` refuse a checkout whose checker npm does not have**, after preparing the source and
  before any Zerops call (`assertCheckerPublished`). Every application build fetches `@fabrika/check@<this version>`,
  so such an installation could deploy no application. Only a 404 means unpublished; any other answer is an error.
  The lookup is the `checkerPublished` collaborator, so tests fake it and never reach npm.
- **The sidecar Environment holds no admission list.** No bootstrap-admin variable is written.
- **`platform admin` writes a CROSS-APP (`app: null`) `admin` grant and prints the enrollment URL ONCE.**
  An app-scoped grant leaves the Access plane refusing while Delivery and Operations work. A re-run
  changes nothing; an outstanding enrollment is REPORTED and only `--reissue` replaces it. The mechanics
  are `@fabrika/installation-init`'s `ensureFirstAdministrator`; `admin.ts` holds only where IAM answers.
- **`machine-key.ts` is built from an ORIGIN and variable NAMES only**, so no key can leak through it.
  `init` prints no origin when `control`'s `FABRIKA_IAM_ISSUER` is absent or disagrees with the named
  hosts. The block must survive being PASTED: the origin is an `export`, every other line a `#` comment.
- **Every write is read-compare-write**, so a re-run changes nothing; `putServiceEnv` stays write-first
  because it must work on a never-deployed service.
- Every managed service names its `profile` explicitly (omitting it buys `oltp-production` on HA).
- Every setup declares `run.healthCheck` and `deploy.readinessCheck`, every duration a quoted Go duration
  in `[10s, 1h]` (`topology/installation-schemas.ts` declares the six probe fields as strings).
- An installation service's PostgreSQL URL is always `${<host>_connectionTlsString}/${<host>_dbName}?sslmode=require` — the
  TLS port is the only one `postgresql:ha@18` offers, and it keeps the session state the migration lock needs. It admits
  only the service's own users, which is all an installation service connects as.
- **The proxy manifest is a committed template plus a deploy-time placement.** The template is
  installation-independent and `gen:check` proves it matches the service contracts; hosts
  and scheme are arguments. `parseProxyManifest` refuses an app with no hosts, hence a separate template type.
  Each app carries its service `table` (rows without digests); `resolvePlatformProxyManifest` turns the
  table into an installation entry with `serviceProxyTable`, registering its `oauthResource` and keeping its
  `oauth` rows only when the composition names an authorization server.
- `enableSubdomainAccess` in a generated artifact is a DECLARATION, never a mechanism; the artifact's
  header says so. Do not remove that note without removing the field.
