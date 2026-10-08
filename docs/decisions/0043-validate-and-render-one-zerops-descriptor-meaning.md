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

Check decoded keys and string values in every setup for foreign-service references. Select a single
setup deterministically: the sole setup may be implicit; multiple setups require an explicit selector.
Send the validated document through the shared YAML emitter and pass the selected setup explicitly
on both initial builds and recovered builds.

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
2. Then the generated commands run: a frozen install with lifecycle scripts off, a hash check of
   `@fabrika/*` in the lockfile, `tsc` with the platform's `tsconfig`, the checker, the contract check,
   the migrations into a throwaway schema with codegen verification, the generated isolation tests,
   and the server build.

No authored command runs after the checks. The build refuses the routine ways to replace `@fabrika/*`:
`patchedDependencies`, `overrides`, `resolutions`, non-registry specifiers, a `bunfig` `preload`,
`tsconfig` `paths` and `declare module '@fabrika/*'`. The checker version is pinned and recorded in the
run's snapshot.

The overlay carries no secret value. Secrets stay managed variables
([ADR-0004](0004-secrets-live-in-the-platform.md)).

**Framework-only variable names are one list.** It reserves the names of the database, storage,
proxy-secret, job and connector credentials. Control's `assertUnmanagedName` and the provider's
`MANAGED_KEYS` both use that list. Both refuse an authored variable or a secret under one of those
names. The framework reads these variables and removes them from `process.env`.

Two platform facts this design needs are not verified yet: whether exec readiness gates a Zerops
deploy, and whether a failed `initCommands` stops activation. Each gets a row in the
[platform facts](../reference/zerops-platform.md) before the generated `run` section ships.

### Exposure is refused, with no approval path

The compiler refuses these fields on application services:

- a storage policy that is not private, and a raw storage policy;
- `enableSubdomainAccess`;
- `buildFromGit`;
- an inline `zeropsYaml`;
- `mount`;
- `enableCdn`.

A bucket is accepted only when the platform created it as private and it carries that provenance.
Before activation, Control reads back `subdomainAccess` from Zerops. A failed check blocks activation
and raises an Operations alert.

Only CSP extensions in the contract are approvable, through the approval diff of
[ADR-0050](0050-approved-access.md). No other exposure has an approval path.

The code does not render `run` or `build`, share the list of framework-only names, read back
`subdomainAccess` or check bucket provenance yet (part B, work unit B7). The compiler refusals are part 0, work unit P0.4.

## Consequences

The execution document has the same decoded meaning that passed ownership checks. A descriptor using
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
- An application is reachable only through the namespace proxy. A bucket policy changed outside
  Fabrika is not detected, because Zerops has no API to read a policy back.

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
- **An approval path for exposure.** Rejected: a public bucket or a subdomain bypasses the proxy, so
  no contract could describe what it exposes. Only CSP extensions are approvable.
- **`FABRIKA_CONTRACT_DIGEST` as a service variable.** Rejected: a service variable is mutable across
  restarts and rollbacks, so older code could start with a newer digest.
