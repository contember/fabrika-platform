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
  ([ADR-0017](0017-service-owned-postgres-migrations.md));
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

The build has no database. The migrations, the verification of the committed schema types and the
generated isolation tests therefore run at container start: the start script runs `fabrika db migrate`, then
`fabrika db codegen --verify` against the application's real schema, then `fabrika db test-isolation` on a
throwaway schema, then the server, under `set -eu`. A stale `schema.generated.ts` or a generated case that
did not pass leaves nothing that answers the readiness check, and the previous version keeps serving.

**A container starts with the memory its start script needs.** The isolation tests run as `fabrika db
test-isolation` and its `bun test` child, which together peak at 161 MiB of anonymous memory for the Notes example
and 225 MiB for the CRM example, within about 1.5 s. A Zerops runtime starts at 0.125 GB, and vertical autoscaling
reacts in 10–20 s, so the platform killed the run on 2 of 3 first deploys and marked the version `DEPLOY_FAILED`
(measured 2026-10-15, [platform facts](../reference/zerops-platform.md)). Each deploy therefore raises the deploy
service's minimum RAM to 0.5 GB for an application with a database, and to 2 GB for one that scans uploads, in the
`raise-start-memory` step before it reserves a version. An import cannot do it: Zerops ignores a changed
`verticalAutoscaling` of an existing service. The step changes only that field through the autoscaling API, reads it
back, and never lowers it. The tests still run at every container start, so the readiness check still proves that
they passed for the version that serves.

The overlay carries no secret value. Secrets stay managed variables
([ADR-0004](0004-secrets-live-in-the-platform.md)).

**Framework-only variable names are one list.** It reserves the names of the database, storage,
proxy-secret, job and connector credentials. Control's `assertUnmanagedName` and the provider's
`MANAGED_KEYS` both use that list. Both refuse an authored variable or a secret under one of those
names. The framework reads these variables and removes them from `process.env`.

The generated `run` section does not depend on two unverified platform facts: whether exec readiness
gates a Zerops deploy, and whether a failed `initCommands` stops activation. Its readiness check is an
`httpGet` of the contract's health endpoint, which is verified to gate a deploy. Its start script runs
`fabrika db migrate` again before it starts the server, so a failed migration leaves nothing to answer
the readiness check. Each fact has an `UNVERIFIED` row in the
[platform facts](../reference/zerops-platform.md), probed when a live account is configured.

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

- the generated isolation tests (A11); the build runs the application's own tests;
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
  checks. A repository that tries is refused at compile time, with one actionable line.
- The authored SPA commands run before the checks, inside the same build. An authored SPA command that
  deliberately sabotages the toolchain is not stopped. A separate build for the SPA is the next step.
- The build is slower: every deploy installs, type-checks, checks the contract and runs migrations and
  isolation tests.
- The authored descriptor loses freedom: no custom start command, no custom `run` section, no package
  overrides of `@fabrika/*`.
- A contract application with a database costs at least 0.5 GB of RAM per container. An existing installation
  converges on `fabrika platform upgrade` and the application's next deploy: the step is Control's code, not the
  application's, so no package update of the application is needed. Until then the earlier release's deploys can
  still be killed at start.
- An application is reachable only through the namespace proxy. A bucket policy changed outside
  Fabrika is not detected, because Zerops has no API to read a policy back.
- Evidence can still be lost when the import step itself dies between the import's answer and the
  variable write (a failed write, a lost lease, a killed process). The run log then names the bucket, and
  the refusal of the next deploy names the two remedies: an operator who confirms the bucket's
  `stack.create` process ran under the platform's token sets the variable by hand, not sensitive;
  otherwise the bucket is deleted and the next deploy creates it. A variable a release up to v0.4.2
  wrote sensitive reads back without its value and is treated as absent, with the same remedies.

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
- **Run the isolation tests with less memory.** Rejected: `--smol` on the test child saved 7 % and a forced
  collection in the CLI nothing, and the test child alone holds more than 0.125 GB.
- **Run the isolation tests once per version (`zsc execOnce ${ZEROPS_appVersionId}`).** Rejected: the run they
  start on still needs the same memory, which is what failed, and the command is not established to work in a
  start script. Running at every start costs about two seconds and keeps the check on every container.
- **Make the application declare `verticalAutoscaling.minRam`, as a scanning one does.** Rejected as the only
  mechanism: an import does not change an existing service, so an installation would not converge, and every
  application would carry a platform number. The build still refuses a scanning application without its 2 GB.
- **Raise the RAM for a moment from the start script (`zsc scale ram`).** Rejected: it takes effect in about
  10 s, so the script would have to wait for it, and a restart outside a deploy would repeat it.
