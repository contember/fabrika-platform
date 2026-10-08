---
id: 0011
title: Compose one static provider bundle per installation; the provider owns its deploy
status: accepted
date: 2026-10-07
---

# 0011 — Compose one static provider bundle per installation; the provider owns its deploy

## Context

One installation runs on one cloud: its Control plane, IAM, and every app it deploys.
fabrika supports Cloudflare and Zerops today.

The two clouds deploy differently, not just with different API calls:

- **Cloudflare:** fabrika builds, provisions, migrates, deploys the Worker, reconciles the
  IAM schema, and pushes secrets. Each step is a separate command or API call, in that order.
- **Zerops:** the platform builds and activates a version in one operation. Migrations run as
  a container-start hook. Secrets already live in the platform (ADR-0004). See
  [`zerops-platform.md`](../reference/zerops-platform.md).

So a shared step list, a shared plan executor, or a shared set of collaborators forces one
cloud to fake the shape of the other. Each cloud also needs different credentials and
clients: Cloudflare needs a shell, `wrangler`, oblaka, and an account token; Zerops needs an
HTTP client and a personal access token.

Shared Control code must still run the deploy lifecycle — queue, lease, run status, logs,
cancellation, secrets, namespaces — without knowing which cloud is underneath.

## Decision

**One static provider bundle per installation.** Each cloud is one provider bundle behind
an open contract in `@fabrika/provider-contract`. The installation's composition root imports
exactly one bundle and hands it to shared Control code. There is no provider registry, no
default provider, and no closed union of provider ids.

**The provider owns its deploy.** A provider's `deploy()` runs its own steps, in its own
order, as plain code. No shared engine derives or executes a plan. Control passes the run's
universal inputs — app, environment, secrets, vars, managed environment, return origins,
`dryRun`, an `AbortSignal`, and an event sink for logs and the external id. Control does not
see the provider's steps.

**The provider owns its collaborators and credentials.** The composition root constructs the
provider with its clients and installation credentials (Cloudflare account and token, Zerops
token). They never travel through `deploy()` arguments or persisted data. Tests substitute
collaborators at the same construction point.

**The contract is small.** `ControlProvider` has:

- `id` and `deploy()` — required.
- `resolveSource()` — optional. Pins a requested ref to a commit before deploy.
- `cancel()`, `reconcile()` — optional. For deploys that outlive one invocation.
- `normalizeRegistration()` — optional. Validates and canonicalizes provider data at
  registration; absent means the stored data is used as is.
- `declaredVariables()` — optional. `undefined` means "cannot know".
- Capability objects — optional: `secrets` (provider-managed secret storage), `namespaces`
  (ADR-0014), and the provider's source mode (how private GitHub sources reach it, ADR-0029).

`resolveSource()` and `deploy()` each take an optional source binding. There is one entry
point per operation, not a bound and an unbound variant.

**Shared Control code never checks a provider name.** Behaviour that differs by cloud is a
capability the provider declares or omits. The provider id appears only in the two
composition roots, in envelope validation, and where the console picks a form by it.

**Envelopes only where data is persisted.** Provider-owned data stored by Control —
`app_envs` target and artifact, `deployment_namespaces` target — is a versioned JSON envelope
`{ provider, version, payload }`. The provider decodes it with its own codec and fails closed
when the provider id or version does not match. Data that only passes through a call is a
plain typed value, not an envelope. A run's provider checkpoint and a namespace-proxy attempt are
deliberate exceptions: small provider-owned records, parsed with a schema at read and disposable
across versions ([ADR-0044](0044-zerops-delivery-ownership-and-recovery.md)).

**Package layout.** Every package uses the `@fabrika/*` scope. The provider packages:

| Package                                 | Visibility | Contents                                                                               |
| --------------------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| `@fabrika/provider-contract`            | public     | `.` the provider contract · `/installation` the open platform-installation contract    |
| `@fabrika/provider-cloudflare`          | public     | `.` authoring and control adapter · `/cli` · `/installation` · `/runner` (runner job)  |
| `@fabrika/provider-zerops`              | public     | `.` authoring and control adapter · `/cli` · `/installation` (+ `/topology`)           |
| `@fabrika/installation-init`            | public     | The operator-side `init` mechanics both `provider-<cloud>/installation` subpaths share |
| `runner-cloudflare`, `runner-container` | private    | The Cloudflare deploy executor Worker and its container image                          |
| `platform-artifacts`                    | private    | Zerops installation codegen and generated topology output                              |

The two composition roots stay inside `@fabrika/control` (`src/index.ts` with `src/platform-cf.ts`
for Cloudflare, `src/zerops/` for Zerops).
Only the Cloudflare root imports `@fabrika/provider-cloudflare`; only the Zerops root imports
`@fabrika/provider-zerops`.

This follows ADR-0013's rule: adapters share one package with subpath exports while they
have no independent dependency or release boundary. A cloud's authoring, control, and
installation halves version and release together. The deployables split off because they
are build artifacts, not libraries.

`@fabrika/platform` stays a separate axis. It describes the host runtime (SQL, queues,
blobs, locks). The composition root binds one runtime implementation set to one provider.

## Consequences

- Adding a cloud means writing one provider package and one composition root. Shared Control
  code, the contract, and the database schema do not change.
- A provider's deploy log shows only steps that really happen. There are no no-op steps and
  no split of one atomic platform operation into two.
- Progress, failure, and cancellation semantics are per provider. Each `deploy()` must honour
  `dryRun`, check the signal at its own step boundaries, and report through the event sink.
- Control cannot load provider code named by persisted data. A stored envelope from another
  provider fails closed.
- Cloudflare-only dependencies (`oblaka-iac`, Workers types) stay out of the contract and of
  shared Control typechecks.
- An npm consumer installs one package per cloud. Subpaths keep installation and runner
  dependencies out of an import of `.`.
- One installation managing several clouds would need a new decision and a runtime registry.
  The contract deliberately does not support it.

## Alternatives considered

- **A shared engine that executes a provider-supplied plan** (`RuntimeProvider`, sessions,
  job specs with `dependsOn`, runtime envelopes). Rejected: each provider has one fixed step
  order, so the plan/step indirection adds types, envelope round-trips, and a package without
  adding a choice. A plain `deploy()` is shorter and equally testable.
- **One fixed plan with per-step conditionals, or a superset plan with no-op steps.**
  Rejected: the clouds differ in the shape of the sequence, not in step bodies. A no-op
  `sync-secrets` step is a false entry in the deploy log.
- **One shared collaborator bundle passed to `deploy()`.** Rejected: a Zerops deploy has no
  shell or filesystem, so most members would be meaningless to it.
- **`*WithBinding` variants of `resolveSource`/`deploy`.** Rejected: two entry points for one
  operation, plus a side channel to pass the binding between them.
- **Provider-name checks in shared Control code.** Rejected: every new cloud would edit shared
  routes, SQL, and webhook handling.
- **A dynamic provider registry per app environment.** Fits a multi-cloud SaaS or third-party
  plugins. Rejected: it conflicts with one cloud per installation and adds plugin ABI,
  distribution, and trust problems with no consumer.
- **Separate packages per half** (contract, engine, provider, installation, runner contract per
  cloud). Rejected: the halves share a release and dependency boundary, so separate packages
  only add publish surface and cross-package wiring.
