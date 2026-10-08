# @fabrika/app

The first-party server framework for Fabrika applications. It provides Fetch-based
HTTP routing, middleware, typed RPC, structural errors, and a typed browser client.

[ADR-0012](../../docs/decisions/0012-fabrika-app-runtime.md) makes the contract the
target: an application declares `fabrika.contract.ts` and serves it through
`implement`. That surface is the A-M1 work of the
[implementation plan](../../docs/ideas/app-framework-implementation-plan.md) and is
not built yet. Today the package exposes only `defineApp()`, which stays for the
installation's own services (IAM, Control, Operations).

## Commands

```bash
bun run typecheck
bun test
bun test src/__tests__/rpc.test.ts
```

## Structure

```text
src/
  index.ts            public surface
  app.ts              runtime-neutral request pipeline
  cloudflare.ts       Worker module adapter and lifecycle types
  bun.ts              Bun handler, background-task tracking, graceful drain
  testing.ts          test-runner-neutral cross-runtime conformance helper
  router.ts           typed HTTP and RPC route matching
  middleware.ts       middleware runner over @fabrika/auth's canonical contract
  errors.ts           structural HTTP error mapping
  client.ts           typed browser RPC client
  rpc/                procedure builder, types, and dispatcher
```

## Invariants

- `AuthContext`, `Scope`, and `Middleware` come from `@fabrika/auth`. Do not
  duplicate their shapes.
- Proxy gates decide whether a request reaches the app; the proxy is the only gate
  evaluator. `.require()` and the contract's requirement check are **authorization**
  in the vocabulary of `docs/reference/overview.md`; the same-origin check of
  `implement` is **admission**. Neither evaluates a gate rule. Never add one here.
- `defineApp()` answers 400 for a non-canonical raw path (`isCanonicalPath` from
  `@fabrika/auth-core`) before context, middleware or routing run. Middleware that
  reads the path therefore sees what the router and the proxy's gates saw.
- The router splits paths literally: a trailing `/` is significant, so `/a/` and
  `/a` are different routes, and `/x/*rest` needs the `/` (it matches `/x/`, not
  `/x`). Never drop empty segments again — the gate matcher compares the raw path,
  and the two must agree (`provider-cloudflare`'s `proxy-to-router.test.ts`).
- Error handling is structural. Never rely on cross-package `instanceof`.
- The RPC wire protocol is `{ method, input }` requests and `{ result }` or
  `{ error }` responses. `{ batch }` is removed (A3): no client sends it. Until A3
  lands the dispatcher still accepts it; never add a caller that depends on it.
- Browser-safe procedure contracts may be implemented with `RpcRouterFor` and
  consumed with `createRpcClient`; they must not import a server runtime.
- `defineApp()` owns request behavior. Runtime adapters only supply lifecycle
  capabilities and must not fork routing or RPC semantics.
- Applications get no middleware, raw routes, `authenticate` or custom server.
  `implement` has no slot for them, and `defineApp()` is for the installation's own
  services only.
- The package root is runtime-neutral. Provider lifecycle APIs are exported only
  from `@fabrika/app/cloudflare` and `@fabrika/app/bun`.
- The Bun adapter tracks every `waitUntil()` task. Shutdown drains them before
  application resources close.
- Conformance tests create fresh requests and environment state for every runtime.
- Contract schemas are zod 4 (`zod/v4`), restricted to a serializable subset:
  strict objects, no transforms, no `passthrough` (ADR-0012). `defineApp()`
  procedures and validation inside a handler stay library-neutral (Standard Schema).
  Zod is a dev dependency today.
- Never log credentials, secret values, or request headers.
- No casts, `any`, `@ts-ignore`, or `@ts-expect-error`.

## Contract framework (target of A-M1, not built yet)

- `@fabrika/app/contract` is browser-safe: `defineContract` and `compileContract`.
  The contract is a literal; the checker enforces it.
- The router and the generated gates come from one endpoint table.
  `gatesFromContract` and `schemaFromContract` feed today's proxy and IAM through
  `fabrika.config.ts`. Dispatch uses `planEndpoint` from `@fabrika/auth-core`.
- `boot` is called only by the generated entrypoint. Per request: canonical path →
  `planEndpoint` → token verification → caller kind → requirement → admission →
  strict input → access form → handler → output projection → response headers.
- One path per procedure: `POST <mount>/<procedure>`.
- Later (A12, A13): membership, scopes and share links are requests to IAM through
  `@fabrika/auth`. The framework writes no grant and mints no credential.
