# @fabrika/app

The first-party server framework for Fabrika applications. It provides Fetch-based
HTTP routing, middleware, typed RPC, structural errors, and a typed browser client.

[ADR-0012](../../docs/decisions/0012-fabrika-app-runtime.md) makes the contract the
target: an application declares `fabrika.contract.ts` and serves it through
`implement` (`@fabrika/app/implement`), booted by the generated entrypoint that
`fabrika app build` writes (`@fabrika/app/build`). `defineApp()` stays for the
installation's own services (IAM, Control, Operations). The remaining surface is
the A-M1 work of the
[implementation plan](../../docs/ideas/app-framework-implementation-plan.md).

## Commands

```bash
bun run typecheck
bun test
bun test src/__tests__/rpc.test.ts
bun test src/__tests__/contract-types.test.ts   # the contract mistakes, compiled by tsc
bun test src/__tests__/implement-types.test.ts  # the handler mistakes, compiled by tsc
bun test src/__tests__/implement.test.ts        # boot's request pipeline, with real tokens
bun test src/__tests__/scoped-database.test.ts  # implement over @fabrika/db (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/test-kit.test.ts         # the test kit: the proxy decision in front of boot
bun test src/__tests__/client-types.test.ts     # the client and test-kit mistakes, compiled by tsc
```

## Structure

```text
src/
  index.ts            public surface
  app.ts              runtime-neutral request pipeline
  cloudflare.ts       Worker module adapter and lifecycle types; createContractWorker
  bun.ts              Bun handler, background-task tracking, graceful drain; serveContract
  build.ts            @fabrika/app/build — the generated entrypoint fabrika app build writes
  router.ts           typed HTTP and RPC route matching
  middleware.ts       middleware runner over @fabrika/auth's canonical contract
  errors.ts           structural HTTP error mapping
  rpc/                procedure builder, types, and dispatcher
  client/             @fabrika/app/client — browser-safe
    contract.ts       createClient: the typed client of a contract mount
    rpc.ts            createRpcClient: the defineApp() RPC client (exported from the root)
    transport.ts      RpcError, the login bounce, reading the { result } / { error } envelope
  testing/            @fabrika/app/testing — no test-runner dependency
    kit.ts            testKit: boot behind a stand-in proxy and IAM
    proxy.ts          ProxyDecision, the seam, and endpointDecision, its default
    caller.ts         test callers and their grants
    conformance.ts    the cross-runtime conformance helper of defineApp() services
  contract/           @fabrika/app/contract — browser-safe
    define.ts         defineContract, the c.* kit and every type an agent meets
    declaration.ts    the contract as plain data, generic over its schema type
    schema-shape.ts   a zod 4 schema of the subset → SchemaShape
    compile.ts        compileContract / describeContract
    build.ts          buildArtifact: every check, default and generated endpoint
    defaults.ts       the defaults and generated paths, in one place
    artifact-schema.ts  parseContractArtifact, the zod parser of the artifact
    platform.ts       gatesFromContract, schemaFromContract: today's proxy and IAM
  implement/          @fabrika/app/implement — serving a contract (node:async_hooks)
    implement.ts      implement, ContractDatabase, ContractImplementation
    types.ts          the handler types: HandlersOf, ExactHandlers, AccessContext
    boot.ts           boot: framework variables, refusals, handler binding
    dispatch.ts       ContractRuntime: the per-request pipeline and the error envelope
    capability.ts     Ref, Within, requestCapabilities (the CapabilityAuthority)
    principal.ts      caller kinds and principals from a verified token
    headers.ts        the response header policy
    project.ts        output projection over the output's zod schema
    environment.ts    captureEnvironment: the FABRIKA_* variables out of the process
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
- The `defineApp()` RPC wire protocol is `{ method, input }` requests and
  `{ result }` or `{ error }` responses. `{ batch }` is removed: one request is one
  call, and a `{ batch }` body is a 400.
- Browser-safe procedure contracts may be implemented with `RpcRouterFor` and
  consumed with `createRpcClient`; they must not import a server runtime.
- `defineApp()` owns request behavior. Runtime adapters only supply lifecycle
  capabilities and must not fork routing or RPC semantics.
- Applications get no middleware, raw routes, `authenticate` or custom server.
  `implement` has no slot for them, and `defineApp()` is for the installation's own
  services only. `defineApp()` is never a way to serve a contract.
- The package root is runtime-neutral. Provider lifecycle APIs are exported only
  from `@fabrika/app/cloudflare` and `@fabrika/app/bun`. `@fabrika/app/implement`
  imports `node:async_hooks`, so neither the root nor `/contract` may import it:
  the SPA imports both.
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

- `@fabrika/app/contract` is browser-safe: it imports `@fabrika/auth-core`,
  `@fabrika/db/tables` and `zod/v4` only. The SPA imports `fabrika.contract.ts` for
  the typed client, so never import a server runtime, `@fabrika/db`'s root or a
  Node/Bun API there.
- `defineContract(vocabulary, (c) => surface)` builds plain data and validates
  nothing at runtime. The surface holds mounts by name plus the sections
  `files`, `jobs`, `exports`, `imports`, `csp` (`SURFACE_SECTIONS`); a mount may
  not take one of those names.
- **`buildArtifact` is the one normalization.** `compileContract(contract, tables)`
  = `describeContract` (zod → `SchemaShape`) + `buildArtifact`. The static reader
  (B1) must produce the same `ContractDeclaration<SchemaShape>` from source and
  call `buildArtifact`, never a copy. Every default and generated path is in
  `defaults.ts`; add new ones there, nowhere else.
- **A builder never spreads its options.** Each copies only its option fields
  (`BUILDER_FIELDS`) and records every other key in `unknownOptions`, which
  `buildArtifact` refuses; the types make a field the builder sets (`kind`,
  `path`, `prefix`, `schedule`, …) `never` in its options. A spread would let a
  shared options const turn a webhook into a form.
- `buildArtifact` returns the canonical artifact (`canonicalizeArtifact` from
  `@fabrika/auth-core`, see its CLAUDE.md) after parsing it with
  `contractArtifactSchema`. A parse failure there is a check missing from
  `build.ts` or `schema-shape.ts`; add the check, never loosen the parser.
- **The schema subset is `@fabrika/check`'s.** `schema-shape.test.ts` covers each
  factory and method `packages/check/CLAUDE.md` lists, and `contract-check.test.ts`
  runs the checker over the fixtures. Change the checker, `schema-shape.ts` and
  `SchemaShape` together. A default becomes `optional`, a discriminated union a
  `union` (so a discriminator may not have a default); `.describe()` adds nothing.
  The shape keeps a string's checks unordered, so a chain whose order matters is
  refused: two formats, `url` with any other check, an affix with a format.
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
- `tables` is what `defineTables` returned or the artifact form of each table
  policy (`TablePolicyArtifact`); `@fabrika/db/tables`' `tablePolicies` converts
  the one into the other, so both paths share `@fabrika/db`'s one policy parse.
- Generated endpoints: a procedure is `POST <prefix>/<dotted.path>`; a link mount
  serves `GET <prefix>/*` (anonymous) and its procedures at
  `POST <prefix>/api/<name>`; file collections serve under `/api/files.<name>…`;
  exports under `/__fabrika/connect/<export>.v<version>.<procedure>`; a webhook
  appends `/:bindingId`. No authored path may lie under `/__fabrika`.
- **`gatesFromContract` and `schemaFromContract` (`platform.ts`) read only the
  artifact**, so the static reader's artifact compiles to the same gates and schema.
  The gates come from the same endpoint table as the router: one rule per path and
  kind in `orderBySpecificity` order, `service` before `human` before `public`, and a
  path also admits what the other method can select through it (`selectableRows`).
  Never hand-write gates for a contract application, and never emit a rule for a
  path without an endpoint. `platform.test.ts` checks every fixture contract against
  `planEndpoint` on the auth-core probe paths. `schemaFromContract` emits every
  field of A12's `AppSchema`, and its output must parse unchanged with
  `@fabrika/auth`'s `appSchemaSchema`, which resolves every name it carries.
- **What IAM would refuse is refused at the source, not in the generator.** `buildArtifact`
  and `contractArtifactSchema` both refuse a `*` in any action name and a role named after
  `BUILTIN_ROLE_KEYS`; `buildArtifact` and the `CreatableDimension` type refuse `creates`
  for a dimension with `in`, because IAM's `createScope` makes only top-level values.
- Later (A12, A13): membership, scopes and share links are requests to IAM through
  `@fabrika/auth`. The framework writes no grant and mints no credential.

## Serving a contract

- **`boot` dispatches only through `planEndpoint`** over the compiled artifact's
  table. There is no second router: an unknown procedure under an RPC prefix is 404
  and never the SPA, and a non-canonical path is 400.
- **Per request, in this order** (ADR-0012 §5): canonical path → `planEndpoint` →
  token verification with `@fabrika/jwks`'s shared verifier → caller kind →
  requirement (`satisfies`) → admission → strict input → access form → remove the
  `from` field → handler → output projection → the header policy. Caller kind,
  requirement and access form are authorization; same-origin and content type are
  admission. Neither evaluates a gate; never reorder them so that admission or input
  parsing answers a caller the requirement refused.
- **Caller kinds** come from the token (`presentedBy`): `ptype: 'user'` is `human`,
  `ptype: 'service'` is `machine`, an anonymous token (a share link) is `link`. No
  token is an `app:<id>` caller yet, and an OAuth resource token is no caller.
- **Admission** treats a request without an `Authorization` header as a session
  request: when it is not a `GET` it needs `Sec-Fetch-Site: same-origin`. A
  cross-site page cannot add that header without a preflight, and the application
  answers none. Every RPC request needs `Content-Type: application/json`.
- **`Ref` and `Within` are bound to their request** with `AsyncLocalStorage`.
  `requestCapabilities.resolve` refuses a value the framework did not mint, one whose
  request has ended, and one from another live request; `@fabrika/db` checks kind,
  dimension and action itself. Both classes keep their grant in private fields and
  need a module-private token to construct; never export that token or the mint
  functions from `implement/index.ts`.
- **A capability's facts are frozen at mint, and every resolution is a fresh copy.**
  The chain is stored as frozen pairs, copied into a new `Map` through built-ins
  captured at load, and `resolve` returns a new frozen grant each time. Whoever
  changes a returned chain changes only their copy; the data layer's next
  resolution still carries the chain that was checked. Never hand out the stored
  chain itself (`capability-chain.test.ts`).
- **`@fabrika/db` is bound by `boot`, once.** An application passes `scoped(tables)`
  as `implement({ database })`. `boot` binds only an object `scoped` created
  (`@fabrika/db/framework`'s `bindScopedDatabase`), with the adapter's connection and
  `requestCapabilities`, and keeps the locator the bind answers for `on` and `in`. The
  application never receives the connection or the locator; a copy or a wrapper of
  the layer does not boot. A `ContractDatabase` (`tables` and `locate`) of the
  application's own is served as it is and gets no connection.
  `serveContract` imports `@fabrika/db` before the application (it captures its
  built-ins and freezes the Kysely compiler at load) and opens `Database.postgres` on
  `FABRIKA_APP_DATABASE_URL` and `app_<FABRIKA_APP_ID>`. No connection (Cloudflare)
  or a layer bound before boot is a `BootError`. `boot.ts` imports only
  `@fabrika/db/framework` at runtime (browser-safe), because the Worker adapter
  imports `boot`.
- **`on` needs a table that owns its dimension** (`ContractDatabase.tables`); `boot`
  refuses the contract otherwise. `on` checks the action on the object or any
  container of its chain and answers 404 for both "missing" and "not yours"; `in`
  checks the action on the value itself, then that it exists when a table owns it.
- **Output is projected, then validated:** `project` walks the output's zod schema
  and keeps the fields it declares; a union takes the first branch, in order, whose
  schema accepts the value reduced to it. The strict output schema then validates
  the result. No accepting branch, or a refused value, is a 500.
- **One error envelope**, `{ error: { type, message, issues? } }`. A client error
  (4xx) keeps its message and issues; `@fabrika/db`'s `NotFoundError` and
  `ConflictError` are read by `name` (404, 409). Every 5xx and every refused
  capability answers the fixed `Internal error` (or `Service unavailable` for 503)
  with no metadata, because a message may quote a connection string. The server log
  gets one line: a framework-authored message (`ServerFault`,
  `CapabilityRefusedError`) or only the error's name, never the error object.
- **`boot` refuses to start rather than answer nothing**: a link, form or webhook
  mount, files, jobs, exports, imports, `creates`, an SPA without an asset server, a
  handler outside the contract, a missing handler. Each refusal lifts when its work
  unit ships the runtime.
- **The framework's variables are every `FABRIKA_*` name, and they leave the process
  before any application module loads.** The runtime adapter calls
  `captureEnvironment`, which keeps them in a frozen record and deletes them from
  `process.env` and `Bun.env`; only then does the generated entrypoint's `import()`
  load `src/app.ts`, so a dependency that copies the environment at module load
  copies none of them. Never import the application statically from the entrypoint.
  `boot` reads `FABRIKA_IAM_APP_ID` — the token audience `<app>@<env>`, whose
  application part must equal `contract.app` — `FABRIKA_IAM_ISSUER` and
  `FABRIKA_OPERATIONS_DSN` (its origin joins `connect-src`), and hands `deps` the
  rest. `FABRIKA_APP_ID` is the Operations ingest coordinate and the application's
  database schema (`app_<id>`), never an audience. The
  Worker adapter also keeps the `IAM` and `ASSETS` bindings from `deps`.
- **`handlers` is a function of what `deps` returned.** TypeScript cannot infer
  `deps`' type into `ctx` through the contract's conditional handler types, so a
  handler reaches its dependencies through that closure, not `ctx.deps`.
- The handler type witnesses live in `src/__tests__/implement-mistakes/` (the
  parser spike's 05–10), compiled by `implement-types.test.ts` like the contract
  mistakes. `implement-scale.test.ts` keeps 200 handlers under the same budget as
  `contract-scale.test.ts`; both generate their source in `scale-fixture.ts`.
- The header policy (`headers.ts`) is ADR-0022's; B4 sets the same policy at the
  proxy and decides the final `Permissions-Policy`. Keep the two equal.

## The typed client and the test kit

- **`createClient` builds its tree from the contract value**, never a `Proxy`: only
  declared procedures exist, and each path comes from `joinPath` and
  `LINK_API_SEGMENT` in `contract/defaults.ts`, the code that gives the artifact its
  paths. Never compute a procedure path anywhere else.
- **An answer is parsed with the procedure's output schema** before the caller sees
  it. The tree's type is tied to the value by one structural check (`coversTree`),
  not a cast.
- **A key client sends no cookie** (`credentials: 'omit'`): a request presents one
  credential. A link mount's client requires its key. In a browser (`location` set) a
  client with a key refuses a `baseUrl` of another origin; a script names its target.
- **The transport builds the request inside its guard** (`exchange` takes a builder):
  an input that does not serialize rejects with `RpcError`, it never throws.
- **The kit runs the real `boot` and dispatcher**; only the proxy and IAM are stand-ins.
  Its tokens are signed with a generated key and verified by the application's own
  verifier, so a test cannot reach a handler the production pipeline would refuse.
- **`ProxyDecision` is a test double of the enforcement point, never one.** It runs
  only in front of a kit's in-process application. `endpointDecision` follows
  ADR-0022's endpoint steps with `planEndpoint` and `satisfies`; it is not a gate
  evaluator. A decision over generated gates plugs in through `options.proxy`, and the
  proxy's own decision function replaces both once the proxy decides per endpoint (B2).
- **The kit answers only its own origin.** `kit.fetch` refuses another host, and
  `kit.browser` reads the effective request (a `Request` input's headers, `init`'s
  `credentials: 'omit'`) before it adds the session. A token above
  `MAX_ACCESS_TOKEN_BYTES` (`@fabrika/auth-core`) is 403, as IAM and the proxy answer.
- **Only test files load the kit.** `@fabrika/check`'s `test-only-import` refuses
  `@fabrika/app/testing`, and any test module, in a non-test file.
- **A forwarded request is stripped like the proxy strips it**: every `X-Fabrika-*`
  header, `UNTRUSTED_FORWARD_HEADERS` and the `__Host-px_*` cookies; an anonymous
  endpoint also loses `Authorization`.
- The client and test-kit type witnesses live in `src/__tests__/client-mistakes/`,
  compiled by `client-types.test.ts` like the contract mistakes.
