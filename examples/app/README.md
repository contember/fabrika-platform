# Example app — a contract application on Cloudflare

A minimal contract application on Cloudflare Workers, in the layout of
[`application-architecture.md`](../../docs/reference/application-architecture.md). Its endpoints and their handlers are
in [`src/access/endpoints.ts`](./src/access/endpoints.ts), and [`fabrika.contract.ts`](./fabrika.contract.ts) mounts
them. The proxy Worker
enforces the contract's endpoint table; the application verifies the token the proxy injected and makes no enforcement
decision ([ADR-0022](../../docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md)).

The rules an agent follows when it changes this application are `@fabrika/app`'s skill
([`packages/app/skill/SKILL.md`](../../packages/app/skill/SKILL.md)).

## What is where

| File                                                         | What it is                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `src/vocabulary.ts`                                          | The vocabulary: dimensions (a `note` lies in a `project`), actions, roles.                                          |
| `db/migrations/*.sql`                                        | The application's SQLite migrations (STRICT tables, timestamps as UTC ISO text), applied by its Durable Object.     |
| `src/db/tables.ts`                                           | The table policies over `src/db/schema.generated.ts`, which `fabrika db codegen` writes from the migrations.        |
| `src/app-kit.ts`                                             | `defineApp(vocabulary, tables)`: the kit.                                                                           |
| `src/schemas.ts`                                             | The input and output schemas.                                                                                       |
| `src/access/endpoints.ts`                                    | The endpoints that answer from the caller's own grants, each with its callers, access form and `.handle(…)`.        |
| `src/notes/endpoints.ts`                                     | A project's notes: a write that may carry a file, a read, the file's download, and the `review` job.                |
| `fabrika.contract.ts`                                        | `app.contract(…)`: the `/api` and `/notes` mounts, the SPA, the health check, the `attachments` file kind, the job. |
| `web/`, `build-web.ts`                                       | The SPA (`site`, at `/`, for every member): a page that names the signed-in person; `bun run build:web` builds it.  |
| `src/app.ts`                                                 | `serve(contract, { database: scoped(tables) })`.                                                                    |
| `fabrika/entry.generated.ts`                                 | The Worker entrypoint `fabrika app build` writes, with `fabrika/migrations.generated.ts`. Do not edit them.         |
| `fabrika.config.ts`                                          | The deploy surface: `defineApp({ id: 'example-app' })` and the SPA build as `pipeline.build`, the whole of it.      |
| `oblaka.ts`, `lopata.config.ts`                              | A local run of the proxy, the application with its Durable Object and bucket, and IAM over service bindings.        |
| `src/__tests__/app.test.ts`                                  | The endpoints behind the production proxy decision (`testKit`) on `@fabrika/db/testing-sqlite`, denials included.   |
| `src/__tests__/endpoint-access.test.ts`, `src/db/__tests__/` | The generated tests `fabrika db test-scaffold` writes; do not edit them.                                            |

The application runs in one Durable Object per environment, over its SQLite
([ADR-0065](../../docs/decisions/0065-an-application-on-cloudflare-runs-in-one-durable-object-per-environment.md)). The
`/api` endpoints answer from the caller's own grants (`member: true` for the caller's identity, `over` for the values it
may read in). The `/notes` endpoints write and read the `notes` table through `ctx.db`; a note may carry one file of
the `attachments` kind, stored in the environment's R2 bucket; the `review` job runs every minute on the object's
alarm and stamps `reviewed_at` on every note it has not reviewed yet.

## How it deploys

The deployer reads `fabrika.contract.ts` from the checkout with the static reader Control uses (`@fabrika/check`),
builds the proxy Worker from `contractProxyTable(artifact)` and binds the application Worker to it as `APP`
([ADR-0048](../../docs/decisions/0048-bind-cloudflare-delivery-to-the-recorded-commit.md)). It writes `FABRIKA_IAM_ISSUER`,
`FABRIKA_IAM_APP_ID` and `FABRIKA_CONTRACT_DIGEST` into the application Worker, the proxy secret and the job's workload
key as Worker secrets, and binds the `FABRIKA_APPLICATION` object, the `FABRIKA_FILES` bucket and the hourly repair
tick; `boot` refuses to start when the digest is not the contract it compiled. The config declares none of them, and
declaring one is refused. `defineApp` builds the application Worker `example-app` itself (the entry, no route, no
public URL, IAM at its application entrypoint). The deploy runs `pipeline.build` (`bun run build:web`), stages the
`site` mount's `dist/web` into `fabrika/assets` and binds it as `ASSETS`. The config declares no IAM schema: Control writes the approved
contract's, `schemaFromContract(artifact)` with `contract: true`, so IAM refuses every wildcard written for this
application.

After a change to the contract or the handlers:

```bash
bunx fabrika db codegen         # after a migration: rewrites src/db/schema.generated.ts
bunx fabrika db test-scaffold   # after a contract or table change: rewrites the generated tests
bun run build       # fabrika app build --provider=cloudflare: rewrites fabrika/entry.generated.ts and migrations.generated.ts
bun run check       # fabrika-check: the Cloudflare build does not run it yet
bun run typecheck
bun run test        # bun test --isolate: the generated endpoint access test boots the same application
```

`tsconfig.json` leaves out `fabrika.config.ts` and `oblaka.ts`: they import oblaka's raw TypeScript source, which does
not compile under this strict configuration.

## Run it locally (multi-worker lopata)

```bash
# from the repo root: generate the IAM config, then the proxy + app configs
cd packages/iam && bun run oblaka
cd ../../examples/app && bun run build:web && bun run oblaka

bun run dev          # lopata on http://127.0.0.1:18190
```

`oblaka.ts` takes the composition from the provider (`composeLocalApplication`), the code a deploy composes with: the
proxy Worker `example-app-proxy` over the contract's endpoint table, and the application Worker `example-app` with
the `FABRIKA_APPLICATION` object (class `FabrikaApplication`, a SQLite class migration), the `FABRIKA_FILES` bucket,
the hourly repair tick, `ASSETS` over the SPA, and a `FABRIKA_PROXY_SECRET` that each `bun run oblaka` draws anew
into the ignored `wrangler.jsonc`. Before it composes, `oblaka.ts` stages `dist/web` into the ignored `fabrika/assets`
with `stageLocalAssets`, the deploy's code, so a file the build's `.assetsignore` lists is not served there either. It writes the framework variables into the application Worker itself, because no deploy runs, and
expects IAM's issuer at `http://localhost:18191`. The application boots only with the `review` job's workload key, which a deploy writes:
locally, issue one with IAM's `workloads.issueKey` for `example-app@local` after the schema is reconciled, and put it
in `.dev.vars` as `FABRIKA_JOB_REVIEW_KEY`. The IAM Worker's D1 needs its migrations applied first.

This run does not serve yet: lopata does not apply wrangler's `define`, which carries the proxy manifest, so the proxy
answers 503 `proxy unavailable`; and the object's `IAM` binding check (`method()` in
`packages/app/src/cloudflare/bindings.ts`) tests the binding's methods with `in`, which a lopata service-binding stub
does not answer, so the application refuses to boot. See
[the Cloudflare Worker proxy witness](../../docs/reference/local-development.md#cloudflare-worker-proxy-witness).

## Managed Operations configuration

A Fabrika-managed deploy also writes `FABRIKA_OPERATIONS_DSN` and `FABRIKA_RELEASE`. Do not declare either name in
`fabrika.config.ts`; the provider refuses an application-authored collision. This example does not initialize a
browser SDK.
