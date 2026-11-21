---
id: 0043
title: Validate and render one Zerops descriptor meaning
status: accepted
date: 2026-10-08
---

# 0043 — Validate and render one Zerops descriptor meaning

## Context

Fabrika checked source descriptors with Bun's YAML parser and sent their original text to Zerops.
Local witnesses reproduced an ownership-check bypass: Bun retained a `!!binary` value as base64
text while both pinned Go YAML readers decoded it into a foreign-service reference. Reader differences
also affect duplicate keys, scalar types and Unicode separators. Checking one interpretation and
executing another cannot enforce the provider's service-reference boundary.

The authored descriptor also decides how an application starts and how it is built. Its `run` section
can start a hand-written server instead of the generated entrypoint, skip the migrations or open the
start command to anything. Its build commands can skip the checker, the type check and the contract
check, or replace `@fabrika/*` packages. An agent that is refused at runtime loosens exactly these
([ADR-0050](0050-approved-access.md)). The framework's guarantees
([ADR-0012](0012-fabrika-app-runtime.md)) hold only when the platform, not the repository, decides
what runs.

The import document can also expose an application past the proxy: a public bucket, subdomain access,
a mount or a CDN. The compiler copies these fields unchecked today.

An application's database has a fixed number of connections. On Zerops `max_connections` follows the
PostgreSQL service's RAM step (50 per GB, from 20 to 500; OLAP 25 per GB, from 10 to 200), cannot be
overridden, and 7 of them are never an application role's: 3 are kept for superusers and Zerops uses up
to 4. pgBouncer cannot admit the roles fabrika creates. A default `postgresql:single@18` on
`oltp-hobby` (0.25 GB) has 20. Every process of the Bun runtime opened up to 10, the old and the new
containers serve together while a deploy replaces them, and every new container runs its init commands
at start, which then included the isolation tests. In production (2026-10-16) that failed a deploy at random in `fabrika db
test-isolation` with SQLSTATE 53300, and the run reported 394 and then 414 of 420 cases passed
([platform facts](../reference/zerops-platform.md)).

## Decision

Use the maintained `yaml` v2 parser to validate an explicit descriptor subset at the manifest boundary.
Reject explicit tags, anchors, aliases, merge keys, duplicate or non-string keys, multiple documents,
parser warnings, ambiguous plain scalars, inexact numbers and unsupported raw Unicode characters.
Ordinary mappings, sequences, comments, block/flow syntax and quoted strings remain supported.

Select a single setup deterministically: the sole setup may be implicit; multiple setups require an
explicit selector. The executed setups are the selected one and, transitively, every setup it
`extends`; an unknown parent is refused. Check decoded keys and string values in the executed setups
for foreign-service references, and send Zerops a document holding only those setups, through the
shared YAML emitter, with the selected setup passed explicitly on both initial builds and recovered
builds. A sibling setup for another placement or another app in the same file may therefore name
services this app does not own: it is never checked against this app and never reaches Zerops for it.
A selected setup that extends another must declare its own `run`, because Zerops merges `extends` per
whole section and the deploy writes `FABRIKA_RELEASE` into `run`; registration refuses it. A
contract application's setup may not `extends` at all (below), so its executed setup is the selected one alone.

One path still builds a setup this check never read: an app's import service that carries
`buildFromGit` with `zeropsSetup` makes Zerops build that repository's own `zerops.yaml` at import.
It predates this rule and bypasses the registered descriptor entirely.

**Invariant:** the persisted source descriptor and its SHA-256 remain the exact original source bytes.
Source resolution and archive verification use that identity, never the canonical execution document.

The compatibility comparison with YAML 1.1 is a conservative rejection rule, not an emulation of
Zerops. Independent Go-reader witnesses verify emitted values in addition to TypeScript tests.

### The platform owns the `run` section and the server build

The provider renders the execution descriptor from the run's snapshot, through the existing release
overlay. Of `build`, the authored descriptor keeps only `base`, `os` and the SPA's `buildCommands`.
Every other `build` key is generated or refused; work unit B7 lists the exact keys from the Zerops
schema.

**`run`** is generated:

- `initCommands` runs `fabrika db migrate`
  ([ADR-0017](0017-service-owned-postgres-migrations.md)); the schema check runs in the build (below);
- `start` runs the generated entrypoint;
- the crontab comes from the contract's jobs;
- a generated readiness check;
- `prepareCommands` come from a typed allowlist;
- `FABRIKA_CONTRACT_DIGEST` is a literal in `run.envVariables`, like `FABRIKA_RELEASE`
  ([ADR-0044](0044-zerops-delivery-ownership-and-recovery.md)). A service variable would not do: it
  changes across restarts and rollbacks.

The compiler refuses authored `run` keys, `build.addToRunPrepare`, `build.deployFiles` and
`deploy.temporaryShutdown`. The platform generates `deployFiles`.

**`build`** is one build in a fixed order:

1. The authored SPA commands run first.
2. Then a frozen install with lifecycle scripts off, and the application's tests. The tests are
   authored code too, so they run before every step that produces or checks what is deployed.
3. Then `node_modules` is installed again, the entrypoint is generated again, and the checks run: the
   checker (with the hash check of `@fabrika/*` in the lockfile and the contract check), `tsc` with the
   platform's `tsconfig`, and the server build.

No authored command runs after the checks. The build refuses the routine ways to replace `@fabrika/*`:
`patchedDependencies`, `overrides`, `resolutions`, non-registry specifiers, another registry, a package
named like a trusted one, an `exports` map in the root manifest, a `bunfig` `preload` under any key
spelling, a test preload outside the checked files, `tsconfig` `paths` and `declare module '@fabrika/*'`.
The checker version is pinned and recorded in the run's snapshot.

A local or dogfood setup outside this repository installs unreleased packages from tarballs (`release:pack --local`).
The checker accepts that form only when the operator names the pack explicitly, `fabrika-check --packed
<release-manifest.json>`, and only for tarballs whose bytes match the sha512 the manifest records: their `file:`
specifiers, an `overrides` block of them alone, and their lockfile entries. The flag is the only switch. The build
command is generated and never passes it, so a deployed application still installs every `@fabrika/*` package from the
registry with its hash.

**The schema check runs in the build, on a throwaway database.** It moves there only for an application whose
`@fabrika/app` pin is at least `MIGRATE_CHECKS_DATABASE_CODE_SINCE` (0.9.0-dev.23): from that release
`fabrika db migrate` checks the live schema for database code no migration declares on every run, so the init command
keeps the live check `codegen --verify` made at start. A build step before it refuses an `@fabrika/cli` older than the
`@fabrika/app` it ships with, because the init command runs the CLI's `migrate`. After `fabrika-check`, one generated
build command installs PostgreSQL 18 (`sudo apk add postgresql18`), starts a cluster on a unix socket behind a random password,
migrates it from scratch with `fabrika db migrate`, runs `fabrika db codegen --verify` on it, and stops it. A stale
`schema.generated.ts` or a migration that does not apply to an empty schema fails the build: the version the deploy
reserved before it triggered the build ends `BUILD_FAILED`, never activates, and the previous one keeps serving. A
container start runs only `fabrika db migrate` as an init command, and the start script only starts the server.

The cluster is 18, the platform's application databases' major; an application that declares an older one still
builds against 18, because the check needs only a server that runs its migrations. Only a build whose every base is
known to be Alpine 3.23 or later carries `postgresql18` (today the default `alpine/bun@1.3`, verified live; Alpine 3.22
has none, and a name does not tell the release), so any other build, and any application pinned below that release,
keeps the earlier form: the init commands
run `fabrika db migrate`, then `fabrika db codegen --verify` against the application's real schema, each script under
`set -eu`, and a failed one stops the activation (ADR-0062: no application has to change its build to deploy). Init
commands run before `run.start` because the readiness window opens with `run.start`, and it is fixed at 180 s: the
application cannot raise it. A check in the start script would share that window with the server, so a long one would
fail a deploy although every check passed.

**A container starts with the memory its init commands need.** The floor was measured when the init commands also
ran the isolation tests, whose run peaked at 161 MiB of anonymous memory for the Notes example and 225 MiB for the CRM
example, within about 1.5 s. A Zerops runtime starts at 0.125 GB, and vertical autoscaling reacts in 10–20 s, so the
platform killed the run on 2 of 3 first deploys and marked the version `DEPLOY_FAILED` (measured 2026-10-15,
[platform facts](../reference/zerops-platform.md)). The floor stays until it is measured for today's init commands. Each
deploy therefore raises the deploy
service's minimum RAM to 0.5 GB for an application with a database, and to 2 GB for one that scans uploads, in the
`raise-start-memory` step before it reserves a version. An import cannot do it: Zerops ignores a changed
`verticalAutoscaling` of an existing service. The step changes only that field through the autoscaling API, reads it
back, and never lowers it.

**Every process of an application fits its database's connection limit.** The deploy's `size-database`
step, after `raise-start-memory`, reads the minimum RAM and the profile of the application's PostgreSQL
service and the deploy service's maximum container count (10, Zerops' maximum, when it reads none). Of
`max_connections`, it keeps 7 for superusers and Zerops and 5 for one container's init commands (the
peak measured when they also ran the isolation tests, kept until it is measured again), and shares the rest between twice the maximum container count (old and new
containers overlap while a deploy replaces them) and one process per crontab job. Each process gets its
share, at most 10. When the share is below 2 (a job's fenced write and its cancellation need one
connection each), the step raises the minimum RAM of the application's own database to the smallest
step at which it is 2, the way `raise-start-memory` raises the deploy service, and reads it back. A
`cheap` namespace's shared `postgres` is the namespace's to size: it is never raised, each process gets
2, and the run log says that the namespace's profile is too small. The share reaches the application as
`FABRIKA_APP_DATABASE_CONNECTIONS`, a literal of the generated run section, and `@fabrika/app/bun`
opens its pool with it (10 without one). An application with a database is never built without it.

**A test database waits for a connection; it never fails a case for want of one.** It
holds at most 4 connections (`TEST_DATABASE_CONNECTIONS`: the provisioning connection that holds its lock
and reads the catalog, the seeder, two of the runtime role) and opens the first of each pool before the
first case: Bun's pool then makes a statement wait for an open connection when the database refuses
another, so no case meets a refusal. A refusal while it opens (SQLSTATE 53300) releases everything and
retries, with jittered exponential backoff, for up to 60 s. Then the file fails saying that the database
had no free connection slot, and every later file of the run fails at once.

The overlay carries no secret value. Secrets stay managed variables
([ADR-0004](0004-secrets-live-in-the-platform.md)).

**Framework-only variable names are one list.** It reserves the names of the database, storage,
proxy-secret, job and connector credentials, the `FABRIKA_EMAIL_` family of the installation's mail
transport ([ADR-0019](0019-portable-outbound-email.md)) and the `FABRIKA_PLATFORM_` family of the platform transport
([ADR-0064](0064-applications-reach-the-platform-over-a-receiver-verified-transport-key.md)), which only Control hands
an application. Control's
`assertUnmanagedName` and `MANAGED_VARIABLE_NAMES` (`@fabrika/auth-core`) both use that list. Both refuse an authored variable or
a secret under one of those names, and a deploy removes a family variable it no longer hands, one set by hand
included. The framework reads these variables and removes them from `process.env`.

The generated `run` section depends on two platform facts ([platform facts](../reference/zerops-platform.md)).
A failed `initCommands` entry stops activation, and the readiness window opens with `run.start`, after the init
commands (a 240 s init command behind a 60 s window activates). Both are verified live. Its readiness check is an `exec` that requests the contract's health endpoint
until a 2xx answers, for at most 9 s of each attempt; an `exec` check is verified to gate a deploy. An `httpGet` check
would pass only at the second attempt, 10 s later, because the server rarely listens one second after `run.start`.

**A `dev` environment renders no `run`** ([ADR-0049](0049-author-applications-through-mcp-in-control.md) rule 10).
Control's environment kind selects it; an application never authors it and cannot select it. Each workspace runs in its
own Box sandbox, not in a Zerops service, so the provider renders neither `build` nor `run` for it. Of the authored
descriptor it takes only the authored SPA commands of the selected setup, after the same check of authored variables (`assertAuthoredManagedDocument`). The
build is `@fabrika/app/build`'s recipe with every check, run inside the sandbox, and the generated dev launcher of the
application's own `@fabrika/app` release starts instead of the serving entry, with its configuration (the bootstrap
head, the authored SPA commands, the check chain) written after the build passed. The launcher migrates and verifies at
boot and on every sync itself, and reports health to Control. A sandbox refuses runtime packages, object storage, the
ClamAV scan and a `${…}` reference, in one line each. The artifact passes the same compile as any other, so the exposure
refusals below apply unchanged.

### A deploy registers its commit's descriptor

The registered manifest keeps its copy of `zerops.yaml`, and every reader reads that copy: the deploy renders the
execution descriptor from it, the dev sandbox takes its SPA commands from it, and the setup name and build base come
from it. When a deploy run's commit carries a `zerops.yaml` whose digest is not the registered one's, the run
re-registers it instead of failing on the mismatch: Control reads the file at that commit, the provider replaces the
manifest's source descriptor with it and parses the result with `parseFabrikaManifest`, the parse a registration's
decode runs (`withSourceDescriptor`), and Control resolves the source again at that commit. The run deploys with that
manifest and stores it once its publication passed, so a run that parks for approval stores it only when it resumes
approved, and a refused one never. Nothing reads the stored descriptor in between: the publication reads the
environment's placement and routing, which the descriptor does not change. A file the parse refuses fails the run before any build, in one line that names the commit
and the refused key. An unchanged file writes nothing. No `fabrika app build --env` and no `apps environments put`
follows an edit of `zerops.yaml`.

- **Who.** Only a deploy run of the environment, which already passed its own authorization: on a protected
  environment, a person's deploy or a push to its trigger ref ([ADR-0050](0050-approved-access.md)). A dev bootstrap
  never re-registers, because every workspace's sandbox shares the dev environment's manifest, and neither does a run
  of a workspace branch: that branch reaches an environment's manifest once it is merged into a ref outside the
  workspaces. So the MCP paths cannot reach it: a workspace write deploys nothing, `bind_dev` starts at most a dev
  bootstrap, and `deploy_stage` deploys a workspace branch. The run log records the commit and both digests; the run
  row records who started it. A registration through the API is audited (`app.env.upsert`); a run's is not, since no
  request carries it.
- **Concurrency.** The write happens under the run's lease and only while the stored manifest is still the one the run
  read, so a second run of the environment waits for the first, and a registration that lands in between fails the run
  rather than being overwritten. It compares the manifest, not the registry generation, because the run's own
  publication advances that.
- **Only a contract application.** `fabrika app build` also refuses a plain credential in the run section of an
  application without a contract, against the `notSecret` list of its config, which the stored manifest does not carry.
  Its run would skip that check, so such an application keeps the earlier behaviour: the mismatch fails the run and its
  line names `fabrika app build --env` and `apps environments put`. For a contract application the check differs in
  scope: `fabrika app build` reads the `envVariables` and `routing.headers` of every setup of `zerops.yaml`, the run's
  parse only the setup that runs, which may hold neither (above). So another setup of the file, one this application
  never runs, can now carry a value that looks like a credential, and Control stores it with the manifest. It never
  reaches a Zerops service of this application; it was already readable in the repository.
- **Not checked at deploy.** The build base against `bun.lock` is checked by `fabrika app build` and the builder, not by
  the run; a base that cannot read the lockfile fails the Zerops build instead. The approval diff of
  [ADR-0050](0050-approved-access.md) covers access, not the build, so a changed `zerops.yaml` is not an approval item.
- The namespace proxy's source pin reads through the same digest check and still fails on a mismatch: its pin changes
  only through `namespaces update --proxy-source` ([ADR-0045](0045-upload-immutable-platform-and-namespace-proxy-sources.md)).

### Exposure is refused, with no approval path

The compiler refuses these fields on application services:

- a storage policy that is not private, and a raw storage policy;
- `enableSubdomainAccess`;
- `buildFromGit`;
- an inline `zeropsYaml`;
- `mount`;
- `enableCdn`;
- `startWithoutCode`: an import that carries it activates an empty version and demotes the running
  code before any read-back. Only the platform's first provisioning imports a service without code.

A bucket is accepted only when the platform created it as private and it carries that provenance. The
provenance is the `FABRIKA_STORAGE_PROVENANCE` variable on the deploy service: the ids of the buckets a
Fabrika import created, each from a document that carried `objectStoragePolicy: private`. The import's
answer is the only evidence of creation: a re-apply reports nothing for a service that already exists.
So the evidence is persisted where it appears. The first registration's collision-refusing import keeps it
in the environment's stored target, and the first deploy writes it into the variable. A deploy whose import
creates a bucket records it in the variable inside the import step, before any other step runs, and a
cancel does not interrupt that. A bucket that already
existed under its hostname has no evidence and is refused. Before activation, the deploy reads back `subdomainAccess`
of every declared service from Zerops and checks every bucket's provenance. A failed check blocks
activation and raises an Operations alert: an error event in the application's own Operations project,
which its alert rules deliver.

Only CSP extensions in the contract are approvable, through the approval diff of
[ADR-0050](0050-approved-access.md). No other exposure has an approval path.

The compiler refusals are in place: `parseFabrikaManifest` applies them to every application service,
on build and on decode; an `enableSubdomainAccess` or `enableCdn` of `false` exposes nothing and is
accepted. An object-storage service that omits its policy is given an explicit `private`, because
Zerops' default is not established. Control and the providers refuse the names of
`FRAMEWORK_VARIABLE_NAMES` in `@fabrika/auth-core`. Every application deploy reads back exposure and
bucket provenance before it reserves a version.

A contract application is a Zerops config that carries its compiled contract. For it the compiler
refuses every setup key the platform owns and renders the generated setup, with the checker fetched at
the provider's own version and recorded in the run log. Not built yet:

- `fabrika job run`, which the generated crontab calls (A15);
- nothing of the snapshot (B6 built it): the run's snapshot records the checker version, and the contract
  Control approved at the commit decides the lock-down, so a config that drops `target.contract` cannot
  drop it (`lockedExecutionFor`).

## Consequences

The execution document has the same decoded meaning that passed ownership checks, and holds nothing else.
One `zerops.yaml` can carry a setup per placement (an app's cheap and dedicated tiers) or per app in a
monorepo. A descriptor using
unsupported syntax must be rewritten into the accepted subset, usually by quoting ambiguous values
or expanding aliases. This is an intentional input-contract restriction, approved before implementation.

Original source identity and execution serialization are separate. The platform-owned overlay
preserves that distinction: the source descriptor's bytes and digest stay the identity, and the
execution document carries the generated `run` and `build`.

- An application cannot start outside the generated entrypoint, skip its migrations or skip the
  checks, except in a `dev` environment, which starts through the generated dev launcher, migrates on every
  sync, and runs the checks only on request (`run_checks`). A repository that tries is refused at compile time,
  with one actionable line.
- The authored SPA commands run before the checks, inside the same build. An authored SPA command that
  deliberately sabotages the toolchain is not stopped. A separate build for the SPA is the next step.
- The build is slower: every deploy installs, type-checks, checks the contract and runs migrations.
- The authored descriptor loses freedom: no custom start command, no custom `run` section, no package
  overrides of `@fabrika/*`.
- A contract application with a database costs at least 0.5 GB of RAM per container. An existing installation
  converges on `fabrika platform upgrade` and the application's next deploy: the step is Control's code, not the
  application's, so no package update of the application is needed. Until then the earlier release's deploys can
  still be killed at start.
- A database too small for its application's container range costs more RAM. At Zerops' price of $3 per GB and
  30 days, raising one database node from the 0.25 GB floor (1 container and 2 jobs) to 0.5 GB (2 containers and 2
  jobs) costs $0.75, to 1 GB (8 containers and 2 jobs) $2.25, and to 2 GB (10 containers) $5.25 per 30 days; an HA
  service has three nodes. The Notes example (4 containers, 2 jobs) needs 1 GB. Raising a single-node database
  restarts it once, about 15 s after the raise (measured live, 2026-10-16): the version still serving loses its open
  connections, and no fresh connection was refused.
- A process serves at most as many requests at once as it has connections, because a request holds its connection
  for its transaction; more throughput comes from more containers or a larger database.
- The share is computed at deploy. A maximum container count raised later in the Zerops GUI holds until the next
  deploy, which raises the database again; the step never lowers a minimum.
- Rollout path of an existing installation. No generated installation file changes. `FABRIKA_APP_DATABASE_CONNECTIONS`
  is a literal of the run section every deploy generates, never a service variable, so nothing removes it. The
  database's minimum RAM is provider state the step only raises. `fabrika platform upgrade` and the application's
  next deploy therefore raise its database where needed and hand it the variable. The application reads the
  variable, and the test kit waits and holds 4 connections, only once it updates its `@fabrika/app`, `@fabrika/db`
  and `@fabrika/cli`: the init commands run the application's own installed packages. Before that, its processes
  keep 10 connections each and only the raised database helps it.
- The checks run before `run.start`, so a long migration delays a container's start but never fails its readiness
  check. Rollout path of an existing installation: no generated installation file and no variable changes. The init
  commands and the scripts belong to the execution descriptor every application deploy generates, so `fabrika platform
  upgrade` and the application's next deploy move the checks; the application needs no package update. Until that
  deploy, the version that serves keeps its earlier start script, and a restart of it runs the checks inside the
  readiness window as before.
- An application is reachable only through the namespace proxy. A bucket policy changed outside
  Fabrika is not detected, because Zerops has no API to read a policy back.
- Evidence can still be lost when the import step itself dies between the import's answer and the
  variable write (a failed write, a lost lease, a killed process). The run log then names the bucket, and
  the refusal of the next deploy names the two remedies: an operator who confirms the bucket's
  `stack.create` process ran under the platform's token sets the variable by hand, not sensitive;
  otherwise the bucket is deleted and the next deploy creates it. A variable a release up to v0.4.2
  wrote sensitive reads back without its value and is treated as absent, with the same remedies.

- A deploy re-registers a contract application's changed `zerops.yaml`. Rollout path of an existing installation: no
  generated installation file, variable or provider state changes. The registered manifest keeps its form (manifest
  version 3), and `fabrika platform upgrade` brings the Control that re-registers; an application needs neither a
  package update nor a new manifest, and its next deploy with a changed `zerops.yaml` stores it.

## Alternatives considered

- Keeping the original YAML with a different parser still leaves downstream interpretation differences.
- JSON-only authoring would unnecessarily reject normal committed YAML descriptors.
- Supporting every YAML feature would require additional rules for tags, aliases, merge semantics and
  reader-specific coercion. The strict subset meets the current application requirements.
- **Keep the authored `run` section and check it.** Rejected: any authored start command can start a
  different server.
- **Let authored commands run after the checks.** Rejected: a later command can undo what the checks
  proved.
- **A separate build for the SPA.** Deferred: it removes the toolchain-sabotage gap, but v1 keeps one
  build.
- **Derive provenance from Zerops: accept a bucket whose `stack.create` process the platform's token
  started.** Rejected: the same token creates the installation's and the namespaces' services and is
  held by the operator, so it proves who created a bucket, not that an import of this application
  created it private. An application could then adopt another service's bucket by hostname. It is the
  check an operator makes before restoring the variable by hand.
- **Keep the evidence in the environment's stored target on every deploy.** Rejected for now: a deploy
  cannot write its stored target through the provider contract, and the variable write right after the
  import closes the observed failure.
- **An approval path for exposure.** Rejected: a public bucket or a subdomain bypasses the proxy, so
  no contract could describe what it exposes. Only CSP extensions are approvable.
- **`FABRIKA_CONTRACT_DIGEST` as a service variable.** Rejected: a service variable is mutable across
  restarts and rollbacks, so older code could start with a newer digest.
- **Make the application declare `verticalAutoscaling.minRam`, as a scanning one does.** Rejected as the only
  mechanism: an import does not change an existing service, so an installation would not converge, and every
  application would carry a platform number. The build still refuses a scanning application without its 2 GB.
- **Raise the RAM for a moment from the init commands (`zsc scale ram`).** Rejected: it takes effect in about
  10 s, so the script would have to wait for it, and a restart outside a deploy would repeat it.
- **Keep the checks in the start script and raise the readiness `failureTimeout`.** Rejected: it only buys time.
  Every start, restart and added container still waits for the checks inside the window, and an application that
  grows past the new limit fails the same way.
- **Run the checks once in the deploy run, against a throwaway database.** Rejected for now: the build has no
  database, and a check outside the container would no longer prove the version that serves against its own schema.
- **Let each process read `SHOW max_connections` at boot and take a share.** Rejected: a process cannot know how
  many containers, jobs and replaced containers share the limit; the deploy reads both services.
- **A lower fixed pool with an override.** Rejected: no one number fits 20 connections for 10 containers and 200 for
  2, and an override puts a platform number into every application.
- **pgBouncer on `portTls`.** Rejected: it refuses every role fabrika creates (measured 2026-10-15).
- **A `CONNECTION LIMIT` on the runtime role.** Rejected: it turns too many connections into failed requests instead
  of preventing them.
- **Give every application's database 1 GB.** Rejected: one container with up to 2 jobs fits the 0.25 GB floor.
- **Retry the whole `bun test` run on a refused connection.** Rejected: a refusal inside a case reads as a failed
  assertion, not as a refusal; the test kit opens its pools before the first case and waits there instead.
