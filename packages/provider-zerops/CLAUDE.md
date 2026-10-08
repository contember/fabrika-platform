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
- **`compileProvisioningYaml`'s output is first-bring-up only.** Re-applying it at a service that carries
  code activates an EMPTY app version and demotes the running one to `BACKUP`.
- Application registration uses `renderFabrikaProvisioningYaml` with `override: false` to refuse
  first-creation collisions (ADR-0044). Preserve `override: true` in the canonical manifest and
  steady-state imports; await every returned import process before completing registration.
- **An import document CANNOT establish a `.zerops.app` subdomain** — `enableSubdomainAccess` is accepted
  and dropped, on a service the document creates as much as on one `override` leaves alone. Only
  `PUT /service-stack/{id}/enable-subdomain-access` does, and only once the service publishes a DEPLOYED
  HTTP port (`400 serviceStackIsNotHttp` before that). Its 2xx proves nothing — on an already-published
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
- **Persisted target envelopes hold coordinates only.** Credentials are composed for a live run.
- **The control provider's `deploy` decodes the artifact ONCE and runs `createZeropsDeployer` in-process**
  on that typed value.
- **Only `FABRIKA_RELEASE` is bound to a version (ADR-0044).** `overlayRelease` (`src/managed-env.ts`)
  writes it as a LITERAL into the selected setup's `run.envVariables` of the execution descriptor; it is
  never a service variable, and `write-service-env` deletes a stray one. The other five managed keys are
  plain service variables each deploy overwrites (null removes), all written before the build request so it
  never meets `userDataSyncRunning`. App vars, secrets and descriptors may not author any of the six.
- **The run checkpoint is `{ appVersionId, triggered }` and recovery never resumes (ADR-0044).** `appVersionId`
  is recorded before the upload and `triggered` before the build request; a failed write there means no
  build request. `triggered: false` → delete the exact version (`deleteVersion`, `src/version-attempt.ts`;
  `appVersionNotFound` counts as deleted). `triggered: true` → settle ONLY by polling, never by deletion;
  past run start + 75 min a non-terminal version is abandoned with a best-effort `cancelBuild`. A lost lease
  deletes and cancels nothing. Any other checkpoint shape fails the run without a platform call.
- **The namespace proxy attempt follows the same rule** (`republishProxy`, `src/namespace/proxy-attempt.ts`).
  `proxyBuild` on the namespace target is `{ appVersionId, triggered, manifestSha256? }` and the codec
  refuses any other shape. An inherited untriggered attempt is deleted; a triggered one is polled, and with
  `wait: 'started'` a running build of the same manifest is answer enough. A fresh attempt writes the
  manifest (compiled from the members core passes, `src/namespace/manifest.ts`) and the IAM variables,
  records the version untriggered, uploads, records `triggered`, then sends the build on a signal that only
  a lost lease aborts. A cancelled deploy never cancels the proxy build; it stays recorded for `reconcile`.

## Platform installation (`./installation`, `src/installation/`)

The Zerops implementation of `@fabrika/provider-contract/installation` plus the typed platform topology
and the generated installation data; `@fabrika/cli` loads it. Six commands; the full surface is the
`usage` string in `src/installation/index.ts`, which the generated sidecar workflow is written against:

- `install` CREATES an installation, in an empty project (`--project-id`) or one it creates
  (`--create-project`). It is the only command that creates one; `init` and `deploy` refuse to.
- `init <installation>` creates and maintains the operator's sidecar repository.
- `plan` validates the generated artifacts against the static installation schemas.
- `deploy` brings an EXISTING installation to this checkout, unattended and idempotently.
- `admin --email=<address>` admits the first human.
- `upgrade --to=<tag>` is the roll: it checks the tag on the public repository, writes `fabrika.ref`,
  commits it without `[skip ci]` (the push IS the trigger), pushes, prints the run URL and watches it.

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
- `manifest.ts` — composing platform apps with application entries. `hosts.ts` — where an installation
  answers. `log.ts` — progress, with no secret-taking helper. `proxy-manifest.ts` — the manifest TEMPLATE
  type and `resolvePlatformProxyManifest`.
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
- **`install` GENERATES credentials** (six secrets plus a minted Zerops integration token) and prints exactly
  ONE value — the provisioning key, once, at the end, for `init`. IAM and Control keep remote copies.
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
- **There is no `source` service (ADR-0029).** A leftover one is ignored with one warning and never deleted.
- **`platform deploy` MERGES the proxy manifest, never replaces it.** An application on the light tier
  shares the platform proxy's `FABRIKA_PROXY_MANIFEST_JSON`; an entry on a platform host is superseded and
  reported.
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
- A PostgreSQL URL is always `${<host>_connectionTlsString}/${<host>_dbName}?sslmode=require` — the TLS
  port is the only one `postgresql:ha@18` offers, and it keeps the session state the migration lock needs.
- **The proxy manifest is a committed template plus a deploy-time placement.** The template is
  installation-independent and `gen:check` proves it matches the gate modules; hosts and scheme are
  arguments. `parseProxyManifest` refuses an app with no hosts, hence a separate template type.
- `enableSubdomainAccess` in a generated artifact is a DECLARATION, never a mechanism; the artifact's
  header says so. Do not remove that note without removing the field.
