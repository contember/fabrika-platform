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
overlay. Of the build, the authored descriptor supplies only the SPA commands.

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

The compiler refuses authored `run` keys, `build.addToRunPrepare`, `build.deploy` and
`deploy.temporaryShutdown`.

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

Two platform facts this design needs are not verified yet: whether exec readiness gates a Zerops
deploy, and whether a failed `initCommands` stops activation. Each gets a row in the
[platform facts](../reference/zerops-platform.md) before the generated `run` section ships.

The code does not render `run` or `build` yet (part B, work unit B7).

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
- **`FABRIKA_CONTRACT_DIGEST` as a service variable.** Rejected: a service variable is mutable across
  restarts and rollbacks, so older code could start with a newer digest.
