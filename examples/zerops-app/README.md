# Example app — targeting Zerops

A small notes API, deployed by fabrika **to Zerops**. It is a worked example meant to be copied: every
file here is one an app author writes, and nothing in it is a stub.

The Cloudflare example lives next door in [`../app`](../app). This is a **second example**, not a
second target arm on that one, for a reason that shows up in the type system: `AppConfig` is a
discriminated union where the Cloudflare arm carries `target?: undefined` and the Zerops arm carries
`resources?: undefined`, so a single config cannot declare both. That restriction is honest — the two
deployments disagree about the thing that matters most. On Cloudflare the app imports the SDK and
enforces its own gates in-process; here it does not enforce them at all, because the proxy does
([ADR-0007](../../docs/decisions/0007-proxy-based-auth-enforcement.md)).

## What is where

| File                | What it is                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `fabrika.config.ts` | The deploy surface: a Zerops `target` — two services in a project — plus the app's schema.              |
| `fabrika.schema.ts` | The authorization vocabulary (scopes, actions, roles), reconciled into IAM by the deploy.               |
| `fabrika.gates.ts`  | The per-path gates. Enforced by the **proxy**, never by this process.                                   |
| `zerops.yaml`       | The build/run descriptor Zerops reads from the repository root.                                         |
| `src/server.ts`     | `run.start` — a long-running Bun process. Listens on the project's private network only.                |
| `src/migrate.ts`    | `run.initCommands` — migrations at container start, which is why the deploy plan has no `migrate` step. |
| `src/authz.ts`      | Verifies the proxy-injected token and answers `can()` / `scopedTo()`.                                   |
| `src/app.ts`        | The request handler: one route per gate, plus the per-object checks the gates cannot express.           |

## The shape of a Zerops deploy

```
apply-import → trigger-deploy → await-deploy → reconcile-schema
```

Four steps, and the differences from Cloudflare's plan are all deliberate
([ADR-0003](../../docs/decisions/0003-no-deploy-runner-on-zerops.md)):

- **no `build`** — Zerops has its own CI. fabrika triggers it; it does not run it, and there is no
  deploy runner and no container anywhere on this path.
- **no `deploy-worker`** — build and deploy are one indivisible platform-side operation. What fabrika
  splits instead is _triggering_ it from _observing_ it.
- **no `migrate`** — `run.initCommands` runs on every container start.
- **no `sync-secrets`**, and this one is a decision rather than an omission. On Zerops the platform is
  the system of record for secret values and they change without a redeploy
  ([ADR-0004](../../docs/decisions/0004-secrets-live-in-the-platform.md)), so a deploy-time push would
  silently overwrite a client's GUI edit.

`deploy/zerops/__tests__/example-app.test.ts` drives the real driver over a recording fake and asserts
that exact plan, and the exact ordered sequence of API calls a real run would make.

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

## What has not been proven

Nobody has run this against a real Zerops account. The import document is valid against Zerops'
published JSON schema, `zerops.yaml` is valid against its own published schema, and the deploy's call
sequence is asserted against the real driver — but "well-formed" is not "it deploys".
