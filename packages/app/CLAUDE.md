# @fabrika/app

The first-party server framework for Fabrika applications. It provides Fetch-based
HTTP routing, middleware, typed RPC, structural errors, and a typed browser client.

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
- Proxy gates decide whether a request reaches the app. `.require()` performs the
  object-level permission check the proxy cannot resolve.
- Error handling is structural. Never rely on cross-package `instanceof`.
- The RPC wire protocol is stable: `{ method, input }` or `{ batch }` requests and
  `{ result }`, `{ error }`, or `{ batch }` responses.
- `defineApp()` owns request behavior. Runtime adapters only supply lifecycle
  capabilities and must not fork routing or RPC semantics.
- The package root is runtime-neutral. Provider lifecycle APIs are exported only
  from `@fabrika/app/cloudflare` and `@fabrika/app/bun`.
- The Bun adapter tracks every `waitUntil()` task. Shutdown drains them before
  application resources close.
- Conformance tests create fresh requests and environment state for every runtime.
- Validators implement Standard Schema. Do not add a required validation library.
- Never log credentials, secret values, or request headers.
- No casts, `any`, `@ts-ignore`, or `@ts-expect-error`.
