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
bun test src/__tests__/locators.test.ts         # on, in and over through nested containment (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/files.test.ts            # c.files (needs FABRIKA_TEST_POSTGRES_URL; FABRIKA_TEST_S3_* adds a real bucket)
bun test src/__tests__/multi-tenant.test.ts     # creates, ctx.members, share links, forms, webhooks (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/jobs.test.ts             # the job runner: leases, fenced writes, retries (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/job-types.test.ts        # the job handler mistakes, compiled by tsc
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
    share.ts          shareKey: the key the share SPA's bootstrap kept
    rpc.ts            createRpcClient: the defineApp() RPC client (exported from the root)
    transport.ts      RpcError, the login bounce, reading the { result } / { error } envelope
  testing/            @fabrika/app/testing — no test-runner dependency
    kit.ts            testKit: boot behind the production proxy decision and a stand-in IAM
    proxy.ts          endpointProxy: proxy-core's verify service over contractProxyTable
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
    platform.ts       schemaFromContract: the IAM vocabulary a deploy reconciles
  implement/          @fabrika/app/implement — serving a contract (node:async_hooks)
    implement.ts      implement, ContractDatabase, ContractImplementation
    types.ts          the handler types: HandlersOf, ExactHandlers, AccessContext
    boot.ts           boot: framework variables, refusals, handler binding
    dispatch.ts       ContractRuntime: the per-request pipeline and the error envelope
    capability.ts     Ref, Within, requestCapabilities (the CapabilityAuthority)
    membership.ts     creates, ctx.members and ctx.links: requests to IAM through IamMembership
    anonymous.ts      the bounded body read, the form rate limit, the share bootstrap, GitHub's signature
    webhook.ts        the generated binding endpoints and a delivery's principal
    faults.ts         ServerFault: a framework failure whose message only the log sees
    principal.ts      caller kinds and principals from a verified token
    headers.ts        the response header policy
    project.ts        output projection over the output's zod schema
    environment.ts    captureEnvironment: the FABRIKA_* variables out of the process
  files/              c.files: served by implement, never imported by an application
    collections.ts    the upload, download and remove endpoints, the file locator, the sweep
    sniff.ts          the declared type checked against the first bytes
    treatment.ts      FileDownload and the file treatment of ADR-0022
  jobs/               c.cron at runtime; bound by boot, run by `fabrika job run <name>` (runContractJob)
    types.ts          JobContext, JobHandler, JobHandlersOf: handlers.jobs.<name>
    runner.ts         bindJobs, the run: lease, attempts, timeout, retries, reports
    schedule.ts       five-field cron in UTC: the due minutes and the period
    report.ts         failures and missed runs as error events to Operations' ingest
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
- **A contract application has no gates.** The proxy reads its endpoint table,
  `contractProxyTable(artifact)` from `@fabrika/proxy-core/manifest`, and both
  providers refuse a contract application whose proxy carries gates (ADR-0022 rule 3).
- **`schemaFromContract` (`platform.ts`) reads only the artifact**, so the static
  reader's artifact compiles to the same schema. It emits every
  field of A12's `AppSchema`, and its output must parse unchanged with
  `@fabrika/auth`'s `appSchemaSchema`, which resolves every name it carries.
- **What IAM would refuse is refused at the source, not in the generator.** `buildArtifact`
  and `contractArtifactSchema` both refuse a `*` in any action name and a role named after
  `BUILTIN_ROLE_KEYS`; `buildArtifact` and the `CreatableDimension` type refuse `creates`
  for a dimension with `in`, because IAM's `createScope` makes only top-level values.
- Membership, scopes and share links are requests to IAM through `@fabrika/auth`'s
  `IamMembership`. The framework writes no grant and mints no credential.
- A webhook bound to a dimension generates `POST /api/webhooks.<name>.bind` and `.unbind`
  (`WEBHOOKS_PREFIX`), for a holder of that dimension's `members.manage`; their shapes
  (`WEBHOOK_BIND_*` in `build.ts`) and the zod schemas `implement` parses with
  (`webhook.ts`) must describe each other (`membership-shapes.test.ts`).

## Serving a contract

- **`boot` dispatches only through `planEndpoint`** over the compiled artifact's
  table. There is no second router: an unknown procedure under an RPC prefix is 404
  and never the SPA, and a non-canonical path is 400.
- **The proxy secret comes first** (ADR-0022 rule 5). When `FABRIKA_PROXY_SECRET` is set, a request
  without `X-Fabrika-Proxy-Secret` equal to it is a 403 before any other answer — also for an unknown or
  non-canonical path — and only a `health` endpoint is served without it. The 32-byte SHA-256 digests
  are compared with `node:crypto`'s `timingSafeEqual`, never the secrets and never with `===`. `serveContract` passes `requireProxySecret`, so on Zerops the application does not
  boot without one (or with one under 32 characters); the Worker adapter and the test kit set none.
- **Per request, in this order** (ADR-0012 §5): proxy secret → canonical path → `planEndpoint` →
  the proxy's endpoint (`X-Fabrika-Endpoint`) → token verification with `@fabrika/jwks`'s shared verifier → caller kind →
  requirement (`satisfies`) → admission → strict input → access form → remove the
  `from` field → handler → output projection → the header policy. Caller kind,
  requirement and access form are authorization; same-origin and content type are
  admission. Neither evaluates a gate; never reorder them so that admission or input
  parsing answers a caller the requirement refused.
- **The proxy names the endpoint, and the application agrees or answers 503**
  (ADR-0022 rule 5). `X-Fabrika-Endpoint: <id>@<digest>` must name the endpoint
  `planEndpoint` selected, with this version's `requirementDigest` of its row; a
  missing, malformed or different header is a 503 before the token is read. Only a
  `health` endpoint may arrive without it, because the platform's liveness probe dials
  the application directly. Tests reach the runtime through the harness's `bootApp`,
  which adds the header the way the proxy does.
- **Caller kinds** come from the token through `@fabrika/auth-core`'s `callerOf`, the
  mapping the proxy applies too (`presentedBy` only adds the principal): `ptype:
  'user'` is `human`, `ptype: 'service'` is `machine`, an anonymous token (a share
  link) is `link`. No token is an `app:<id>` caller yet, and an OAuth resource token
  is no caller. Never map a token to a caller kind anywhere else.
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
- **`on` needs a table that owns its dimension** (`ContractDatabase.tables`), and every
  access form needs a table for each dimension on its containment path that lies in
  another; `boot` refuses the contract otherwise, because a grant on that container
  would reach nothing. The chain is read per request (`locate`), never cached, so a
  moved object's next `Ref` carries its new chain. `on` checks the action on the
  object or any container of its chain and answers 404 for both "missing" and "not
  yours". `in` does the same check but answers 403 when not held; it reads the
  database only when the caller holds the action on the value or in a container
  dimension, and a missing scope is 404 only to a caller holding the value itself.
  `over` reads nothing: its `Within` carries the direct values and, separately, the
  container grants (`{ dimension, values }` per container on the chain), and the data
  layer matches the containers against each row's chain columns in the same statement.
  Never expand a container grant into values: a scope moved out after the check would
  stay reachable. A `Within` over `MAX_WITHIN_VALUES` values in total is refused at mint
  (`CapabilityLimitError`: 403 to the caller, one log line).
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
- **`boot` refuses to start rather than answer nothing**: a file collection with `link: true`, exports, imports,
  a webhook bound to `app`, an SPA or a link mount without an asset server, a link mount
  whose dimension no table owns, a form or webhook without a `scoped(tables)` layer, a
  form field that is not a column of its inbox, a job that cannot run (see Jobs), an endpoint that asks IAM with no
  membership transport (`BootOptions.membership`), a handler outside the contract, a
  missing handler, an access form whose containment no table locates. Each refusal
  lifts when its work unit ships the runtime.
- **The framework asks IAM; IAM decides** (`membership.ts`). Every request carries the
  verified token, the proxy's `X-Request-Id` (a delegation grant is bound to it) and the
  proxy's `X-Fabrika-Delegation`; `creates` without one is 503 and IAM is not asked.
  `ctx.members` exists only where the action is the dimension's `members.manage`, and
  `ctx.links` only where the `Ref`'s action is a link mount's `issuedBy` for its
  dimension: the types (`ContractContext`) and `facilitiesOf` in `boot.ts` decide the
  same, so change them together. A `Ref` passed to IAM must be this request's, for the
  endpoint's own dimension and action. A workload (a webhook) gets neither.
- **A link procedure re-reads the object's chain on every request** and answers 404 when
  it differs from the chain the key was issued for, so a link stops working once its
  object moves. It admits only a key of its own mount.
- **Revocation takes effect within the token lifetime** (ADR-0022 rule 6, plan D12): a
  removed member or revoked link keeps access until its cached token expires, at most
  300 s. The framework checks the token, not IAM, per request; never add an IAM call per
  request to close that window.
- **The share SPA's bootstrap is the document's first script.** `withBootstrap` inserts
  `<script src="<prefix>/__fabrika-share.js">` right after `<head>`, so it runs before
  every module and every telemetry script; it removes the fragment and keeps the key in a
  closure (`shareKey()`). Never serve the key anywhere else, and never read
  `location.hash` in application code.
- **The anonymous kinds read no token.** A form appends its declared fields to its inbox
  and answers a constant; it runs no handler and reads nothing. Its body limit is enforced
  while reading (`readBoundedBody`, 413), because the proxy never sees a body; its rate
  limit is per form per instance (`FORM_RATE_LIMIT`).
- **A webhook delivery is checked in a fixed order**: binding (404), signature over the
  raw body with that binding's secret (401), account (403), input after dropping every
  undeclared field (400, `project` then the strict schema), delivery key. Never verify
  the signature after parsing.
- **Replay protection keys on authenticated content only**: the delivery key is
  `sha256(bindingId ‖ raw body)`, kept per binding for `WEBHOOK_REPLAY_RETENTION_MS`
  (30 days). `X-GitHub-Delivery` is unsigned: it names the delivery in the log and decides
  nothing. A redelivery of one event therefore has the same key and is ignored.
- **A webhook handler is at-least-once.** The key is recorded before the handler runs and
  forgotten when it throws, so GitHub's redelivery runs a failed delivery again, after
  whatever the failed run committed. The handler gets the key as `ctx.delivery.key`;
  idempotent writes key on it. Never make the delivery record and the handler's writes
  one transaction: the handler's stores own their transactions.
- **The framework's variables are every `FABRIKA_*` name, and they leave the process
  before any application module loads.** The runtime adapter calls
  `captureEnvironment`, which keeps them in a frozen record and deletes them from
  `process.env` and `Bun.env`; only then does the generated entrypoint's `import()`
  load `src/app.ts`, so a dependency that copies the environment at module load
  copies none of them. Never import the application statically from the entrypoint.
  `boot` reads `FABRIKA_IAM_APP_ID` — the token audience `<app>@<env>`, whose
  application part must equal `contract.app` — `FABRIKA_CONTRACT_DIGEST`, which must
  equal `contractDigest` of the compiled contract (a missing or different one stops
  the boot), `FABRIKA_IAM_ISSUER` and
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

## File collections

- **The generated file endpoints are framework code** (`src/files/`), dispatched like every
  row: the dispatcher checks the caller, the requirement, admission and the access form, and
  only then hands the minted `Ref` to the files runtime. The access value of an upload or a
  download is the path parameter its `from` names; `remove` is a procedure.
- **Every database operation of a file request takes that `Ref`.** `@fabrika/db`'s file
  tables scope it by the `Ref`'s whole chain, so a move after the access check makes it match
  nothing. Never look a file up by its id alone after the check; `locate` is the only id-keyed
  read, and it is the access check's.
- **The pending row is written before the object and is the cleanup intent.** Any failure
  after it deletes the object and the row, or leaves the row for the sweep, which deletes
  pending rows only after `PENDING_GRACE_MS` (longer than `UPLOAD_TIMEOUT_MS`), so it never
  touches an upload in progress. Never write an object without a row first.
- **Every answer of a download endpoint carries the file treatment**, denials and errors
  included: `ContractRuntime.fetch` chooses it by the planned endpoint's kind, and a file is a
  `FileDownload`, never a `Response`, so no handler or store can set its headers. Keep the
  treatment equal to ADR-0022's.
- **The type is the sniffed one.** An upload is stored only when its first `SNIFF_BYTES`
  are the declared type, and the recorded type is what a download sends; `boot` refuses a
  collection that admits a type `sniff.ts` cannot verify. The size bound is the object
  store's (`FileObjectStore.write`), enforced while the body streams.
- `FileCollections.sweep()` is the seam a framework job calls on a schedule; until then a
  remove sweeps its collection. `serveContract` opens the object storage from
  `FABRIKA_APP_STORAGE_*` (all or none). Never return a storage URL or presign one.

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
- **The kit runs the real `boot` and dispatcher behind the real proxy decision**; only
  IAM is a stand-in (`kit.iam`, an `IamGateway`). The decision is production's:
  proxy-core's `createVerifyService` over `contractProxyTable(artifact)`, asked the way
  the Cloudflare proxy Worker asks it. Its answer reaches the test verbatim, and an
  allow forwards what the proxy asserts — the token, the request id,
  `X-Fabrika-Endpoint` — and drops `Authorization` on an anonymous endpoint. There is
  one decision and no option to swap it. Never re-implement proxy semantics here:
  `test-kit-differential.test.ts` holds the kit to proxy-core's `Authorizer` over the
  same table for every credential on every kind of path. The kit's own IAM issues no
  delegation grants: `options.membership` (an `IamMembershipRpc`) is both the proxy's
  delegation issuer and `boot`'s membership transport, and without it an application that
  creates scopes, manages members or issues links does not boot in the kit.
- `options.database` is the connection `boot` binds a `scoped(tables)` database to, as
  the runtime adapter supplies it; the kit compiles the artifact exactly as `boot` does.
- Its tokens are signed with a generated key and verified by the application's own
  verifier, so a test cannot reach a handler the production pipeline would refuse.
- **The kit answers only its own origin.** `kit.fetch` refuses another host, and
  `kit.browser` reads the effective request (a `Request` input's headers, `init`'s
  `credentials: 'omit'`) before it adds the session. A token above
  `MAX_ACCESS_TOKEN_BYTES` (`@fabrika/auth-core`) is 403, as IAM and the proxy answer.
- **Only test files load the kit.** `@fabrika/check`'s `test-only-import` refuses
  `@fabrika/app/testing`, and any test module, in a non-test file.
- **A request is stripped like the proxy strips it**: every `X-Fabrika-*` header,
  `X-Request-Id` and `UNTRUSTED_FORWARD_HEADERS` before the decision, the `__Host-px_*`
  cookies before the application. The proxy's token and request id are then set.
- The client and test-kit type witnesses live in `src/__tests__/client-mistakes/`,
  compiled by `client-types.test.ts` like the contract mistakes.

## Jobs

- **A job runs only under its lease.** `fabrika job run <name>` (the crontab's command, `runContractJob` in `bun.ts`)
  captures the environment, boots like the server and takes the job's row in `fabrika_job_leases`. A live lease
  held by another run means this run does not start (`skipped`). Each attempt holds its own generation and a
  deadline the database enforces: `RequestFrame` carries the fence and `requestCapabilities.fence()` answers it, so
  `@fabrika/db` refuses every write of an attempt that timed out, failed or lost the lease, and cancels one still
  running when the attempt ends (`attemptOnce` calls `cancelInFlight` before the runner touches the lease again). A
  retry renews the lease to a new generation before its backoff. Never run a handler outside `attemptOnce`.
- **Lease times are the database's**: the runner passes durations, never a timestamp, so a container whose clock is
  minutes off cannot take a live lease over. `JobClock` has only the waits and the jitter.
- **A job's capabilities are minted in process for its declared actions only** (part A). `ctx.within(action, dim)`
  is a `Within` over every value, `ctx.ref(action, dim, id)` a located `Ref`; both refuse an undeclared action, an
  unknown dimension and an ended attempt. The grants' principal is `job:<name>`. There is no IAM key, no token and
  no unscoped handle: B9 replaces the in-process mint with a workload credential of principal kind `job`, which no
  mount accepts (ADR-0022). A job cannot create scopes, manage members or issue links: its `ctx` has no such method.
- **`boot` refuses** a job scoped to a dimension (per-binding jobs are not built), a job without a bound
  `scoped(tables)` (the lease and the fence live in the application's schema), a schedule `schedule.ts` cannot read,
  a missing handler, a `handlers.jobs` entry the contract does not declare, and an Operations DSN that is not an
  ingest DSN.
- **A failure is a fixed code**: `timeout`, `lease_lost`, `handler_failed`, `driver_failed`, `crashed` in the run's
  result, its log lines and its report, and `boot_failed` in the CLI. The code is chosen by `instanceof` against the
  framework's own classes (`LeaseLostError` of `@fabrika/db/framework`), never by `name`. An application error's
  name and message are never logged, returned or reported: either may carry a secret.
- **Reports go through the ingest every application has** (`FABRIKA_OPERATIONS_DSN`): a run that failed after its
  retries, or crashed (its lease expired before it finished, found by the next run or the check), is one `JobFailed`
  error event; a job that has not succeeded within twice its period (from its first-seen time when it never did) is
  `JobMissed`, claimed in the database at most once per period. The serving process (`serveContract`) registers
  every job and runs `jobs.check()` every `JOB_CHECK_INTERVAL_MS`, so a schedule that never fires is reported too.
  Operations ingests error events only, so successes stay in the lease row (`last_status`, `last_succeeded_at`,
  `last_started_at`, `last_duration_ms`) and out of Operations (backlog 96).
- **Job reports are informational, not authenticated.** They travel under the public ingest key, which any holder of
  the browser DSN has, so one can forge a `JobFailed` or `JobMissed` like any other error event. Operations gives the
  `fabrika-job-*` fingerprints no special meaning: no auto-resolve, no state change. B9's workload credential is the
  fix: it authenticates the job's reports.
- An attempt without a `timeout` is cancelled after `DEFAULT_JOB_TIMEOUT_MS` (15 min); the lease lasts the timeout
  plus `LEASE_GRACE_MS`. Retries back off exponentially from one second, capped at five minutes, half jittered.
- The type witnesses live in `src/__tests__/job-mistakes/`, compiled by `job-types.test.ts`.
