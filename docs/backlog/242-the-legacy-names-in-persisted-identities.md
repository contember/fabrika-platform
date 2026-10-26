---
id: 242
title: The legacy names in persisted identities
blocked-by: []
---

# 242 — The legacy names in persisted identities

**Summary.** The predecessor names `vozka` (Control), `propustka` (IAM) and `poplach` (the error tracker Operations
absorbed) are gone from comments, docs, sample data and local identifiers, but 24 deployed or stored identities still
carry `vozka` or `propustka`. This item lists each one and what renaming it would cost an existing installation. It
records no decision; the owner decides whether and when any of them moves.

## Problem

A text rename cannot reach a name that is a deployed resource, a stored record or part of the protocol between an
application and the platform ([ADR-0024](../decisions/0024-canonical-environment-names.md),
[ADR-0062](../decisions/0062-a-platform-release-serves-older-framework-releases.md)). Those names stay, so a reader
still meets `vozka` and `propustka` in configs, tests that pin real names, and the console's URLs.

### Cloudflare Workers

| Identifier                     | Where                                                                                | Cost of renaming on an existing installation                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vozka` (remote `<env>-vozka`) | `packages/control/fabrika.config.ts`, `wrangler.jsonc`                               | A new Worker: its secrets re-put, `vozka-proxy`'s `APP` binding repointed, the old one deleted after.                                                                                                                     |
| `vozka-proxy`                  | `packages/control/fabrika.config.ts`                                                 | The console's Custom Domain moves to the new Worker; a short outage unless both serve during the cut-over.                                                                                                                |
| `vozka-runner`                 | `packages/runner-cloudflare/fabrika-runner.config.ts`, `wrangler.jsonc`              | Control's `RUNNER_SVC` binding repointed. The `RunnerContainer` namespace belongs to the script, so runs in flight on the old one are lost: drain first.                                                                  |
| `propustka-worker`             | `packages/iam/fabrika.config.ts`, `provider-cloudflare/src/proxy.ts` (`IAM_SERVICE`) | Every deployed application and its proxy binds `<env>-propustka-worker` by name. Under ADR-0062 the old Worker keeps serving until no release in the support window binds it; the bounds' reserved names must cover both. |

### Storage, queues and containers

| Identifier                                        | Where                                                                                  | Cost                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 `vozka`                                        | Control's registry, runs, vault                                                        | A new, empty database: a data move, with Control stopped or read-only during it.                                                                                                                                                                                                                        |
| D1 `propustka`                                    | IAM's principals, grants, sessions, audit                                              | A new, empty database: a data move; every session is lost unless moved.                                                                                                                                                                                                                                 |
| R2 `vozka-run-logs`                               | Control reads, the runner writes                                                       | A new bucket: copy the logs or accept that older runs lose them.                                                                                                                                                                                                                                        |
| Queue `vozka-deploy` (Cloudflare)                 | Control's deploy queue                                                                 | A new queue: drain the old one before the switch.                                                                                                                                                                                                                                                       |
| Container application `vozka-deploy-runner`       | `fabrika-runner.config.ts`                                                             | Account-global and tied to the DO namespace; it was renamed once already (from `vozka-runner`). A new one, after a drain.                                                                                                                                                                               |
| KV `propustka-state`                              | oblaka's state namespace for the platform (`platform.yml`)                             | oblaka reads state from it; a new namespace without the state re-provisions resources it no longer knows. A state copy, verified by a dry run.                                                                                                                                                          |
| Postgres queue names `vozka-deploy`, `vozka-mail` | `packages/control/src/bun/runtime.ts` (rows in Control's jobs table, Bun process only) | A migration that renames pending rows, or a drain; a Bun process of the old release still reads the old name during a rolling deploy. `vozka-mail` is the Bun process's mail dispatch queue (ADR-0064); the Worker's relay already uses the new `fabrika-mail` queue and `fabrika-mail-content` bucket. |

### Worker entrypoints and Durable Object classes

| Identifier             | Where                                                               | Cost                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PropustkaApplication` | `packages/iam/src/index.ts`, `IAM_APPLICATION_ENTRYPOINT`           | Part of the protocol: every deployed application binds this entrypoint. Keep it exported as an alias for the support window (ADR-0062), and have the bounds accept both. |
| `Propustka`            | IAM's default export, also a named export                           | Bindable by name; platform components bind the default. Rename with an alias export.                                                                                     |
| `Vozka`                | Control's default export, also a named export                       | As above.                                                                                                                                                                |
| `VozkaRunner`          | The runner's default export, a type of `@fabrika/runner-cloudflare` | As above; Control imports the type.                                                                                                                                      |

No Durable Object class carries a legacy name today (`RunnerContainer`, `FabrikaApplication`). A future one that did
would move with a `renamed_classes` migration in the committed `wrangler.jsonc`.

### IAM application ids

| Identifier  | Where                                                                                                                   | Cost                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vozka`     | `CONTROL_APP_ID`, `OPERATIONS_AUTH_APP_ID`, `DEFAULT_ADMIN_AUDIENCES`, the Zerops proxy manifest, the builder's consent | Stored in IAM's grants, schema tables and audit rows, in every token's `aud`, in each installation's proxy manifest (baked into the Cloudflare console proxy), in login URLs (`?app=vozka`) and possibly in an operator's `FABRIKA_IAM_ADMIN_AUDIENCES`. A data migration across IAM's tables plus a window in which both ids resolve. |
| `propustka` | `IAM_APP_ID`, `DEFAULT_PLATFORM_AUDIENCES`                                                                              | The same stores; administrators' grants at `propustka` (ADR-0058) move with them.                                                                                                                                                                                                                                                      |

### Operator inputs and other stored values

| Identifier                            | Where                                                                | Cost                                                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retire_legacy_propustka_worker`      | the sidecar workflow's input (`installation/templates/platform.yml`) | Operator-facing: a rename breaks an operator's saved dispatch. The template is rewritten on `init`; the old input can stay as an alias for one release. |
| `vozka.ref`, `propustka.ref`          | `LEGACY_REF_FILES` in `installation/scaffold.ts`                     | They detect the pre-merge scaffold; they name what an old installation has and must not change while one may exist.                                     |
| `vozka-runner/container-instance/v1:` | `INSTANCE_NAME_CONTEXT` in `runner-cloudflare/src/runner-key.ts`     | Derives each run's container instance name; a change orphans running containers and needs a drain (or a `v2` context read beside `v1`).                 |
| `service: 'vozka'`                    | Control's `/api/health` body (`packages/control/src/app.ts`)         | An operator's monitor may match it. Cheap, but a visible change.                                                                                        |
| SQL comments                          | `packages/control/migrations{,-postgres}/0001_init.sql`              | Migration files are never edited (ADR-0017); they keep the word until a squash.                                                                         |

Variables: no `VOZKA_*` or `PROPUSTKA_*` environment variable remains (ADR-0024); an operator's value may still name
the `vozka` id (for example `FABRIKA_IAM_ADMIN_AUDIENCES`).

### Kept text, not identities

- `packages/builder/decisions/technologies/fabrika-iam.md`, `fabrika-control.md`, `patterns/fabrika-app-deploy.md` and
  `stacks/cf-internal-app.md` describe the predecessor SDK (`@propustka/client`, `PropustkaAuth`, `PROPUSTKA_URL`),
  which has no current equivalent. They need a content rewrite for today's Cloudflare path, not a rename.
- History stays as history: `README.md`'s origin line, `docs/reference/overview.md`'s origin paragraph,
  `tests/browser/legacy-poplach-inventory.md`, the ADRs, `docs/archive/`, and comments that name an old deployed name
  (`the old vozka-runner container application`, `vozka-platform-<account>`).

## Approach / acceptance

Decide per kind, not as one rename. For each identifier moved: an upgrade step that converges an existing installation
(the root CLAUDE.md's four rollout questions), the old name kept served where ADR-0062 requires it, and a test of the
upgrade path where one can reach it.

## Touch points

`packages/control/`, `packages/iam/`, `packages/runner-cloudflare/`, `packages/provider-cloudflare/` (`plan.ts`'s
reserved names, `proxy.ts`, `installation/`), `packages/provider-zerops/src/installation/`, `packages/control-contract/`,
`packages/iam-contract/`, `packages/operations/src/auth.ts`, the committed `wrangler.jsonc` files.
