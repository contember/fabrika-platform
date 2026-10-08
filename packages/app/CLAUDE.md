# @fabrika/app

The first-party server framework for Fabrika applications. It provides Fetch-based
HTTP routing, middleware, typed RPC, structural errors, and a typed browser client.

[ADR-0012](../../docs/decisions/0012-fabrika-app-runtime.md) makes the contract the
target: an application declares `fabrika.contract.ts` and serves it through
`implement`. That surface is the A-M1 work of the
[implementation plan](../../docs/ideas/app-framework-implementation-plan.md).
`@fabrika/app/contract` (`defineContract`, `compileContract`) is built; `implement`,
`boot` and dispatch (A3) are not. Until then the package serves only through
`defineApp()`, which stays for the installation's own services (IAM, Control,
Operations).

## Commands

```bash
bun run typecheck
bun test
bun test src/__tests__/rpc.test.ts
bun test src/__tests__/contract-types.test.ts   # the contract mistakes, compiled by tsc
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
  contract/           @fabrika/app/contract — browser-safe
    define.ts         defineContract, the c.* kit and every type an agent meets
    declaration.ts    the contract as plain data, generic over its schema type
    schema-shape.ts   a zod 4 schema of the subset → SchemaShape
    compile.ts        compileContract / describeContract
    build.ts          buildArtifact: every check, default and generated endpoint
    defaults.ts       the defaults and generated paths, in one place
    artifact-schema.ts  parseContractArtifact, the zod parser of the artifact
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
  `zod` is a peer dependency, so an application and the framework share one copy.
- Never log credentials, secret values, or request headers.
- No casts, `any`, `@ts-ignore`, or `@ts-expect-error`.

## Contract framework

- `@fabrika/app/contract` is browser-safe: it imports `@fabrika/auth-core` and
  `zod/v4` only. The SPA imports `fabrika.contract.ts` for the typed client, so
  never import a server runtime, `@fabrika/db` or a Node/Bun API there.
- `defineContract(vocabulary, (c) => surface)` builds plain data and validates
  nothing at runtime. The surface holds mounts by name plus the sections
  `files`, `jobs`, `exports`, `imports`, `csp` (`SURFACE_SECTIONS`); a mount may
  not take one of those names.
- **`buildArtifact` is the one normalization.** `compileContract(contract, tables)`
  = `describeContract` (zod → `SchemaShape`) + `buildArtifact`. The static reader
  (B1) must produce the same `ContractDeclaration<SchemaShape>` from source and
  call `buildArtifact`, never a copy. Every default and generated path is in
  `defaults.ts`; add new ones there, nowhere else.
- **The schema subset is `@fabrika/check`'s.** `schema-shape.test.ts` covers each
  factory and method `packages/check/CLAUDE.md` lists, and `contract-check.test.ts`
  runs the checker over the fixtures. Change the checker, `schema-shape.ts` and
  `SchemaShape` together. A default becomes `optional`, a discriminated union a
  `union`; `.describe()` adds nothing.
- zod 4's types cannot tell `z.object` from `z.strictObject` (`$strip` and
  `$strict` are the same type), so the types refuse only loose objects;
  `compileContract` and the checker refuse `z.object`. Compose schemas through
  factories (`z.nullable(Note)`, `z.array(Note)`): the checker refuses a method
  call on a schema const.
- The type witnesses live in `src/__tests__/contract-mistakes/`, excluded from the
  package typecheck and compiled by `contract-types.test.ts`, which asserts the
  diagnostic text on the line after each `// mistake:` marker. A new rule the
  types enforce gets a fixture there. `contract-scale.test.ts` keeps 200
  procedures under its instantiation budget.
- `tables` is the artifact form of each table policy (`TablePolicyArtifact`).
  `@fabrika/db`'s `Tables` keeps its policies private and imports `bun`, so A8b
  exposes them as data; until then the caller passes artifacts.
- Generated endpoints: a procedure is `POST <prefix>/<dotted.path>`; a link mount
  serves `GET <prefix>/*` (anonymous) and its procedures at
  `POST <prefix>/api/<name>`; file collections serve under `/api/files.<name>…`;
  exports under `/__fabrika/connect/<export>.v<version>.<procedure>`; a webhook
  appends `/:bindingId`. No authored path may lie under `/__fabrika`.
- Still to come: `implement`, `boot` and dispatch (A3), `gatesFromContract` and
  `schemaFromContract` (A4), the typed client (A5). The router and the generated
  gates both come from the artifact's one endpoint table; dispatch uses
  `planEndpoint`. `boot` is called only by the generated entrypoint. Per request:
  canonical path → `planEndpoint` → token verification → caller kind →
  requirement → admission → strict input → access form → handler → output
  projection → response headers.
- Later (A12, A13): membership, scopes and share links are requests to IAM through
  `@fabrika/auth`. The framework writes no grant and mints no credential.
