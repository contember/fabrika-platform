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

| File                            | What it is                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/vocabulary.ts`             | The vocabulary: dimensions, actions, roles.                                                |
| `src/app-kit.ts`                | `defineApp(vocabulary)`: the kit, without tables.                                          |
| `src/schemas.ts`                | The output schemas.                                                                        |
| `src/access/endpoints.ts`       | The endpoints, each with its callers, access form and `.handle(…)`.                        |
| `src/access/logic.ts`           | The answer for a set of granted values: plain TypeScript.                                  |
| `fabrika.contract.ts`           | `app.contract(…)`: the `/api` mount and the health check.                                  |
| `src/app.ts`                    | `serve(contract, { database: null })`.                                                     |
| `fabrika/entry.generated.ts`    | The Worker entrypoint `fabrika app build` writes (`createContractWorker`). Do not edit it. |
| `fabrika.config.ts`             | The deploy surface: the application Worker and the IAM schema the contract compiles to.    |
| `oblaka.ts`, `lopata.config.ts` | A local run of the proxy, the application and IAM over service bindings.                   |
| `src/__tests__/app.test.ts`     | The endpoints behind the production proxy decision (`testKit`), denied callers included.   |

Cloudflare has no `@fabrika/db` yet, so this application has no tables (`defineApp(vocabulary)`, no `ctx.db`): each endpoint answers from the caller's own
grants (`member: true` for the caller's identity, `over` for the values it may read in) and reads no application data.
Files, forms, webhooks and jobs do not boot on Cloudflare.

## How it deploys

The deployer reads `fabrika.contract.ts` from the checkout with the static reader Control uses (`@fabrika/check`),
builds the proxy Worker from `contractProxyTable(artifact)` and binds the application Worker to it as `APP`
([ADR-0048](../../docs/decisions/0048-bind-cloudflare-delivery-to-the-recorded-commit.md)). It writes `FABRIKA_IAM_ISSUER`,
`FABRIKA_IAM_APP_ID` and `FABRIKA_CONTRACT_DIGEST` into the application Worker; `boot` refuses to start when the digest
is not the contract it compiled. The config declares none of them, and declaring one is refused. The IAM schema is
`schemaFromContract(artifact)` with `contract: true`, so IAM refuses every wildcard written for this application.

After a change to the contract or the handlers:

```bash
bun run build       # fabrika app build --provider=cloudflare: rewrites fabrika/entry.generated.ts
bun run check       # fabrika-check: the Cloudflare build does not run it yet
bun run typecheck
bun test
```

`tsconfig.json` leaves out `fabrika.config.ts` and `oblaka.ts`: they import oblaka's raw TypeScript source, which does
not compile under this strict configuration.

## Run it locally (multi-worker lopata)

```bash
# from the repo root: generate the IAM config, then the proxy + app configs
cd packages/iam && bun run oblaka
cd ../../examples/app && bun run oblaka

bun run dev          # lopata on http://127.0.0.1:18190

curl -i http://127.0.0.1:18190/healthz
curl -i -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:18190/api/me
```

The first request reaches the application without a credential. The second has no session, so the proxy answers the
login challenge and the application never sees it. The local composition writes the framework variables into the
application Worker itself, because no deploy runs; it expects IAM at `http://localhost:18191`.

## Managed Operations configuration

A Fabrika-managed deploy also writes `FABRIKA_OPERATIONS_DSN` and `FABRIKA_RELEASE`. Do not declare either name in
`fabrika.config.ts`; the provider refuses an application-authored collision. This example does not initialize a
browser SDK.
