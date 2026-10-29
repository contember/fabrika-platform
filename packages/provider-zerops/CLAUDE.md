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
  `ensureSubdomainAccess` in `src/namespace/subdomain.ts` is the one place that does this; it runs after the proxy
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
  the one list Control refuses too); `MANAGED_VARIABLE_NAMES` (`@fabrika/auth-core`) is the part of it Control hands every
  deploy, parsed once by Control (`parseManagedEnvironment`); this provider re-checks none of it.
  `FABRIKA_APP_ORIGIN` is read back and compared; `FABRIKA_TOKEN_KEYS` is sensitive, rewritten every deploy, and
  removed by a null. Beside them Control hands each job's and webhook's key (`FABRIKA_<KIND>_<NAME>_KEY`), each public
  procedure's (`FABRIKA_PROCEDURE_<ID>_<8 hex>_KEY`) and each connector
  import's `FABRIKA_CONNECT_<IMPORT>_KEY` and `_URL`, and the platform transport's `FABRIKA_PLATFORM_<RECEIVER>_KEY`
  (sensitive) and `_URL` (plain, Control's public origin, http allowed for the local stack's). `write-service-env` writes
  each entry sensitive exactly when Control marked it a `credential`, and deletes what `staleManagedVariables` names (a
  managed name handed null, or a family member not handed, but never the descriptor's `FABRIKA_RELEASE`), so a removed
  workload's or import's key does not stay readable.
- **A contract application's setup is the platform's (ADR-0043, `src/execution.ts`).** A config with
  `target.contract` compiles to a manifest with `target.contract` (digest, health path, jobs) and optional
  `runtimePackages` from `ZEROPS_RUNTIME_PACKAGES`. `lockedAuthoredBuild` refuses every key of the selected
  setup except `build.base`, `build.os` and `build.buildCommands`, in `parseFabrikaManifest`, so on build AND
  decode. The manifest must also carry the endpoint table of the same contract (`proxy.snapshot` equals
  `contract.digest`, from `contractDigest`), and an endpoint table without the contract is refused. A deploy writes
  `FABRIKA_CONTRACT_DIGEST` and the namespace proxy's `snapshot` from `ProviderApprovedAccess.contractDigest`, never
  from the approved contract: Control may have upcast it from an older release's artifact.
  The steps are `@fabrika/app/build`'s `contractRecipe`; `src/execution.ts` renders them at Zerops' paths (`printf`
  file writes, init commands, the crontab, ClamAV) and keeps the guards a shell needs.
  `renderLockedExecutionDescriptor` sends ONLY the generated setup: the SPA commands, the frozen install, the
  application's tests, then — because the tests are authored code — a reinstall, the regenerated entrypoint,
  `tsc` with the platform tsconfig (the contract, `src/` and the SPA under `web/`), the checker fetched at the release
  of the reader that read the application (`ZeropsLockedExecution.checkRelease`, from `ProviderApprovedAccess.checker`:
  the newest patch of the minor its `bun.lock` pins; ADR-0062) and the scripts. Keep the tests before every step that
  produces or checks what deploys, and `tsc` before the checker, as the application skill's loop runs them: the checker
  refuses the cast or `any` that silences a type error, so it has the last word. The tests command counts the files
  `@fabrika/db/testing` skipped (its skip line has the same text in every release) and prints `fabrika-tests: N
  Postgres-backed test files did not run …`: the build has no database. Of those files only the generated ones run
  again, at container start. The init commands run
  `fabrika db migrate`, then `fabrika db codegen --verify` and `fabrika db test-isolation` (the generated tests on
  a throwaway schema), and the start script only `exec`s the server, so a failed migration, a stale
  `schema.generated.ts` or a generated case that did not pass fails an init command, which stops the activation
  (verified live 2026-10-16); the build has no database. Never move them back into the start script: the readiness
  window (180 s, not the application's to raise) opens with `run.start`, and the CRM's isolation tests alone took
  almost 3 minutes there (issue #27); the window opens only after the init commands (verified live 2026-10-21). A `DEPLOY_FAILED` version's error names the init commands and the readiness check. The run section names the application's one PostgreSQL
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
  `fabrika-source-maps` of `@fabrika/check` at the same release, `|| true`. The relay reads its report line from the build
  log (`readSourceMapUploadReport`): a succeeded run reports `artifactState: 'complete'` only when that line said so, else
  `incomplete`. Every build command, the authored ones included, can read the bearer, and so can the runtime until the
  next deploy replaces it: it reaches only this run's release and expires two hours after the run started.
- **`raise-start-memory` raises the deploy service's minimum RAM before a version is reserved (ADR-0043).** The init
  commands' `fabrika db test-isolation` peaks above the runtime's 0.125 GB faster than vertical autoscaling reacts, so
  `zeropsStartMinRam` (`src/execution.ts`) names the floor: 0.5 GB with a database, 2 GB with a scanner. An import
  cannot change an existing service, so the step reads `customAutoscaling` back, sends it WHOLE with only
  `minResource.memoryGBytes` changed, under the keys `verticalAutoscaling` / `horizontalAutoscaling`, and decides by
  reading `currentAutoscaling` back. Measured live: a field left out, and the whole object under the published OpenAPI's
  `…Nullable` keys, is silently RESET with a 200. The reader reads an autoscaling with any unreadable field as absent,
  and the step then refuses rather than reset a field. It only raises.
- **`size-database` sizes each process's database connections before a version is reserved (ADR-0043).** Pure in
  `src/database-budget.ts`: `max_connections` follows the database's minimum RAM step and profile; 7 are never an
  application role's and 5 are one container's init commands; the rest is shared by twice the deploy service's maximum
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
  that drops `target.contract` cannot drop it. Control refuses a non-dry deploy without approved access, and a commit
  without `fabrika.contract.ts`, before it calls the provider. The deploy has no IAM step: once a version is ACTIVE,
  Control writes `access.schema` itself (ADR-0011).
- **The namespace proxy attempt follows the same rule** (`republishProxy`, `src/namespace/proxy-attempt.ts`).
  `proxyBuild` on the namespace target is `{ appVersionId, triggered, manifestSha256? }` and the codec
  refuses any other shape. An inherited untriggered attempt is deleted; a triggered one is polled, and with
  `wait: 'started'` a running build of the same manifest is answer enough. A fresh attempt writes the IAM
  variables, records the version untriggered, uploads the archive, records `triggered`, then sends the build on
  a signal that only a lost lease aborts. A cancelled deploy never cancels the proxy build; it stays recorded for
  `reconcile`. A deploy's or a registry change's republish (`reuseActive`) builds nothing when the recorded
  `proxyDeployment` names the same pin and `manifestSha256` (which covers the IAM issuer, the IAM key and every proxy
  secret) and its version still reads `ACTIVE` on the proxy service; any doubt rebuilds. Provisioning and `reconcile`
  always rebuild.
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
  covers their digest. Control refuses a non-dry deploy behind a namespace proxy when it has no proxy secret to hand
  (`FABRIKA_PROXY_SECRET`), and hands none to a dry run; the deployer writes what it was handed. Never log either value.
- **A contract member's manifest entry carries `operationsOrigin`** when Control handed the member one (the origin
  of its active ingest DSN, never the DSN): the proxy's header policy admits it in `connect-src`, as the framework
  does (ADR-0022 "Response headers"). The entry is `contractProxyEntry`'s (`@fabrika/proxy-core/manifest`), which
  refuses one that is not an exact http(s) origin.
- **A contract member's manifest entry lists `crossOrigins`** when Control handed the member a non-empty list (the
  environment's registry row, ADR-0022 "Cross-origin endpoints"), and omits the field otherwise.
  `contractProxyEntry` refuses a list the manifest parser would: an origin that fails `isCrossOrigin`, a duplicate, the
  member's own host, more than `MAX_CROSS_ORIGINS`. Control republishes the namespace when the list changes.
- **A deploy whose rows or CSP the namespace's pinned proxy cannot read is refused.** A namespace proxy's manifest parser
  is strict, so an approved contract with a row that no older release's proxy parses (a `public` row, a `cache`, a
  file-response profile, a `capabilities` requirement, a webhook's `authorization: 'forward'`, and any later form), or
  with a CSP directive none of them knows
  (`workerSrc`, an ALTCHA challenge's `blob:` workers), deploys only while the namespace's proxy source is the one this
  control plane deploys new placements from. Control calls `validateAccess` before publishing the candidate snapshot,
  under the namespace lease, so a refusal cannot poison the namespace's next republish. `deploy` checks it too.
  The refusal names each row and `csp`, and
  `fabrika control namespaces update --namespace=<id> --proxy-source=current`. The judges are those releases' own
  parsers, a row parser and the CSP field of the entry parser per release, which Control passes in as
  `namespaces.olderProxies` (`src/namespace/proxy-reads.ts`); never replace them with a list of fields. What one of them
  parses deploys, so every 0.4/0.5/0.6 contract does. They are 0.4.8, 0.5.5 and 0.6.0; never add a parser of a minor newer
  than 0.6 while a pin's release is not recorded, so a form newer than 0.6 deploys only while the namespace's proxy
  source is current.
- **The manifest carries the installation's client logo only for a proxy source that accepts it** (ADR-0066).
  `republishProxy` writes `brand` when Control handed one AND the pinned descriptor's proxy build declares
  `FABRIKA_PROXY_MANIFEST_BRAND` (`zeropsProxyAcceptsBrand`, `src/proxy-manifest-carrier.ts`). An older source's strict
  parser refuses the key and would fail its build, so it keeps fabrika's mark until the namespace is re-pinned. The
  logo is inside the manifest digest: a new logo is a new attempt. Never drop the marker from the generated proxy setup.
- **No authored variable may copy a framework-only one.** `assertAuthoredManagedDocument` refuses, in every
  `envVariables`/`envSecrets` mapping at any depth, a framework-only name as a key and a reference to one in
  a key or a value (`frameworkVariableReference`: `${NAME}`, `${RUNTIME_NAME}`, `${<host>_NAME}`, nested).
  Commands are not variables: `start: echo ${FABRIKA_RELEASE}` reads the service's own environment.
  `secrets.put` refuses the same references.
- **A `dev` environment runs one Box sandbox per MCP workspace, never a Zerops service (ADR-0049 rule 10, ADR-0043).**
  `devSandboxes` (`src/sandbox/lifecycle.ts`) creates, parks, wakes and removes a workspace's sandbox, found again by
  its name `fabrika-<workspace id>`, so every call converges: a create's `Idempotency-Key` is fresh per call (one that
  repeated after a removal could replay an answer naming the removed sandbox), and `remove` deletes the recorded sandbox
  and any other under the name. `admit` refuses a namespace whose pin lacks the sandbox marker, before Control records a
  sandbox. A dev bootstrap's `deploy` runs the plan in
  `src/sandbox/deploy.ts` instead of a Zerops build: wake, stop the previous launcher and build, upload the helper
  scripts, upload the source archive, run the build as the unprivileged build user with a clean environment, and only
  then write the launcher's environment file (0600, through the file API) and start the launcher. Recovery never
  resumes (ADR-0044). `assertSandboxArtifact` refuses object storage, `scan: true` and `runtimePackages`, and
  `assertNoSandboxReferences` a `${…}` value, one line each. The launcher's `checks` are the recipe's `checks`. A dev
  environment's stored target is `{ kind: 'devSandboxes' }` and claims no service (`src/namespace/claims.ts`); a target
  an older release stored for its own service still decodes, and `sandboxHostOf` refuses it with the re-register remedy.
- **No credential reaches Box except in a file the deploy writes.** Box echoes a sandbox's launch environment and an
  exec's environment in its API answers and session lists, so no call of `src/zbox/` accepts env, create pins
  `secrets: { mode: 'NONE' }`, and the client never puts a response body into an error or a log: an error carries Box's
  `code` and the HTTP status only. The build's output is relayed through `maskValues`. Never add an env parameter.
- **The sandbox host is the namespace's `zbox` service** (`src/namespace/sandbox-host.ts`, constants in
  `src/sandbox-host.ts`). It is imported alone, after the proxy has converged, by a namespace job that Control hands a `sandboxKey` (a `dev`
  member has a workspace sandbox record). The platform
  starts it ACTIVE with a key of its own, which a create of `ZBOX_WORKSPACE_API_KEY` cannot replace (`errorList`), so
  the step rekeys with an update of the record and a restart. The key is Control's (handed per call as `sandboxKey`),
  written sensitive and never read back or compared. The step requires that the API answers 401 without a key, and adds
  the DOT domain `sandbox.fabrika.internal` the proxy routes by. A `zerops-subdomain` namespace is refused a host.
- **Sandbox entries reach only a proxy that parses them.** A `dev` member that carries `devSandboxes` is routed only
  through those entries (`dev:<app>:<workspace>`, `audience`, `upstreamHost`; `src/namespace/manifest.ts`), and only
  when the pinned descriptor's proxy build declares `FABRIKA_PROXY_MANIFEST_SANDBOXES` (`zeropsProxyAcceptsSandboxes`,
  `src/proxy-manifest-carrier.ts`); otherwise `assertNamespaceProxyAcceptsSandboxes` refuses before any platform write.
  Never drop the marker from the generated proxy setup.
- **The sandbox base image is named by its content; the helper scripts ship with every deploy.** The base is
  `fabrika-dev-<12 hex>` of the sha256 over `sandbox/Dockerfile` and `sandbox/init.sh` (`src/sandbox/base-image.ts`),
  built on the host on first use, so a release that changes either builds a new base and leaves the old one. The
  scripts under `sandbox/bin/` are uploaded by every deploy into a directory named by their own hash
  (`src/sandbox/scripts.ts`), so a fix reaches existing sandboxes without a new base. A path in
  `src/sandbox/constants.ts` is spelled in those scripts too: change both together.

## Application CLI (`./cli`, `src/cli.ts`)

`appCli` (`@fabrika/provider-contract/app-cli`) is what `fabrika app build`, `app register` and `fabrika namespace`
run: the Bun entry runtime, `build` (writes `fabrika.manifest.json`), `registrationManifest` (the same text, written
nowhere) and `namespaces` (`src/namespace-cli.ts`: the provider options and the plan; the `fabrika` command calls
Control and prints).

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
  provisioning. `install-collaborators.ts`, `install-options.ts`, `install-secrets.ts` (what the secrets file records).
  The six generated values, fabrika's half of the service environment, the secrets file's mechanics, the manifest
  template type with `resolvePlatformProxyManifest`, MCP/OAuth and the tag rule are `@fabrika/installation-init`'s;
  `install-environment.ts` and `deploy.ts` add this project's references (`${db_…}`, `${storage_…}`), `iam:3000` and
  control's `FABRIKA_ZEROPS_*` variables to them.
- `init.ts` — the sidecar-repository flow. `sidecar.ts` + `templates/` — what the sidecar contains + the workflow's
  run-time tag check; the pin's published-tag rule is `@fabrika/installation-init`'s `assertPinnedTag`.
- `admin.ts` + `admin-options.ts` — the first administrator. `machine-key.ts` — the block `admin` and `init` end with.
- `hosts.ts` — the Zerops subdomain placement. `log.ts` — progress, with no secret-taking helper.
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
- **`platform deploy` ends by setting `db`'s backup period to hourly (`ensureBackupPeriod`)**, after the
  registration. Until a live run measures the API, nothing in that step fails the deploy: a refusal, an unparsable
  read or a differing read-back is a warning. Read-compare-write: only an empty or once-a-day period is replaced, and
  it is sent with the retention it read (its own, else the default) WHOLE. It is skipped when the project has no
  `operationsdb` (an older light installation, whose Operations still lives in `db`). The API shapes are the
  OpenAPI's; the period's format, tagging and the retention reset are UNVERIFIED (`docs/reference/zerops-platform.md`).
- **MCP authoring is opt-in, and ONE input turns on both halves** (ADR-0049,
  [`mcp-authoring.md`](../../docs/reference/mcp-authoring.md)). `FABRIKA_PLATFORM_MCP_CLIENTS_JSON` /
  `--mcp-clients` makes `resolvePlatformProxyManifest` publish the console's MCP table with its `oauth` row
  and register its `oauthResource`, and `deployedServiceEnvironment` write `FABRIKA_IAM_OAUTH_CONFIG` for the SAME
  resource URI. Without it the manifest carries the console's `tableWithoutOAuth` and the IAM variable is left
  untouched — never cleared, because an empty write on Zerops is unverified. Control's half is
  `FABRIKA_SERVICE_TABLE_DIGEST`, which `deployedServiceEnvironment` writes from the resolved manifest
  (`platformServiceTableDigest`); Control refuses to start when it names neither table. The template's
  `oauthResource` is generated from `CONTROL_MCP_PATH` / `CONTROL_MCP_SCOPE`; `platform-artifacts`'
  `proxy-manifest.test.ts` pins the resolved tables to `controlServiceContract({ mcp })`.
- **There is no `source` service (ADR-0029).** A leftover one is ignored with one warning and never deleted.
- **The platform proxy's manifest is the platform's composition alone, shipped in the proxy's archive.** No
  application shares the platform proxy (ADR-0034). `install` pass 1 and `deploy` append the manifest to the
  snapshot archive (`platform-archive.ts`); only the proxy's archive carries one. `deploy` DELETES, unread, a
  `FABRIKA_PROXY_MANIFEST_JSON` left on the proxy: releases up to 0.4.2 wrote the manifest there SENSITIVE, and only
  sudo mode reads one back. Never read it, merge it or ask the operator for its value.
- **`platform deploy` reads every credential from the environment, and writes only one it derives.** No `--token`,
  no `--admin-key`; an unknown flag is an error. On every run it writes `FABRIKA_INSTALLATION_PROXY_SECRET_IAM`
  SENSITIVE to `proxy` and `iam`, before any build and without reading it back: HMAC-SHA256 of the label
  `fabrika-installation-proxy-secret:iam` keyed by `FABRIKA_IAM_PROVISIONING_KEY` (`deriveIamProxySecret`, ADR-0022
  rule 5). Caddy sends it on IAM's route and IAM reads its client-address and request-id headers only beside it. Never
  derive it from the proxy key (`FABRIKA_IAM_KEY`): every namespace proxy holds that. `install` pass 2 is
  `deployPlatform`, so a fresh installation gets it there; it is not one of `GENERATED_SECRET_KEYS`.
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
- **Every write of a readable value is read-compare-write**, so a re-run changes nothing but the derived IAM proxy
  secret, which cannot be read back; `putServiceEnv` stays write-first because it must work on a never-deployed service.
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
