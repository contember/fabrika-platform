# Example app — targeting Zerops

A small notes API, deployed by fabrika **to Zerops**. It is a worked example meant to be copied: every
file here is one an app author writes, and nothing in it is a stub.

This directory is both a fabrika-platform workspace fixture and the complete root of the standalone
[`contember/fabrika-example-zerops`](https://github.com/contember/fabrika-example-zerops) repository.
Zerops requires `zerops.yaml` at the root of the repository it builds. The standalone repository must
therefore contain this directory's files directly, not the surrounding monorepo or an extra directory.

The monorepo directory is the source of truth. Mirror it without changing the tree:

```bash
git subtree split --prefix=examples/zerops-app -b fabrika-example-zerops
git push https://github.com/contember/fabrika-example-zerops.git fabrika-example-zerops:main
git branch -D fabrika-example-zerops
```

Do not edit the mirror directly. A fresh export must pass `bun install --frozen-lockfile`,
`bun run typecheck`, and `bun test` from its repository root. The normal fabrika-platform workspace
checks continue to exercise the same files locally.

The [Cloudflare example](https://github.com/contember/fabrika-platform/tree/main/examples/app) is a
separate example because each provider owns its authoring surface and build command. A config imports
only the provider it targets, so provider-specific resource types do not leak into a shared union. On
both providers the proxy enforces route gates. The app only verifies the proxy-injected token and
applies per-object checks that a path gate cannot express
([ADR-0022](https://github.com/contember/fabrika-platform/blob/main/docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md)).

## What is where

| File                          | What it is                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `fabrika.config.ts`           | The deploy surface: a Zerops `target` — two services in a project — plus the app's schema.              |
| `fabrika.cheap.config.ts`     | Cheap-tier variant: one runtime that claims the namespace-owned `postgres` service.                     |
| `fabrika.schema.ts`           | The authorization vocabulary (scopes, actions, roles), reconciled into IAM by the deploy.               |
| `fabrika.gates.ts`            | The per-path gates. Enforced by the **proxy**, never by this process.                                   |
| `zerops.yaml`                 | The build/run descriptor Zerops reads from the repository root.                                         |
| `zerops.shared-postgres.yaml` | Cheap-tier build descriptor using `${postgres_connectionTlsString}`.                                    |
| `src/server.ts`               | `run.start` — the `@fabrika/app` Bun adapter. Listens on the project's private network only.            |
| `src/migrate.ts`              | `run.initCommands` — migrations at container start, which is why the deploy plan has no `migrate` step. |
| `src/authz.ts`                | Verifies the proxy-injected token and answers `can()` / `scopedTo()`.                                   |
| `src/app.ts`                  | The Fetch app: one route per gate, auth middleware, and the per-object checks gates cannot express.     |
| `src/operations-browser.ts`   | A browser witness that sends one marked exception through the managed Operations DSN.                   |

## The shape of a Zerops deploy

```
apply-import → trigger-deploy → await-deploy → reconcile-schema
```

Four steps, and the differences from Cloudflare's plan are all deliberate
([ADR-0003](https://github.com/contember/fabrika-platform/blob/main/docs/decisions/0003-no-deploy-runner-on-zerops.md)):

- **no `build`** — Zerops has its own CI. fabrika triggers it; it does not run it, and there is no
  deploy runner and no container anywhere on this path.
- **no `deploy-worker`** — build and deploy are one indivisible platform-side operation. What fabrika
  splits instead is _triggering_ it from _observing_ it.
- **no `migrate`** — `run.initCommands` runs on every container start.
- **no `sync-secrets`**, and this one is a decision rather than an omission. On Zerops the platform is
  the system of record for secret values and they change without a redeploy
  ([ADR-0004](https://github.com/contember/fabrika-platform/blob/main/docs/decisions/0004-secrets-live-in-the-platform.md)), so a deploy-time push would
  silently overwrite a client's GUI edit.

The fabrika-platform test suite drives the neutral deploy executor with the Zerops provider over a
recording fake. It asserts that exact plan and the exact ordered sequence of API calls a real run would
make.

## Where the secrets go

Nowhere in this directory. `fabrika.config.ts` names two under `pipeline.secrets` as documentation of
what the app needs; nothing in fabrika transports their values on Zerops. They are written **once**, as
service-level `envSecrets` on the `notesapi` service, through the env API — addressed by service,
because a project-level variable is injected into every service in the project and one project holds
many apps.

That is also why the first import provisions with `startWithoutCode: true`: the env API is addressed by
service, so the service has to exist before its secrets can be set. Bring-up is
**import-without-code → write secrets → deploy**.

`zerops.yaml` carries `${notesdb_connectionString}`, which is a _reference_ to another service's
platform-held variable, not a value.

Fabrika also writes `FABRIKA_OPERATIONS_DSN` and `FABRIKA_RELEASE` as managed
service-level variables before triggering a deploy. They are intentionally
absent from the static app manifest and from this repository's `zerops.yaml`.
Applications must not declare those reserved names.

The authenticated `/operations-sdk` fixture is the minimal browser adoption
example. The server exposes only those two browser-safe managed values through
`/operations-sdk/config`; no application secret enters its HTML or JavaScript.
It uses the exact `@sentry/browser` version pinned in `package.json` and disables
the SDK's default integrations to keep this witness limited to error events.

## Namespace isolation fixtures

The example covers all three namespace tiers without changing the application protocol:

- **cheap** — use `fabrika.cheap.config.ts` and copy `zerops.shared-postgres.yaml` to
  `zerops.yaml`. The app imports only `notesapi` and claims the namespace-owned `postgres`.
- **mid** — use the default `fabrika.config.ts` and `zerops.yaml`. The app imports its own
  `notesdb` plus `notesapi` into a shared namespace.
- **full** — use the same default app files as mid, but assign the environment to a namespace whose
  `exclusiveAppId` is `notes`. The project then contains only the proxy and this app's services.

The fabrika-platform topology tests compile these fixtures and prove their exact service ownership
boundaries.

## Running it

There is no `bun run dev` that reproduces the deployed topology, and pretending otherwise would be the
dishonest part of an example. What you can do locally:

```bash
bun test                       # the authorization path, with a locally generated key set
bun run typecheck
```

To run the server you need a Postgres and an IAM origin:

```bash
NOTES_DATABASE_URL=postgres://…  NOTES_APP_ID=notes  FABRIKA_IAM_ISSUER=https://iam.example.com \
  bun src/migrate.ts && bun src/server.ts
```

Requests then need an `X-Fabrika-Token` the IAM service minted — in production the proxy puts it there,
and nothing else can reach the port.

## What has been proven

On 2026-08-11 Zerops built the public repository's `main` branch from this repository root. Its build
container ran `bun install --frozen-lockfile`, completed every build command, and prepared and uploaded
a 47.3 MiB artifact. This proves the repository-root layout, descriptor discovery, and standalone
lockfile in a real Zerops build environment.

The disposable probe service omitted the app database and runtime environment, so its later deploy
failed before the app could become active. A complete deploy, the readiness gate, the real Operations
custom domain, and proxy path isolation remain unproven. Zerops also owns the build filesystem and the
current provider does not publish its source maps to Operations; that remaining release-artifact work
is tracked in
[fabrika-platform backlog 36](https://github.com/contember/fabrika-platform/blob/main/docs/backlog/36-complete-zerops-release-artifact-correlation.md).
