# @fabrika/app

The first-party server framework for Fabrika applications. It provides the contract
framework, the installation services' service contracts, typed RPC, structural errors,
the runtime adapters, and a typed browser client.

[ADR-0012](../../docs/decisions/0012-fabrika-app-runtime.md) makes the contract the
target: an application declares `fabrika.contract.ts` with the staged kit and serves it through
`serve` (`@fabrika/app/implement`), booted by the generated entrypoint that
`fabrika app build` writes (`@fabrika/app/build`). The installation's own services
(IAM, Control, Operations) declare service contracts and serve them with `serveService`
(`@fabrika/app/service`). The runtime adapters (`@fabrika/app/bun`, `@fabrika/app/cloudflare`) serve a
`FetchService` (`{ fetch(request, env, exec) }`, `src/fetch.ts`). How it works:
[application runtime](../../docs/reference/application-runtime.md).

## Commands

```bash
bun run typecheck
bun run test                                    # every suite; the DOM tests of src/react in a run --isolate of their own
bun test src/__tests__/rpc.test.ts
bun test src/__tests__/contract-types.test.ts   # the contract mistakes, compiled by tsc
bun test src/__tests__/implement-types.test.ts  # the handler mistakes, compiled by tsc
bun test src/__tests__/kit-types.test.ts        # the staged kit: the API matrix and the kit mistakes, compiled by tsc
bun test src/__tests__/kit-scale.test.ts        # 200 kit endpoints in 10 group modules, within the scale budget
bun test src/__tests__/orm-dispatch.test.ts     # ctx.db through boot: the invocation's transaction, handle binding (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/orm-types.test.ts        # the data mistakes of a kit handler, compiled by tsc
bun test src/__tests__/implement.test.ts        # boot's request pipeline, with real tokens
bun test src/__tests__/scoped-database.test.ts  # a handler tree over @fabrika/db (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/endpoint-access.test.ts  # the endpoint access kit: own target, seeds, link holder, runJob (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/membership-stand-in.test.ts  # the kit's IAM stand-in: delegations, creates, members, links, live roles
bun test src/__tests__/generated-cases-intake.test.ts  # the generated tests' kits beside public procedures, a challenge and a scanning kind (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/kit-tableless.test.ts    # defineApp(vocabulary): no tables, database: null, no ctx.db
bun test src/__tests__/test-kit.test.ts         # the test kit: the proxy decision in front of boot, a built SPA, the stand-in IAM
bun test src/__tests__/test-kit-links.test.ts   # a share link the app issued opens as its holder until revoked; devKit (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/client-types.test.ts     # the client, hook and test-kit mistakes, compiled by tsc
bun test --isolate src/react                    # the React hooks: cache, invalidation, the error union, the caller (DOM)
bun test src/__tests__/locators.test.ts         # on, in and over through nested containment (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/file-scan.test.ts        # a scanning file kind and the scan job (needs FABRIKA_TEST_POSTGRES_URL; FABRIKA_TEST_CLAMSCAN_BIN adds a real ClamAV)
bun test src/__tests__/clamscan.test.ts         # the ClamAV scanner: stand-in binaries, and a real clamscan with FABRIKA_TEST_CLAMSCAN_BIN
bun test src/__tests__/archive.test.ts          # the archive check: LZMA, damaged, encrypted, nested, bombs
bun test src/__tests__/multi-tenant.test.ts     # creates, ctx.members, share links, a webhook bound by binds (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/members-lookup.test.ts   # ctx.members below its dimension: types, the kit, a generated member field (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/terminal.test.ts        # a terminal: the identification page, ctx.principal.terminal, ctx.terminals over a fake IAM
bun test src/__tests__/public-admission.test.ts # a public procedure's shared buckets and challenge through boot (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/challenge.test.ts        # the client key and the Turnstile verification, no database
bun test src/__tests__/public-kick.test.ts      # a public procedure's kicks: kicked runs, coalescing on the lease, the cron recovery (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/multipart.test.ts        # the streaming multipart reader a procedure with file fields reads its body through, no database
bun test src/__tests__/mutation-kick.test.ts    # a mutation's ctx.kick: a run after the commit, nothing on a refusal, stopKicks (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/job-mail.test.ts         # ctx.mail: the kit's stand-in, prefixed keys, the installation's and the own transport, an installation without mail, fail-closed boot (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/jobs.test.ts             # the job runner: leases, fenced writes, retries (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/error-reports.test.ts    # what a report carries: scrubbing, frames, causes, caps; crash reports of both adapters
bun test src/__tests__/intake.test.ts           # the intake recipe's job: each stop, bad records, batches, locks, keys (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/request-signal.test.ts   # ctx.signal of a request handler: a cancelled request, the budget
bun test src/__tests__/request-budget.test.ts   # a writing mutation past REQUEST_BUDGET_MS: aborted, 500, nothing written (10 s; needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/outbox-rule.test.ts      # the generated cases of an outbox write and of an outbound call (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/job-types.test.ts        # the job handler mistakes, compiled by tsc
bun test src/__tests__/connect.test.ts          # an export and an import, each in its own test kit
bun test src/__tests__/connect-hardening.test.ts # captured connect methods, a hostile owner, budgets and deadlines
bun test src/__tests__/export-read-only.test.ts # an export handler cannot write (needs FABRIKA_TEST_POSTGRES_URL)
bun test src/__tests__/cloudflare-runtime.test.ts          # the environment's Durable Object in Lopata: hop, migrations, ctx.db, tick, R2
bun test src/__tests__/cloudflare-runtime-adapter.test.ts  # the object's bindings and crash reports, over bun:sqlite
```

## Structure

```text
skill/                the agent skill `fabrika-app`: the one text of the application rules
  SKILL.md            the paved road, the declared steps off it, the loop; `version` = this package's
  references/*.md     one topic each (setup, tables, endpoints, jobs, files, …); every code block is checked
src/
  index.ts            public surface
  from-row.ts         fromRow: a row as an output object (snake → camel, Date → ISO, then the schema); fromPage: a list's page
  agent-skill.ts      @fabrika/app/agent-skill — reads skill/; installedAppAgentSkill; renderAgentsFile (node:fs)
  fetch.ts            FetchService and RequestExecutionContext: what both runtime adapters serve
  cloudflare.ts       Worker module adapter and lifecycle types; createContractWorker: the Worker that forwards each
                      request and the minute tick to the environment's Durable Object; re-exports FabrikaApplication
  cloudflare/         what @fabrika/app/cloudflare runs (ADR-0065)
    application.ts    FabrikaApplication, the environment's one Durable Object: verifies the hop, migrates its SQLite,
                      boots the application once per isolate, serves requests and the tick; registerApplication
    bindings.ts       the bindings the object boots with, read structurally: IAM (keys, membership, workload tokens),
                      ASSETS, FABRIKA_CONNECT_<IMPORT>
    r2-files.ts       r2FileObjectStore: the FileObjectStore port over the FABRIKA_FILES bucket (conditional puts,
                      multipart above R2_PART_BYTES, the etag as the version)
    names.ts          the class and binding names the provider shares: FabrikaApplication, FABRIKA_APPLICATION,
                      FABRIKA_FILES (re-exported by @fabrika/app/build)
  bun.ts              Bun handler, background-task tracking, graceful drain; serveContract; the local `directory`
                      mail provider, which boot honours only under a loopback issuer
  disk-assets.ts      diskAssets: the SPA mounts from their build directories, as the Bun deploy and the test kit serve them
  service/            @fabrika/app/service — the installation services' own tables and dispatcher
    define.ts         defineServiceContract: an endpoint table with the installation forms
    serve.ts          serveService: the dispatcher over planEndpoint
  build.ts            @fabrika/app/build — the generated entrypoint fabrika app build writes; on Cloudflare also
                      fabrika/migrations.generated.ts (db/migrations as a module: a Worker reads no file system)
  errors.ts           structural HTTP error mapping
  rpc/                procedure builder, types, and dispatcher
  client/             @fabrika/app/client — browser-safe
    contract.ts       createClient: the typed client of a contract mount; download, the call of an attachment procedure;
                      ResultOf, InputOf
    share.ts          shareKey: the key the share SPA's bootstrap kept
    caller.ts         parsePageCaller: the caller document an SPA mount serves at <prefix>/__fabrika-me.json
    rpc.ts            createRpcClient: the client of the { method, input } wire protocol (exported from the root)
    error-reporting.ts  the page's uncaught errors as Sentry error events to the DSN of <prefix>/__fabrika-config.json
                      (not exported; FabrikaProvider starts it)
    transport.ts      RpcError, the login bounce, reading the { result } / { error } envelope or a file
  react/              @fabrika/app/react — browser-safe; React is an optional peer dependency (ADR-0052)
    provider.tsx      FabrikaProvider: the clients by mount, the cache, the caller document, the page's error reporting
                      (reportErrors); a procedure's input checked first
    hooks.ts          useQuery (keepPrevious: an offset list), useInfiniteQuery, useMutation, useAction, useDownload,
                      useInvalidate, skip
    testing.ts        @fabrika/app/react/testing: installDom (happy-dom over Bun's web platform, no navigation),
                      type, controlByLabel, waitForText; happy-dom's registrator is an optional peer dependency
    store.ts          the cache without React: entries by procedure and input, pages, sequence numbers, invalidation
    errors.ts         FabrikaError: the union every refusal maps to; fieldError
    caller.tsx        useCaller and <Can> over the caller document
    types.ts          ProcedureInput, ProcedureResult, PagedProcedure: the types read off a client procedure
  testing/            @fabrika/app/testing — no test-runner dependency
    kit.ts            testKit: boot behind the production proxy decision and a stand-in IAM; the module re-exports
                      the types its options take (IamMembershipRpc, ChallengeFetch, FileScanner)
    proxy.ts          endpointProxy: proxy-core's verify service over contractProxyTable
    caller.ts         test callers and their grants
    membership.ts     kitMembership, every kit's stand-in IAM transport: member directories from the kit's callers,
                      the writes checked as IAM checks them, live in the directory and the next token; it records them,
                      accepts an invitation, seeds the invitations and links a generated case cancels or revokes, and
                      resolves the key of a link it issued; it lists the invitations it sent (the dev mail view)
    dev.ts            devKit and the DevSeed types: the kit `fabrika app dev` serves, and its seed module's contract;
                      DEV_OUTBOX_ORIGIN, the DevMail of devKit's mails(), and the DevOutside the seed reads the dev
                      outbox (outbox()) and the jobs' mail (mails()) through
    challenge.ts      passingChallenge: a siteverify stand-in that passes every token, devKit's default;
                      TURNSTILE_TEST_TOKEN, the test widget's token devKit admits at every submission;
                      solveChallengeAt, which fetches an ALTCHA challenge and solves it (kit.solveChallenge)
    isolation.ts      @fabrika/app/testing/isolation: the kits behind the generated tests
    policy-isolation.ts  policyIsolationKit and appPolicyIsolationKit: a probe contract over one table's policy
    endpoint-access.ts   endpointAccessKit: the application's own endpoints, asked from two scopes
    runner.ts         the test functions the generated tests register through
    status.ts         statusOf: the status an application's own test asserts (200, or the refusal's); the kits' too
  contract/           @fabrika/app/contract — browser-safe
    vocabulary.ts     defineVocabulary: the first module of the staged kit
    kit.ts            defineApp(vocabulary, tables): App (group, cron, webhook, link, export, contract), ContractKit
    group.ts          the endpoint builders of a group, a link and an export; .handle; ExactReturn
    context.ts        what a kit handler receives: ctx by access form and declaration (types only)
    define.ts         defineContract, the c.* kit and every type an agent meets
    attachment.ts     attachment(): an output that answers a file of rows (the rows' array schema, marked)
    token.ts          token(Claims, { maxDays }) of defineApp's options, signedToken('<purpose>'), the claims types
    declaration.ts    the contract as plain data, generic over its schema type
    schema-shape.ts   a zod 4 schema of the subset → SchemaShape
    compile.ts        compileContract / describeContract
    build.ts          buildArtifact: every check, default and generated endpoint
    defaults.ts       the defaults and generated paths, in one place
    artifact-schema.ts  parseContractArtifact, the zod parser of the artifact
    platform.ts       schemaFromContract: the IAM vocabulary a deploy reconciles
    connect.ts        exportDescription, ConnectSnapshot, describeSnapshot, parseExportDescription
    snapshot-source.ts  snapshotSource: the vendored snapshot module fabrika connect writes
    schema-from-shape.ts  schemaFromShape and declaredPath: what a connector validates with and reports
  implement/          @fabrika/app/implement — serving a contract (node:async_hooks)
    implement.ts      ContractImplementation; implement, the framework tests' handler tree (not exported)
    serve.ts          serve(contract, { database, deps }) and defineDeps: serving a kit contract
    types.ts          the handler types: HandlersOf, ExactHandlers, AccessContext
    invocation.ts     siteHandler (serve's tree leaf), the declaration's parse, Invocation, ctx.db by access form
    boot.ts           boot: framework variables, refusals, handler binding; each runtime's issuer
    dispatch.ts       ContractRuntime: the per-request pipeline and the error envelope
    capability.ts     Ref, Within, createCapabilityIssuer (a mint and its CapabilityAuthority)
    membership.ts     creates, ctx.members and ctx.links: requests to IAM through IamMembership
    terminals.ts      ctx.terminals: the identifications at a terminal (ADR-0067), asked of IAM with the request's credential
    anonymous.ts      the bounded body read, the share bootstrap
    client-address.ts a public procedure's client bucket (`X-Fabrika-Client-Ip` only)
    multipart.ts      the `multipart/form-data` reader of a procedure with file fields: part by part as the body streams, strict
    challenge.ts      a public procedure's challenge: Turnstile's siteverify under a deadline, strictly read; an
                      ALTCHA challenge issued and verified in process (altcha-lib), and the replay key of each
    webhook.ts        a webhook's bindings (ctx.webhooks, a GitHub webhook's generated endpoints) and a delivery's principal
    verifiers.ts      a delivery's signature: the presets and the hmac shape, constant-time
    tokens.ts         signed tokens: FABRIKA_TOKEN_KEYS, ctx.tokens.sign, the verification of each token field
    urls.ts           ctx.url: an absolute link to a procedure, on FABRIKA_APP_ORIGIN, with the parameters its URL carries
    egress.ts         the guard on the global fetch: a site's handler reaches only its declared egress origins
    faults.ts         ServerFault: a framework failure whose message only the log sees
    failures.ts       FailureReports: a 5xx as one log line and one rate-limited Operations event, by code
    crashes.ts        a boot that throws, an uncaught exception, an unhandled rejection: one crash report each
    principal.ts      caller kinds and principals from a verified token
    headers.ts        the response header policy
    project.ts        output projection over the output's zod schema
    environment.ts    captureEnvironment: the FABRIKA_* variables out of the process
    connect.ts        Connector, wireImports, connectContext (ctx.connect per request), connectVariables
    bounded.ts        readBoundedBytes: a body under a byte budget and a deadline
    attachment.ts     encodeCsv and the response of an attachment output: RFC 4180, formula escape, size bounds
    xlsx.ts           encodeXlsx: one sheet of typed cells in a stored ZIP, the framework's own writer
  files/              c.files: served by boot, never imported by an application
    handle.ts         the types of ctx.files (types only, browser-safe)
    scan.ts           the scan pass of scan: true file kinds and the FileScanner contract (FILE_SCAN_JOB)
    archive.ts        checkArchive: what a ZIP must be for the scanner's OK to cover it
    clamscan.ts       clamscanScanner: ClamAV's clamscan over a batch (Bun; @fabrika/app/bun only)
    sniff.ts          the declared type checked against the first bytes
    treatment.ts      FileDownload and the file treatment of ADR-0022
  jobs/               c.cron at runtime; bound by boot, run by `fabrika job run <name>` (runContractJob), on
                      Cloudflare by the object at the minute tick (isDueAt)
    types.ts          JobContext, JobHandler, JobHandlersOf: handlers.jobs.<name>
    runner.ts         bindJobs, the run: lease, attempts, timeout, retries, reports, a site's kick; the framework's own jobs
    schedule.ts       five-field cron in UTC: the due minutes and the period
    report.ts         the Operations reporter: job runs, request failures and crashes as error events to its ingest
    exception.ts      a thrown value as Sentry exception values: type, message, parsed frames, cause chain, bounded
    scrub.ts          the scrubber: the environment's secret values and credential patterns out of a report
```

## Invariants

- `AuthContext` and `Scope` come from `@fabrika/auth`. Do not duplicate their shapes.
- The proxy's endpoint decision decides whether a request reaches the app; the proxy is
  the only enforcement point. `.require()` and the contract's requirement check are
  **authorization** in the vocabulary of `docs/reference/overview.md`; the same-origin
  check of `boot` is **admission**. Neither is the enforcement decision. Never add
  one here.
- `boot` and `serveService` answer 400 for a non-canonical raw path
  (`isCanonicalPath` from `@fabrika/auth-core`) and select only through `planEndpoint`,
  the planner the proxy selects with. A trailing `/` is significant, so `/a/` and `/a`
  are different paths. Never add a second router or normalize a path.
- Error handling is structural. Never rely on cross-package `instanceof`.
- The RPC wire protocol (`dispatchRpcRequest`, `createRpcClient`) is `{ method, input }`
  requests and `{ result }` or `{ error }` responses. `{ batch }` is removed: one request
  is one call, and a `{ batch }` body is a 400.
- Browser-safe procedure contracts may be implemented with `RpcRouterFor` and
  consumed with `createRpcClient`; they must not import a server runtime.
- The `FetchService` owns request behavior. Runtime adapters only supply lifecycle
  capabilities and must not fork routing or RPC semantics.
- Applications get no middleware, raw routes, `authenticate` or custom server.
  `serve` has no slot for them, and `@fabrika/app/service` is for the installation's
  own services only. `serveService` is never a way to serve a contract.
- The package root is runtime-neutral. Provider lifecycle APIs are exported only
  from `@fabrika/app/cloudflare` and `@fabrika/app/bun`. `@fabrika/app/implement`
  imports `node:async_hooks`, so neither the root nor `/contract` may import it:
  the SPA imports both.
- The Bun adapter tracks every `waitUntil()` task. Shutdown drains them before
  application resources close.
- The runtime-conformance tests (`src/__tests__/fixtures/runtime-conformance.ts`, used by IAM, Control and
  Operations) create fresh requests and environment state for every runtime.
- Contract schemas are zod 4 (`zod/v4`), restricted to a serializable subset:
  strict objects, no transforms, no `passthrough` (ADR-0012). `initRpc`
  procedures and validation inside a handler stay library-neutral (Standard Schema).
  `zod` is a peer dependency, so an application and the framework share one copy.
- Never log credentials, secret values, or request headers.
- No casts, `any`, `@ts-ignore`, or `@ts-expect-error`.
- **`skill/` is the only copy of the agent rules.** The builder installs every file of it from the application's
  pinned `@fabrika/app`, Control's MCP tool `get_app_rules` answers its body or one reference file by topic, and an
  application's `AGENTS.md` is `renderAgentsFile`; each test compares against `readAppAgentSkill()`. Describe what is
  built and say what is not; a change to a rule the skill states (a command, a refusal, an API, a provider gap)
  updates the skill in the same change, and regenerates the template's `examples/zerops-app/AGENTS.md`
  (`agent-skill.test.ts` fails until it is the rendered file). The frontmatter `version` is this package's; the
  release rewrites it in the tarball.
- **Every `ts`, `tsx`, `sql` and `json` block of the skill names its file** (`` ```ts src/tasks/endpoints.ts ``).
  `skill-code.test.ts` compiles the blocks as one application against the workspace (the base files: `SKILL.md`,
  `app-setup.md`, `table-and-migration.md`, `endpoint.md`, `tests.md`; each other reference file is a variant over
  it, except a `STANDALONE` one such as `public-intake.md`, an application of its own over the base's `package.json`,
  `tsconfig.json` and `src/app-kit.ts`), classifies each application's migrations, and on Postgres checks that they
  migrate to its catalog (`src/__tests__/skill-app/catalog.json`, `skill-app/<name>/catalog.json`), from which the
  generated schema is rendered. Change a migration block, then regenerate that catalog.

## Contract framework

- `@fabrika/app/contract` is browser-safe: it imports `@fabrika/auth-core`,
  `@fabrika/db/tables`, `@fabrika/proxy-core/headers` (which imports nothing at runtime: `isPolicyOrigin`,
  `MAX_CSP_ORIGINS`, `WORKER_BLOB_SOURCE`) and `zod/v4` only. The SPA imports `fabrika.contract.ts` for
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
  shared options const turn a webhook into something else.
- `buildArtifact` returns the canonical artifact (`canonicalizeArtifact` from
  `@fabrika/auth-core`, see its CLAUDE.md) after parsing it with
  `contractArtifactSchema`. A parse failure there is a check missing from
  `build.ts` or `schema-shape.ts`; add the check, never loosen the parser.
- **The schema subset is `@fabrika/check`'s.** `schema-shape.test.ts` covers each
  factory and method `packages/check/CLAUDE.md` lists, and `contract-check.test.ts`
  runs the checker over the fixtures. Change the checker, `schema-shape.ts` and
  `SchemaShape` together. A default becomes `optional`, so its value must be one
  its own schema admits (zod returns a default unchecked); a discriminated union
  becomes a `union` (so a discriminator may not have a default); `.describe()` adds nothing.
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
- Generated endpoints: a procedure is `POST <prefix>/<dotted.path>`, or a public procedure's own literal `http.path`
  (`procedurePath`, which the typed client calls too; outside every mount's prefix but the root SPA's); an SPA serves
  `GET <prefix>/*`, and below the root also `GET <prefix>` (row `<mount>.prefix`, `spaPrefixRowId`) under the same
  access, which answers 308 to `<prefix>/` so the bare prefix never falls through to the root SPA; both are anonymous
  (kind `public-spa`, no token) with `access: { public: true }`,
  which takes no other key, and answers `<prefix>/__fabrika-config.json` itself with `{ dsn, release, environment, public }` (the
  browser-safe `FABRIKA_OPERATIONS_DSN`, `FABRIKA_RELEASE` and `FABRIKA_ENVIRONMENT`, `null` when unset; `public`, present only when non-empty, the values of
  every public procedure's challenge `siteKey` and of the mount's own `browserConfig` list, `browserConfigs` in `browser-config.ts`, each one
  required at boot) and nothing else of the environment, and
  `<prefix>/__fabrika-me.json` (`PAGE_CALLER_FILE`) with the caller document (`pageCallerOf` in `principal.ts`) under
  the mount's own access, 401 on a public SPA; no SPA or link mount serves a path ending in `.map` (404: the platform
  build uploads source maps to Operations, and a map holds the source); a link mount serves `GET <prefix>/*` (anonymous) and its procedures at
  `POST <prefix>/api/<name>`;
  exports under `/__fabrika/connect/<export>.v<version>.<procedure>`, each export's
  description at `/__fabrika/connect/<export>.v<version>`; a webhook
  appends `/:bindingId`. No authored path may lie under `/__fabrika`.
- **The proxy reads the contract's endpoint table**, `contractProxyTable(artifact)` from
  `@fabrika/proxy-core/manifest`; nothing else describes an application to the proxy, and
  the strict manifest parser refuses any other form (ADR-0022 rule 3).
- **`schemaFromContract` (`platform.ts`) reads only the artifact**, so the static
  reader's artifact compiles to the same schema. It emits every
  field of A12's `AppSchema`, `workloads` included (each job and webhook with its sorted actions), and its output must parse unchanged with
  `@fabrika/auth`'s `appSchemaSchema`, which resolves every name it carries.
- **What IAM would refuse is refused at the source, not in the generator.** `buildArtifact`
  and `contractArtifactSchema` both refuse a `*` in any action name and a role named after
  `BUILTIN_ROLE_KEYS`; `buildArtifact` and the `CreatableDimension` type refuse `creates`
  for a dimension with `in`, because IAM's `createScope` makes only top-level values.
- Membership, scopes and share links are requests to IAM through `@fabrika/auth`'s
  `IamMembership`. The framework writes no grant and mints no credential.
- The framework generates no endpoint of its own for data: a webhook is bound by a procedure that declares
  `binds: '<webhook>'` (`ctx.webhooks('<name>').bind`), and a file is served by a procedure whose output is a file.

## The staged kit

The paved-road sprint (`docs/archive/sprint-2026-10-11-paved-road-core.md` and
`docs/archive/sprint-2026-10-11-paved-road-framework.md`) built it unit by unit; its
signatures are fixed, and each builder whose runtime a later unit adds throws `<builder> is not implemented (WU<n>)`
(`notImplemented` in `contract/problems.ts`). `defineVocabulary`, `defineTables(vocabulary, columns)`, `defineApp`
with its builders, `serve` and `defineDeps` run; the tables derive each key, container and child chain from the
vocabulary (`packages/db/CLAUDE.md`).

- **The file order is the type order:** `src/vocabulary.ts` (`defineVocabulary`) → `src/db/tables.ts`
  (`defineTables(vocabulary, columns)`, typed by the generated `TypedColumnList`) → `src/app-kit.ts` (`defineApp(vocabulary, tables)`)
  → `src/<slice>/endpoints.ts` (`app.group(…)`) → `fabrika.contract.ts` (`app.contract(…)`) → `src/app.ts`
  (`serve(…)`). Never type a table, a group or a handler by `typeof contract`: tsc reports TS7022 on the cycle.
- **`defineApp` computes the kit's types once** (`KitOf`, with `@fabrika/db`'s `DbIndex<DB, P>`); every context is a
  lookup in them. Keep per-endpoint types to lookups: `kit-scale.test.ts` holds 200 endpoints under the budget of
  `implement-scale.test.ts`.
- **A member a site may not use is an `Unavailable<'…'>` tuple**, never a missing property or `never`: a call fails at
  its line with the message, which names the fix. `kit-types.test.ts` compiles `kit-mistakes/` with `plain: true` (at
  most two lines, no `never`, no truncated or object type printed). A new rule the kit's types enforce gets a mistake
  there and a row in `kit-fixture/matrix.ts`.
- **`.handle` answers the endpoint without the handler's type**, or, when the handler returns a field the output does
  not declare, an `Unavailable` the group refuses at the endpoint's line (`ExactReturn`). A group does not nest; a
  mount nests groups. A group accepts an endpoint without `.handle`, because an options-first call cannot be checked
  against its own callback; `c.rpc` refuses it, naming `<group>.<endpoint>`, and refuses a group whose type is
  widened to admit one (`GroupInput`). A callback the group refused falls back to `GroupBuild`, which the mount
  skips, so the error is not repeated there.
- **A refused access form stays refused in the handler.** A written form is one object; when the compiler refuses it
  and falls back to the whole constraint (a union), `CheckedAccess` makes the capability and `ctx.db` an
  `Unavailable` that says so, never a union of every form.
- **A declaration exists only if the object carries it**: each off-road field is inferred from its optional field and
  then required (`DeclaredFields`), and an `unscoped` key that is no table is refused at its line, and so is
  a mode that may be `'write'` (a union or an optional one included) of a reference table
  (`ReadOnlyUnscoped`), which no site writes.
- **`connect` is a literal list and `issues` one literal**: a widened `string[]` or a union declares nothing, so the
  site refuses it with a message that shows the literal form.
- **The declared off-road fields** (`sql`, `unscoped`, `connect`, `issues`) are the only way to `ctx.sql`,
  `ctx.db.unscoped`, `ctx.connect` and `ctx.links`; a query and an export declare only `'read'`. The connectors are the
  kit's `imports`.
- **`DbHandle<typeof app, form, dimension, action, kind>`, `ReferenceHandle<typeof app>` and `SqlHandle<typeof app, mode>`**
  (`context.ts`) are the types of `ctx.db`'s handles and of `ctx.sql`, for a `queries.ts` function that takes one;
  `orm-handles.ts` pins them to the context. A bare `SqlTag` defaults to `AnyDbIndex`, under which a
  literal capability's `scope` finds no table; `SqlHandle` binds the app's index.
- **The runtime builds plain declarations, and `defineApp`'s signature is its only typed face.** `RuntimeApp` (in
  `kit.ts`) builds the same `ProcedureDeclaration`, `CronDeclaration`, `WebhookMountDeclaration`, link and export
  declarations `defineContract` builds, with `declared` (`declaredOf`: only the fields the options carry) and
  `unknownOptions` without the declared fields (`kitUnknownOptions`). The face answers types no implementation can
  return (`.handle`'s `ExactReturn`, `contract`'s `imports` by the kit's imports), so the compiler relates the two
  nowhere else; `kit-runtime.test.ts` holds each builder to what its type says.
- **A site's handler is kept beside its declaration, never in it** (`contract/handled.ts`, a `WeakMap`): `.handle`
  returns a copy of the declaration, and a pending site carries `handle` on its prototype, so `compileContract`, the
  static reader and a spread see the declaration only, handled or not. The SPA's sliced bundle therefore evaluates to
  the same contract, without one handler.
- **`app.contract` derives the `imports` section** from the kit's imports and the RPC endpoints whose `connect` names
  each (`usedBy`, sorted), with `kitImportsSection`, which the static reader calls too; a kit contract that writes an
  `imports` section of its own is refused. The section exists exactly when `defineApp`'s options are given, so the two
  overloads keep them apart: `defineApp(vocabulary, tables)` promises no section, and `defineApp(vocabulary, tables,
  { imports })` requires both the options and their `imports`. Options or imports that may be absent, or imports given
  only as a type argument, would let the type promise a section the runtime does not build (`colocated-mistakes/05`–`07`). A kit import no endpoint connects is refused by `buildArtifact`, as before.
- **`buildArtifact` parses `declared`** (the static reader copies it unchecked): `sql` and each `unscoped` mode `read`
  or `write`, `read` only on a query and an export; `unscoped` names tables of `src/db/tables.ts` and never a
  `fabrika_*` one, and `'write'` never a reference table (its rows come from a migration); `connect` only on an RPC endpoint, naming the kit's imports; `issues` on an RPC endpoint, a link
  mount whose `issuedBy` on its dimension is the endpoint's own access, and on a cron job, a link mount whose
  `issuedBy` and every grant are among the job's actions (`schemaFromContract` hands it to IAM as the job's `issues`).
  The artifact's `declared` section holds
  each site that declares anything, by endpoint id or `job:<name>`. It is present for every contract with a kit site,
  empty included, and absent for a `defineContract` one: `boot` reads from it alone which reach rule applies.
- **A kit contract's reach is the approved artifact's, whatever the leaf.** `boot` runs every endpoint of a contract
  whose artifact has `declared` with that declaration (`approvedReach`; none when the site has no entry), a
  `siteHandler` leaf or a plain function `implement` bound alike: `ctx.links` only for the mount it `issues`,
  `ctx.connect` only for its `connect`. Only a `siteHandler` leaf gets `ctx.db`. A `defineContract` contract keeps its
  reach by its imports' `usedBy` and its link mounts (`kit-reach.test.ts`).
- **A kit without tables** is `defineApp(vocabulary)` (`NoTablesIndex`):
  `serve(contract, { database: null })`, and only then `null` (`kitOriginOf`, `handled.ts`: `serve` refuses a contract no kit built, a copy included, so the origin cannot be lost); its procedures are served
  without `ctx.db` (`servedWithoutData` in `boot.ts`), and a site that declares `sql` does not boot.
- **`implement` is not on the application surface.** `@fabrika/app/implement` exports `serve`; the mirrored handler
  tree (`implement/implement.ts`) is the framework's own test entry, imported by relative path. Never re-export it.
- **`serve(contract, { database, deps })` adapts the kit to `boot`**: it walks the contract and builds the handler tree
  `implement` would (RPC and link mounts by path, webhooks by name, `jobs.<name>`, `exports.<name>.<path>`); each
  entry is a `siteHandler(handler, declared)` leaf, its handler run with the boot's dependencies. It refuses (`ContractError`) every endpoint,
  job and webhook without `.handle(…)`, naming each by its path: the types refuse one in a group, and `serve` also
  catches what they skip (a callback the group refused, a job, a webhook, a link or export procedure). `c.rpc` cannot
  refuse it at runtime, because the SPA's sliced bundle carries no handler at all. The snapshots of the kit's imports
  reach `boot` from the contract (`snapshotsOf`). `defineDeps(build)` runs `build` at each `boot`, and each handler runs with its boot's result
  (`AsyncLocalStorage`), so `get()` answers the boot serving the invocation, two runtimes of one process included; it
  throws at module load.

## Service contracts (the installation's own services only)

- **`@fabrika/app/service` is for IAM, Control and Operations, never an application.** `@fabrika/check`
  refuses the import (`forbidden-import`), the static reader refuses `defineServiceContract`, and the
  manifest parser reads the installation forms only in an entry platform composition marks
  `installation: true` (ADR-0022 "Installation entries"). It imports only `@fabrika/auth-core`, so a
  service's table module stays dependency-light.
- `defineServiceContract(id, (s) => ({ endpoints, reservedPrefixes }))` keys each row by its id;
  `s.health`, `s.protocol` and `s.service` write the row, and `null` is a row this composition does not
  serve (a switched-off transport). It refuses an `<app>@<env>` id, an `oauth` caller without scopes or
  scopes without it, and every table `compileEndpointTable` refuses. The proxy reads the same artifact
  through `serviceProxyTable` (`@fabrika/proxy-core/manifest`); never write manifest rows by hand.
- **`serveService` dispatches only through `planEndpoint`**, in this order: non-canonical path 400, no
  row 404, a `service` row without `X-Fabrika-Endpoint` naming that row and its digest 503, a path
  parameter that does not decode 400, then the row's handler. A `protocol` or `health` row ignores the
  header: the service authenticates it itself, and it also arrives unfronted or over a private hop that
  carries the calling service's own header (ADR-0022 rule 5). It checks no proxy secret; the only installation
  service that gets one is IAM, which reads it for attribution only. It needs a handler for every row it serves.
- `dispatchRpcRequest`, `initRpc` and `createRpcClient` stay for the installation's typed RPC mounts;
  a row handler of a `{ method, input }` mount calls `dispatchRpcRequest`.

## Serving a contract

- **`boot` dispatches only through `planEndpoint`** over the compiled artifact's
  table. There is no second router: an unknown procedure under an RPC prefix is 404
  and never the SPA, and a non-canonical path is 400.
- **The proxy secret comes first** (ADR-0022 rule 5). When `FABRIKA_PROXY_SECRET` is set, a request
  without `X-Fabrika-Proxy-Secret` equal to it is a 403 before any other answer — also for an unknown or
  non-canonical path — and only a `health` endpoint is served without it. The 32-byte SHA-256 digests
  are compared with `node:crypto`'s `timingSafeEqual`, never the secrets and never with `===`. `serveContract` and the Cloudflare object pass `requireProxySecret`, so the application does not
  boot without one (or with one under 32 characters); the test kit sets none.
- **Per request, in this order** (ADR-0012 §5): proxy secret → canonical path → `planEndpoint` →
  the proxy's endpoint (`X-Fabrika-Endpoint`) → token verification with `@fabrika/jwks`'s shared verifier → caller kind →
  requirement (`satisfies`) → admission → strict input (a string or key holding U+0000, which Postgres `text` cannot
  store, is a 400 like any other refused value; so is a path parameter holding one) → access form → remove the
  `from` field → handler → output projection → the header policy. Caller kind,
  requirement and access form are authorization; same-origin and content type are
  admission. Neither is the proxy's enforcement decision; never reorder them so that admission or input
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
  'user'` is `human`, `ptype: 'service'` is `machine`, `ptype: 'app'` is `app:<workload>`, an
  anonymous token (a share link) is `link`. A job or webhook token and an OAuth resource token
  are no caller. Never map a token to a caller kind anywhere else. A `human` principal's `email` is the token's
  `email` claim and nothing else (never derived from `label`); a `human` token without it is 401 (`no_mailbox`).
- **The caller document is information for the page, never a check.** `pageCallerOf` lists the token's grants as
  the contract's actions each covers (a pattern included), global ones apart from each scope value's, and asks IAM
  nothing. Never let an endpoint, or the framework, decide by it.
- **Admission** treats a request without an `Authorization` header as a session
  request: when it is not a `GET` it needs `Sec-Fetch-Site: same-origin`. A
  cross-site page cannot add that header without a preflight, and the application
  answers none. Every RPC request needs `Content-Type: application/json`.
- **`Ref` and `Within` are bound to their request** with `AsyncLocalStorage`.
  The runtime's authority refuses a value its runtime did not mint, one whose
  request has ended, and one from another live request; `@fabrika/db` checks kind,
  dimension and action itself. Both classes keep their grant and their issuer in
  private fields and need a module-private token to construct; never export that
  token.
- **Every `boot` call makes its own issuer, and only that call holds the mint.** `createCapabilityIssuer`
  answers a mint and the one authority that accepts what it mints. `boot` binds the data layer, the stored
  files, the membership requests and `deps` to the authority, and hands the mint to `ContractRuntime`
  and `bindJobs` as a parameter, never through a module export: an application can load any module of the
  package by URL (the package ships `src/`). So a mint application code makes, or a second runtime it boots
  with keys of its own, mints what the served runtime's stores refuse. There is no process-wide authority:
  the Worker adapter's runtime per environment and a retried boot each have their own. Tests mint through an
  issuer of their own. Never export a runtime's mint, nor a handle on the running request beyond
  `isActiveRequest` (`capability-mint.test.ts`). The checker refuses an application import of `boot`.
- **A capability's facts are frozen at mint, and every resolution is a fresh copy.**
  The chain is stored as frozen pairs, copied into a new `Map` through built-ins
  captured at load, and `resolve` returns a new frozen grant each time. Whoever
  changes a returned chain changes only their copy; the data layer's next
  resolution still carries the chain that was checked. Never hand out the stored
  chain itself (`capability-chain.test.ts`).
- **`@fabrika/db` is bound by `boot`, once.** An application passes `scoped(tables)`
  as `serve(contract, { database })`. `boot` binds only an object `scoped` created
  (`@fabrika/db/framework`'s `bindScopedDatabase`), with the adapter's connection and
  the runtime's authority, and keeps the locator the bind answers for `on` and `in`. The
  application never receives the connection or the locator; a copy or a wrapper of
  the layer does not boot. A `ContractDatabase` (`tables` and `locate`) of the
  application's own is served as it is and gets no connection.
  `serveContract` and `runContractJob` import `@fabrika/db` before the application (it
  captures its built-ins and freezes the Kysely compiler at load), take `openPostgres` (`@fabrika/db/postgres`)
  then, and open it on `app_<FABRIKA_APP_ID>` as the runtime role `run_<FABRIKA_APP_ID>`, from
  `FABRIKA_APP_RUNTIME_DATABASE_URL` (ADR-0017), with at most `FABRIKA_APP_DATABASE_CONNECTIONS` connections, which a
  Zerops deploy sizes from the database's limit (ADR-0043; 10 without it, a value outside 1–100 is a `BootError`).
  Handed the provisioning credential `FABRIKA_APP_DATABASE_URL`
  instead, both are launchers: they load no application module, derive the runtime URL (`applicationRuntimeUrl`) and
  run the same command again without the provisioning credential (stdio inherited, signals forwarded, exit code
  propagated; `launcher.test.ts`), after making themselves non-dumpable (`src/undumpable.ts`, `prctl` through
  `bun:ffi`) so the application cannot read their `/proc/<pid>/environ`. Never load application code in a process that holds it, and never open the layer
  on it. On Cloudflare the application's object opens `openSqlite` (`@fabrika/db/sqlite`) over its own
  `ctx.storage` (see "The Cloudflare runtime"). No connection or a layer bound before boot is a `BootError`.
  `boot.ts` imports only `@fabrika/db/framework` at runtime (browser-safe), because the Worker adapter
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
  container grants (`{ dimension, values }` per container on the chain) and the contained
  grants (`contained`: the action's grants on dimensions inside the `over` dimension, the
  listed resource's own included, S4), and the data layer matches each against the row's
  own key or chain columns in the same statement, so a list returns what a single read admits.
  Never expand a container grant into values: a scope moved out after the check would
  stay reachable. A `Within` over `MAX_WITHIN_VALUES` values in total is refused at mint
  (`CapabilityLimitError`: 403 to the caller, one log line).
- **`app` is the action held as a global grant, and the proxy alone decides it.** `{ action, app: true }` (an RPC
  procedure or an SPA; never a link procedure or an export, whose v1 reads one dimension) compiles to `{ form: 'app' }`,
  which `satisfies` meets only with an entry without a scope, so a scoped holder is the proxy's 403. `#access` reads
  nothing and mints `ctx.app` (`AppCapability`, `mint.app`); `ctx.db.app` (`endpointData`) holds every application
  table (`scope: { app }`) and, read-only, every dimension and child table whose read action or `appRead` holds the
  action, with the columns of that action (`count` only for an `appCount` action). It has no
  `ctx.members`, `ctx.links` or delegation. Never add a check of the grant's scope here: the requirement is the check.
  An `on`, `in` or `over` endpoint's `ctx.db.app` is built from its `Ref` or `Within` (`endpointData`): every
  application table, read-only, read where the endpoint's action is the table's read action.
- **An `attachment()` output answers a file, encoded by the framework only** (`implement/attachment.ts`). Its value
  is the zod schema of the rows' array, marked (`attachmentOf`), so the handler's types, projection and validation are
  a list's; `describeContract` describes it as that array beside `attachment`, and `buildArtifact` writes the row's
  `output` as an `AttachmentShape` (format, fixed file name, limits within `ATTACHMENT_LIMITS`, scalar columns in
  order), refused nested in a schema, as an input and on an export. `dispatch` hands the handler's result to the encoder
  unprojected: it checks the row count before it reads a row, then projects, validates and encodes one row at a time,
  each field counted against `maxBytes` before the next is read, so neither a long result nor a wide row is copied
  or built past a limit. It encodes **before** the invocation commits, so an audited export (a mutation that writes
  its log row) keeps the row only with its file. Every text cell that starts with `=`, `+`, `-`, `@`, a tab, CR or LF, also after leading whitespace,
  or their full-width forms, gets a leading `'` before RFC 4180 quoting; a number keeps its sign. Rows over
  `maxRows`, a cell over `maxCellLength` and the first field past `maxBytes` (UTF-8, counted field by field) are
  `ServerFault`s (`attachment_rows`, `attachment_cell`, `attachment_size`): a 500, no file, a rollback. An XLSX
  (`xlsx.ts`) keeps the same bounds, every other part and header counted in `maxBytes` from the start, and writes every
  text as an inline string, never a formula; keep it free of a dependency and of Bun APIs, as the Worker adapter serves
  it too. The answer
  takes the header policy like any procedure (the proxy applies it there too); `Content-Type` and the
  `Content-Disposition` of `files/treatment.ts`'s `contentDisposition` stay. The client's attachment procedure is
  not a function: `download(api.<procedure>, input)` posts, saves the file in a browser and answers it as a `File`.
- **Every handler's `ctx.signal` ends with its request** (`handlerSignal` in `bounded.ts`): the request's own signal
  (the client left, the runtime closed the connection) or `REQUEST_BUDGET_MS`, which equals `Bun.serve`'s default
  `idleTimeout`. A procedure commits only while it is live (`request_cancelled` otherwise). A webhook delivery gets one
  too, but commits regardless: its delivery key already decides a redelivery. The skill's rule that an endpoint the
  generated tests cover calls no outside service (an outbox row and a job instead) is what keeps those cases, which
  boot without the application's variables, at 200 (`outbox-rule.test.ts`).
- **Output is projected, then validated:** `project` walks the output's zod schema
  and keeps the fields it declares; a union takes the first branch, in order, whose
  schema accepts the value reduced to it. The strict output schema then validates
  the result. No accepting branch, or a refused value, is a 500.
- **One error envelope**, `{ error: { type, message, issues? } }`. A client error
  (4xx) keeps its message and issues; `@fabrika/db`'s `NotFoundError` and
  `ConflictError` are read by `name` (404, 409). Every 5xx and every refused
  capability answers the fixed `Internal error` (or `Service unavailable` for 503)
  with no metadata, because a message may quote a connection string.
- **A 5xx is reported as a fixed code** (`implement/failures.ts`): `framework_fault`, `unavailable`,
  `capability_refused`, `query_refused`, `handler_status` (a thrown 5xx status) or `handler_failed`, chosen by
  `instanceof` against the framework's own classes, never by `name`. The server log gets one line,
  `fabrika: <endpoint>: <code>`, plus a framework failure's `reason` and its fixed catalog text (`SERVER_FAULTS`,
  `CAPABILITY_REFUSALS`, `@fabrika/db`'s `QUERY_REFUSALS` and `CAPABILITY_ERRORS`, whose `CapabilityError` is
  `capability_refused` too); never a message, which can quote request data, and nothing
  of any other error, its name included. Each of those classes takes its reason first: a new failure picks one. Every other runtime
  log line follows the same rule: a failed webhook delivery logs `delivery_failed`, a file cleanup or sweep the step that
  failed (`object_delete_failed` …), a job its failure code; none interpolates an error, its name or message, or a
  request value. With an Operations DSN it is also one `RequestFailed` event (logger `fabrika.requests`): fingerprint
  `fabrika-request-failed`/endpoint/code, tags endpoint, code, reason, status and the proxy's request id when it is a bounded
  token, at most `MAX_FAILURE_REPORTS_PER_MINUTE` per process and minute. Never the input, a header or a row. The
  delivery is not awaited; the Worker adapter hands it to `waitUntil` (`ContractApp.fetch(request, exec)`).
- **A report carries what was thrown, scrubbed; a log line never does** (ADR-0059). `OperationsReport.error` is sent
  before the framework's own exception, which stays last so the fingerprint and the title do not change
  (`jobs/exception.ts`): the type (an identifier `name`, else `Error`), the message, frames parsed from Bun's and V8's
  `stack`, causes. A framework failure (`failureReason` is not `null`) sends its reason and catalog text, never its
  message. Every text passes `environmentScrubber` (`jobs/scrub.ts`) first: every `FABRIKA_*` value except the
  public ones in `PUBLIC_FRAMEWORK_VARIABLES`, application variables whose name matches `SECRET_NAME`, URL
  credentials of either, and the credential patterns. Caps: `MAX_MESSAGE_LENGTH`, `MAX_FRAMES`, `MAX_CAUSE_DEPTH`,
  `MAX_EXCEPTION_BYTES` (Operations refuses an ingest message above 120 KiB). A new credential the platform hands the
  application is a `FABRIKA_*` variable and is scrubbed by default; keep `PUBLIC_FRAMEWORK_VARIABLES` to values a
  browser may see.
- **A crash is reported only with a DSN, once, and fails as before** (`implement/crashes.ts`). `serveContract` reports a
  startup that throws, then rethrows; once it serves it listens (`ContractServerOptions.crashes`, `process` by
  default), reports the first uncaught exception or unhandled rejection, waits at most `CRASH_FLUSH_MS`, removes its
  listeners and raises the value again so Bun prints it and exits with 1. On Cloudflare the object reports an isolate's
  first failed boot and, once booted, each unhandled rejection (`ContractWorkerOptions.rejections`, the global event
  by default), within the per-minute budget. Listeners start only after a successful boot, so a boot failure is not
  reported twice; a request's and a job's failures are caught before any listener. Tests inject the event source:
  never let a test install a listener on the real `process`.
- **`boot` refuses to start rather than answer nothing**: an SPA or a link mount without an asset server, a link mount
  whose dimension no table owns, a webhook or a procedure with buckets without a `scoped(tables)` layer, a public
  procedure whose challenge names an application variable (its secret or its site key) that is not set, a job that cannot run (see Jobs), an endpoint that asks IAM with no
  membership transport (`BootOptions.membership`), a handler outside the contract, a
  missing handler, an access form whose containment no table locates; on a SQLite database (`sqliteProblems`) a site
  that declares `sql` and a file kind with `scan: true`. Each refusal lifts when its work unit ships the runtime.
- **The framework asks IAM; IAM decides** (`membership.ts`). Every request carries the
  verified token, the proxy's `X-Request-Id` (a delegation grant is bound to it) and the
  proxy's `X-Fabrika-Delegation`; `creates` without one is 503 and IAM is not asked.
  `ctx.members` is management where the action is the dimension's `members.manage` (`endpointMembers`), and elsewhere
  on, in or below a dimension with members the read-only directory of the nearest one, as the artifact records it
  (`directories`, written by `buildArtifact` through `directoryReach`, read by `endpointDirectory`, all of
  `@fabrika/auth-core`): `get(principalId)` of the value the `Ref`'s chain holds everywhere (IAM's `findMember`
  checks the endpoint's own action, one of the dimension's `lookups`, on that value), `list()` only for its
  `members.list` (ids, roles and affiliation; labels only where the dimension declares `directory: 'labels'`, never emails;
  there the label's type is `string` and a null from IAM is the `iam_answer_unlabelled` fault); and
  `ctx.links` only where the `Ref`'s action is a link mount's `issuedBy` for its
  dimension: the types (`ContractContext`) and `facilitiesOf` in `boot.ts` decide the
  same, so change them together. A `Ref` passed to IAM must be this request's, for the
  endpoint's own dimension and action. A webhook gets neither; a job gets `ctx.links` only as Jobs says. A directory
  does not need the transport to boot: without one only its `list()` and `get()` calls answer 503.
- **A link procedure re-reads the object's chain on every request** and answers 404 when
  it differs from the chain the key was issued for, so a link stops working once its
  object moves. It admits only a key of its own mount.
- **Revocation takes effect within the token lifetime** (ADR-0022 rule 6): a
  removed member or revoked link keeps access until its cached token expires, at most
  300 s. The framework checks the token, not IAM, per request; never add an IAM call per
  request to close that window.
- **The share SPA's bootstrap is the document's first script.** `withBootstrap` inserts
  `<script src="<prefix>/__fabrika-share.js">` right after `<head>`, so it runs before
  every module and every telemetry script; it removes the fragment and keeps the key in a
  closure (`shareKey()`). Never serve the key anywhere else, and never read
  `location.hash` in application code.
- **The anonymous kinds read no token.** A public procedure runs its handler as the endpoint's own workload; a webhook
  as the webhook's. Their body limit is enforced while reading (413), because the proxy never sees a body.
- **A procedure's buckets are charged before its body is read and stay charged whatever follows** (`#admit`,
  `bucketsOf` in `public.ts`): each take is one statement of `@fabrika/db`'s `Admissions`, keyed by the endpoint id
  (`PUBLIC_MUTATION_RATE` holds a public mutation's defaults), never a counter in the process; `bytesPerHour` reserves
  the body's declared length. The client is `clientBucket`: `X-Fabrika-Client-Ip` only, an IPv6 address by its /64,
  kept as a digest; never read another forwarding header. Admission is not authorization.
- **`ctx.kick` sends its jobs only after the commit, and the answer never depends on it** (`#kickAll`): each declared
  job once, to the request's `waitUntil` or detached, never rejecting, and nothing for a refused, rolled-back or
  cancelled request. The kicked run is the job's own (its key, its lease, its retries), never the request's. Never
  await the kick, and never give it a payload: the job reads its rows.
- **A public procedure's challenge is verified after its buckets and its body, before its handler, and recorded once it
  passed** (`challenge.ts`). The provider list is closed (`turnstile`, `altcha`) and each one's browser sources are
  fixed (`CHALLENGE_ORIGINS`: Turnstile's origin, which `buildArtifact` adds to `scriptSrc`/`frameSrc`; ALTCHA's
  `blob:` workers, which it writes as `csp.workerSrc`, a directive no contract declares). The record keys on
  the passed verdict's `replayKey` for its `recordMs`: the token for Turnstile, the challenge's signature for ALTCHA,
  whose one solution can be spelled as many tokens. Never key the record on an ALTCHA token. Turnstile's siteverify gets one deadline for the call and the
  body (`CHALLENGE_LIMITS`), a byte budget and no redirect; it passes only `success` for the request's host, the
  widget action the artifact records (`challenge.action`, by default `challengeAction` of the endpoint id; `buildArtifact`
  refuses one two procedures share) and a fresh `challenge_ts`. A token the visitor got wrong is 400
  (`challenge_failed`), as a 0.5 form answered; an unreachable provider or one that refuses the secret is a 503
  `ServerFault`. A passed token's digest is recorded under the action (`recordChallenge`): a second use is a replay,
  whatever the provider answers.
  Only `devKit` exempts one token (`repeatableChallengeToken`, Turnstile's test-widget token, which never changes);
  never set it outside `app dev`. The secret is the application variable the contract names (`challenge.secret`), read
  by `boot`, which refuses to start without it; never put the value in the contract or a log.
- **An ALTCHA challenge is the application's own, issued at a row the build adds and verified in process**
  (`altchaChallenge`). `buildArtifact` writes, beside each such procedure, the row `<endpoint>.challenge` (source
  `challenge`, `GET /__fabrika/challenge/<action>`, the procedure's `crossOrigin`, no body or schemas) with its own
  buckets (`CHALLENGE_ISSUE_RATE`), and `contractArtifactSchema` refuses a challenge without exactly that row, a row
  without its challenge, and `workerSrc` without either; a `challenge` row is no workload (`declared` holds no
  actions for it). `boot` serves it as the `challenge` kind beside the procedure: the anonymous share, its buckets,
  then a challenge signed over its parameters (the contract's `cost` and `maxAgeMs`, the action and the request's
  host). Verification reads the payload strictly (exactly the parameters `issue` signs; the widget's `test` payload
  and a server-signed one are refused unread), checks the action, the host and the expiry, then the two HMACs
  `verifySolution` computes with keys derived from the variable for each use. Its verdict carries the replay key
  and retention through the signed expiry plus clock skew, even after a deploy reduces `maxAgeMs`, so the payload is
  read once. It never makes a network call, so it has no `unavailable`. `boot` refuses a key under
  `ALTCHA_LIMITS.minKeyLength` (every challenge publishes a signature a short key could be guessed from); the build
  refuses a `cost` a slow phone would not solve in time (`altchaSolvable`); the counter is drawn from 1, so no solver
  skips attempts the widget makes; the issuer's buckets are at least twice the procedure's (`challengeIssueBucket`) and
  `CHALLENGE_PREFIX` is reserved; the widget's `footer`, which it renders as HTML, is no prop of `Challenge`. Only `BootOptions.challengeWork` (the kit's and `devKit`'s `MINIMAL_CHALLENGE_WORK`) lowers the
  work; never set it in a runtime adapter. `challengeUrl(api.<procedure>)` (`@fabrika/app/client`) is the one place a
  page learns the path, from `declaredChallengeAction`, the build's own rule; `@fabrika/ui/challenge` renders the widget.
- **A webhook's verifier is framework code** (`verifiers.ts`): a preset (`github-sha256`, `slack`, `standard-webhooks`,
  `stripe`, `twilio`), an `{ hmac }` shape, or `{ basic }` / `{ bearer }`, over the raw body, a signed timestamp within
  `WEBHOOK_TIMESTAMP_TOLERANCE_MS`. Twilio signs the public URL: the delivery's `url` is `FABRIKA_APP_ORIGIN` and the
  raw request target, never the `Host` header. A `basic` or `bearer` row declares `authorization: 'forward'`, the only
  way `Authorization` reaches an anonymous endpoint (ADR-0022 rule 3), and a value carrying `px_` never does, so
  `setSecret` refuses such a secret. Only `github-sha256` checks the account the payload names.
- **A signed token is verified as its input is parsed** (`implement/tokens.ts`): only a top-level field of a procedure's
  input or `http.query` carries one (`buildArtifact` refuses it anywhere else, an export included). The HMAC covers the
  key id, the purpose, the expiry and the claims; the claims are parsed again by the purpose's schema. The keys are
  `FABRIKA_TOKEN_KEYS`, the signing key first; a retired key stays there while a token it signed may live (Control).
  The texts a verified token carries are the only absolute redirect targets a request may name besides the listed
  origins. A token is no credential: it opens no mount.
- **While a staged-kit site's handler runs, the global `fetch` reaches only its `egress`** (`implement/egress.ts`):
  `boot` wraps `fetch` once, and `runAsSite` scopes each handler. A framework facility a handler calls (mail, a
  connector, IAM, the object store, the JWKS) runs through `platformCall`/`platformFacility`, outside the site's scope;
  a new facility that makes its own requests must too, or every site that uses it needs an egress it never declared.
  It is no sandbox: code that kept the `fetch` it found before boot, or opens sockets, escapes it.
- **A webhook's `limits` bound its body and its handler** (`WEBHOOK_LIMITS`): `maxBytes` (1 MiB by default and at most)
  is its row's body limit, read within the deadline `bodyDeadlineMs` derives from it; `timeoutMs` (10 s, at most 60 s)
  is its handler's, which the artifact records on the mount and the delivery claim's lease outlasts.
- **A binding is written by a procedure that declares `binds: '<webhook>'`** (`webhookBindings`): `ctx.webhooks('<name>')`
  names only that webhook, `.bind(capability, account)` and `.unbind(capability, id)` take a capability of this
  request on the bound value (a `Ref` of the webhook's dimension, an `AppCapability` for `'app'`) and run in the
  procedure's transaction. A webhook bound to `'app'` has one row per binding with the scope `APP_BINDING_SCOPE`; its
  handler mints `ctx.app('<action>')` for a declared action, as a job does, and holds no `ctx.refs`.
- **A webhook delivery is checked in a fixed order**: binding (404), signature over the
  raw body with that binding's secret (401), account (403), input after dropping every
  undeclared field (400, `project` then the strict schema), the webhook's credential (503:
  IAM refused or could not sign its key, or the token lacks a declared action), delivery
  key. The credential is asked before the key is recorded, so GitHub redelivers a delivery
  that could not run. Never verify the signature after parsing.
- **Replay protection keys on authenticated content only**: the delivery key is
  `sha256(bindingId ‖ raw body)`, kept per binding for `WEBHOOK_REPLAY_RETENTION_MS`
  (30 days). `X-GitHub-Delivery` is unsigned, the caller's word: it decides nothing and reaches no log line. A redelivery of one event therefore has the same key and is ignored.
- **A webhook handler is at-least-once, and a delivery is recoverable.** The key is claimed before the handler runs,
  outside its transaction, under a lease of the handler's time limit plus `WEBHOOK_CLAIM_GRACE_MS`; a copy that finds
  the claim held is answered as received at once, without waiting. The handler's transaction completes the claim
  (clears the lease, fenced by it) right before it commits, so the work and the completion commit together. A failure
  gives the claim back, so the provider's redelivery runs it again; a crash before the commit leaves the claim to expire,
  and the next redelivery takes it over. A completion that finds its claim taken over fails the delivery
  (`webhook_claim_lost`) and commits nothing. A row without a lease is a completed delivery, as every row an older
  release recorded is. The handler gets the key as `ctx.delivery.key`; idempotent writes key on it (or use
  `insert(…, { onConflict })`). Never move the claim into the handler's transaction (a concurrent copy would wait on
  it), and never complete it outside that transaction (a crash between the two would lose the delivery).
- **A staged-kit site runs in its invocation's transaction** (`invocation.ts`). `serve` puts each site
  into the handler tree as `siteHandler(handler, declared)`; `boot` parses the leaf's declaration (a query's `'write'`, a
  table outside `src/db/tables.ts` and a `fabrika_*` table are `BootError`s) and runs the site with the approved
  artifact's (`approvedDeclaration`: by endpoint id or `job:<name>`, under the contract's digest), refusing a leaf whose
  declaration differs, filters `ctx.connect` to the declared connectors
  and `ctx.links` to the declared mount, and refuses a site without a `scoped(tables)` layer. `dispatch` opens an
  `Invocation` per request (`READ ONLY` for a query and an export), builds `ctx.db` by the access form
  (`endpointData`), ends the frame when the handler returns, validates the output, and only then commits; a throw, a
  refused output or an aborted request rolls back. A request, a public procedure and a webhook delivery run from the
  handler to the commit inside `Invocation.enclose` (`enclosedAnswer`): on SQLite the Durable Object's transaction
  encloses the handler, whose own I/O would otherwise wait for the transaction to end (`@fabrika/db`'s
  `InvocationTransaction.enclose`); on Postgres it only runs the work. Kicks run after the enclosure, and a failed
  COMMIT still cancels a file answer's object stream. Every handle checks `boundTo(frame)`: a handle kept past its
  handler, or called from another request or another `boot`, is a `CapabilityRefusedError`. `ctx.sql` runs only on
  a site that declares `sql`: `Invocation.sql(mode)` (a job's `tx.sql`: `jobSql`) asks `@fabrika/db`'s `DataAccess.sql`
  for the tag over the same session as the site's handles, bound by `boundTo` too. On a site without `sql`, `ctx.sql`
  (`tx.sql`) is `undeclaredSql`, which only refuses with `undeclared_reach` and names the declaration, and a declaring
  job's `ctx.sql` outside `ctx.transaction` is `jobSqlOutsideTransaction` (`sql_outside_transaction`), so an untyped
  call is no `TypeError`.
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
  Cloudflare object also keeps the `IAM` and `ASSETS` bindings from `deps`.
- **`handlers` is a function of what `deps` returned.** TypeScript cannot infer
  `deps`' type into `ctx` through the contract's conditional handler types, so a
  handler reaches its dependencies through that closure, not `ctx.deps`.
- The handler type witnesses live in `src/__tests__/implement-mistakes/` (the
  parser spike's 05–10), compiled by `implement-types.test.ts` like the contract
  mistakes. `implement-scale.test.ts` keeps 200 handlers under the same budget as
  `contract-scale.test.ts`; both generate their source in `scale-fixture.ts`.
- **An export is served read-only.** Its procedures are handlers under `handlers.exports.<export>`,
  each run in a `RequestFrame` with `readOnly`; `boot` binds the data layer with `requestIsReadOnly`, so
  `@fabrika/db` refuses every write and lock in that request and reads `READ ONLY` — the access check's
  locator and the framework tables included, because every session asks the runtime. `buildArtifact`
  refuses an export procedure whose action a table writes with or that manages a dimension's members. An export's context carries its
  capability only: no `ctx.connect`, no membership or file API.
- **An export's callers are its consumers' `app:<id>`, and only an export row has one.** `RpcCaller` has no
  `app:<id>`, and `buildArtifact`, the reader and `parseContractArtifact` refuse one on any other row.
  `schemaFromContract` declares each consumer as an `app` workload holding the actions of the export rows it may
  call: what the key Control issues for that consumer resolves to at IAM. `presentedBy` gives an `app` token an
  `AppPrincipal`. An export procedure names its action: `{ member: true }` would give the consumer's key no action
  to hold, so the types (`ExportAccessDeclaration`), `buildArtifact`, the reader and `parseContractArtifact` refuse
  it. `<export>.v<n>` (no procedure) serves the export's description, the
  schemas and digest a consumer vendors, to the same callers and with the same requirement as its
  procedures: v1 exports declare one action in one dimension for every procedure, and `buildArtifact`
  refuses one that does not. Never give the description a weaker requirement.
- **`ctx.connect` exists only in the handlers an import's `usedBy` names**, both in the types
  (`ConnectContext`) and at runtime (`wireImports`). Its methods are built per request
  (`connectContext`) and bound to that `RequestFrame`: one kept past its request, called from another
  request, from an export's request or from an endpoint the import does not name answers `denied` and
  sends nothing. The kit's imports (`defineApp(vocabulary, tables, { imports })`) carry the vendored snapshot
  of each import; `boot` refuses one whose app, export or version differ, whose digest is not the
  import's, whose schemas no longer describe to its own digest (edited), or that lacks an imported
  procedure, and an import without `FABRIKA_CONNECT_<IMPORT>_URL` (an http(s) origin, no credentials)
  and `_KEY` (a `px_` key). Both are `FABRIKA_*`, so the application never reads them; Control writes them
  (`connectVariables` in `@fabrika/auth-core` names them). A connector validates
  against zod schemas the framework builds from the checked, deep-frozen description (`schemaFromShape`),
  never against the snapshot's own schema objects, which application code could replace after `boot`.
- **A connector call never throws for the owner's answer.** It validates the input against the
  snapshot (`invalid_input`, nothing sent), posts to `<origin>/__fabrika/connect/<export>.v<n>.<path>`
  with the edge key as the bearer, and answers `ok`, `denied` (401/403/404), `invalid_input` (400),
  `unavailable` (408, 429, 5xx, network, any 3xx: `redirect: 'manual'`, never followed), `timeout` or
  `contract_violation` (an answer that is not `application/json`, is larger than
  `CONNECT_LIMITS.maxAnswerBytes`, is no JSON, or that the vendored output schema refuses; logged once). A
  message names a fixed code and the path as the vendored schema declares it (`declaredPath`), never a
  record key or anything else the owner wrote, and the edge key is cut out of every message regardless.
  The deadline aborts the fetch and cancels the body reader (`readBoundedBytes`). The import's
  `timeoutMs` (3 s by default, at most 10 s, `CONNECT_LIMITS`) bounds the call and its two retries on
  `unavailable` and `timeout`; the remaining time is shared by the attempts left.
- **On Cloudflare a `FABRIKA_CONNECT_<IMPORT>` service binding carries the call** (the deployer generates
  it; the Cloudflare object keeps it from `deps`); the request URL names the owner's host, which its proxy Worker
  selects the application by. `connect-binding.test.ts` pins in Lopata that a binding routes by the binding,
  and that the consumer's app key reaches the owner through it. Without a binding the call uses `fetch`.
- **`incompatibleChanges` (`contract/connect.ts`) is the rule Control applies to an owner deploy.** Over the
  procedures a consumer imports, a removed procedure, less accepted input, any output change and a changed
  audience break the edge; an output may not gain a field, because `schemaFromShape` builds strict objects.
  `incompatibleMountChanges` applies the same rule to every procedure of an RPC mount whose approved artifact says
  `compatibility: 'backward'`, and adds its query, HTTP shape, file answer and access. It reads the approved side's
  promise, so the publication that drops it is still held to it.
- The header policy and the file treatment are ADR-0022's, defined once in
  `@fabrika/proxy-core/headers`; `headers.ts` and `files/treatment.ts` only apply them, and the
  proxy applies the same definition. Never restate a header value here. A public GET query's `http.cache` turns its
  200's `Cache-Control` into its lifetime (`applyAnswerCache`), in-process and in the proxy; the row carries it.

## Stored files

- **A file is a value in a table column** (`files/kinds.ts`, `@fabrika/db`'s `stored-files.ts`): `c.files({ types,
  maxBytes, scan? })` declares a kind, a table's `files: { <column>: '<kind>' }` a column of it, and the table's actions
  are the file's authority. The framework generates no file endpoint; a procedure takes a file (`file('<kind>')` in its
  input) or answers one (`file('<kind>')` as its output), and the dispatcher checks it like every row first.
- **The pending row is written before the object and is the cleanup intent**, on a connection of its own, never the
  handler's transaction. A known rollback deletes what the request staged (`StoredFileKinds.release`), and so does a
  job's `ctx.transaction` the job threw out of (from its `FileWork.mark`); after an uncertain outcome nothing is deleted
  and the sweep decides from the database, past `FILE_PENDING_GRACE_MS`. Never write an object without a row first.
  On SQLite there is one database, so the pending row is written in the work's own transaction and rolls back with it:
  the work records each object it wrote (`FileWork.wrote`), and a known rollback deletes an object whose row is gone
  (`writtenKey`).
- **Every answer of a file output carries the file treatment**, denials and errors included: `ContractRuntime.fetch`
  chooses it by the planned endpoint's row, and a file is a `FileDownload`, never a `Response`, so no handler or store
  can set its headers. Keep the treatment equal to ADR-0022's.
- **The type is the sniffed one.** A file is stored only when its first `SNIFF_BYTES` are the declared type, and the
  recorded type is what a download sends. The size bound is the object store's (`FileObjectStore.write`), enforced
  while the body streams.
- **`ctx.files` is `put` and `open` only** (`storedFilesHandle`): `open` reads a live file whose reference this request
  holds and may read (an input file, a put, or a file column read under its table's read action), and refuses any
  other (`wrong_capability`). A query creates no file. Never read a file by its id alone.
- **The sweep job is a framework job** (`FILE_SWEEP_JOB`, hourly, `StoredFileKinds.sweep(signal)`): it deletes the
  files no declared column references once past the grace, row and deletion record first, object after, in bounded
  batches. `@fabrika/provider-zerops` mirrors its name and schedule (`ZEROPS_FILE_SWEEP_JOB`); change both together.
  `serveContract` opens the object storage from `FABRIKA_APP_STORAGE_*` (all or none). Never return a storage URL or
  presign one.
- **Only a completed clean verdict promotes a file** (`scan.ts`). A file of a `scan: true` kind is
  `quarantined`; a byte consumer answers 409 `file_not_ready` until the scan job writes `live`, and 409 `file_rejected` once `rejected`. The pass reads each
  object whole, checks its size and SHA-256 against the upload's and checks it as an archive (`archive.ts`) before the
  scanner sees it, and promotes only a file the scanner called clean whose bytes verified; an empty upload is refused
  (400 `empty`), so no file skips the scanner. Never add a
  path that makes a file live without that, or that treats a scanner error, a timeout or a missing verdict as clean. A
  rejection deletes the object before it writes `rejected`; a failed delete leaves the file quarantined and defers it
  like a retry (`deferScan`), so failing deletes never fill every batch.
- **ClamAV's OK never vouches for an archive.** `checkArchive` admits a ZIP only when every entry, nested ZIPs to one
  level included, is stored or deflated, unencrypted, CRC- and size-consistent and laid out without gaps, within the
  entry and unpacked bounds; every other archive format is refused, at the top or inside. ClamAV finds a ZIP by its
  local header at any offset, so the rule is coarse and fail-closed: a ZIP-based type (`ZIP_TYPES`) starts its local
  header at offset 0, any other file or entry holding a ZIP signature anywhere is `embedded_archive`, and a second end
  record in the tail or a comment that does not end the file is `ambiguous_directory`. The rare false rejection of a
  binary file is accepted; never replace the rule with an emulation of ClamAV's parser. Keep it a framework check:
  never rely on a scanner flag for it.
- **A download of a scanning kind serves only the scanned version** (`FileObjectStore.readVersion`, one
  conditional read): a mismatch, or a live row without a version, answers 409 and quarantines the file again. Never
  read the object by key alone for such a file.
- **A file without a verdict is retried, alone, with backoff** (`deferScan`, `SCAN_LIMITS.maxAttempts`): the batch
  takes the due files that waited longest first (`dueSince`, across every scanning kind) and scans a file that
  failed before on its own, so neither old failures nor a busy kind starve anything. Installation failures (no scanner, missing or stale signatures) count no try.
- **A verdict is written only under the scan job's lease.** `StoredFiles.promote`, `reject` and `deferScan`
  refuse to run without a fence and are one conditional update each (still quarantined, same digest), so a pass that lost its lease or timed out, or a file removed meanwhile, changes nothing. The scan job is
  a framework job of `bindJobs` (`FrameworkJob`): a reserved name with `-`, which no `c.cron` name can take, no handler
  and no key; the runner refuses its writes before it signals the run to stop.
- **The scanner comes from the runtime adapter.** `runContractJob` passes `clamscanScanner()` (ClamAV on `PATH`), which
  runs with only `PATH` in its environment, its own limits alerting (`--alert-exceeds-max`, `--alert-encrypted`), and
  `--fail-if-cvd-older-than=3`; one deadline covers opening and writing the objects, the run and the cleanup, and no
  scanner is spawned once it passed. `clamscanVerdicts` reads only an exact `<path>: OK` as clean. `boot` without a
  scanner still serves: the scan job reports `scanner_missing` and leaves every file quarantined.

## The typed client and the test kit

- **`createClient` builds its tree from the contract value**, never a `Proxy`: only
  declared procedures exist, and each path comes from `joinPath` and
  `LINK_API_SEGMENT` in `contract/defaults.ts`, the code that gives the artifact its
  paths. Never compute a procedure path anywhere else.
- **A file procedure's client answers a file handle** (`download(api.x, input)`, `api.x.url(input)` for a GET one);
  the client never imports `files/`, which the examples' SPA bundle test refuses.
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
  same table for every credential on every kind of path. The kit's IAM is `kitMembership`
  unless a test passes `options.membership` (an `IamMembershipRpc`): either one is both the proxy's delegation issuer
  and `boot`'s membership transport. `kitMembership` answers the writes under IAM's rules for the caller's grants and
  records them; a role it gives or removes is live, in its directory and in the next token the kit signs
  (`permsOf`), as in IAM. `kit.acceptInvitation` closes an invitation it holds and gives its role. The endpoint
  access kit (`standInIamKit`) keeps a handle on it to seed what a case names. On Bun the transport is
  `HttpIamMembership` (`@fabrika/auth`) on `FABRIKA_IAM_RPC_URL` with the environment's own
  `FABRIKA_IAM_RPC_KEY`, both written by the platform; on Cloudflare the `IAM` binding.
- `options.database` is the connection `boot` binds a `scoped(tables)` database to, as
  the runtime adapter supplies it; the kit compiles the artifact exactly as `boot` does.
- The kit stands in for Control and IAM for workloads too: each job and webhook gets a random `px_` key, and the
  kit's token exchange signs its declared actions for it, with the kit's own key. A job's key and the tokens signed for
  it are its credential at `kitMembership`'s link operations (`jobByCredential`), held to IAM's rules for a job: its
  declared actions app-wide, issuing for its declared `issues` mount only, revoking only links it issued; every other
  membership call of a workload answers `invalid_token`, as IAM's `resolveCaller` does.
- `options.connect` wires each import to an owner: its origin, the edge key, and the `fetch` that reaches
  it — usually the owner kit's own `fetch`, so the call meets the owner's real proxy decision. The owner kit's
  `testCaller(grants, { kind: 'app', app })` is the consumer's key: an `app` token naming the consumer.
- Its tokens are signed with a generated key and verified by the application's own
  verifier, so a test cannot reach a handler the production pipeline would refuse. A human caller's token carries
  its `email` (`PersonTestCaller`), normalized as IAM normalizes it; the stand-in directories answer that address.
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
  compiled by `client-types.test.ts` like the contract mistakes; the hooks' witnesses (`15`–`21`) too.
- **A client keeps what each value is beside it** (`clientNodeOf`, a `WeakMap`): a procedure's mount, path, type and
  input schema, a group's prefix. A procedure function also carries its output schema as `output` (part of
  `ProcedureCall`'s type), which `coversTree` checks.
- **`@fabrika/app/react` names a call by a client procedure and runs it on the provider's client of that mount**, so a
  test hands the provider a client over the test kit. Every answer is read back through the procedure's `output`
  schema, never cast; a cached value the schema refuses is an error. A procedure's input is checked with its own
  schema before it is sent (a refused one is a 400 `validation` `RpcError`, unsent). `toFabrikaError` reads the
  refusal structurally (`httpStatus`, `type`, `issues`, `loginUrl`), never by `instanceof`. A mutation invalidates
  its own group unless `invalidates` says otherwise; an invalidation refetches the entries a view shows and forgets
  the rest. `useCaller` and `<Can>` read the caller document and decide nothing.
- The hook tests are DOM tests (`src/react/__tests__/*.test.tsx`, happy-dom through `dom.ts`, which keeps Bun's
  `fetch`): run them with `bun test --isolate src/react`. The root `bun run test` runs them in `test:dom`.
- **The generated tests' kits (`@fabrika/app/testing/isolation`) add no second pipeline.**
  `policyIsolationKit` defines a probe contract over the application's vocabulary whose
  procedures each run one operation of `@fabrika/db/testing`'s `tableProbe`, served by
  `testKit` on a `scoped(tables)` layer of its own: it proves the policy, not the
  application. `endpointAccessKit` boots the application's own `serve(…)` through
  `standInIamKit`, once, because the application's layer binds once per process, with in-memory object
  storage: `kit.file` seeds one file per scope through the real upload endpoint. Its cases are `denied` (exact 404/403),
  `leaked` (`{ answered, leaked }`: answered unless a 401, 403, 404 or 5xx, so a precondition's 409 passes; `in`
  across every table that lies in the dimension), and `own` (a caller with only the endpoint's action, or a link
  holder, reaches its own object; on an endpoint that manages members, also on the target's value one assigning role
  and the actions of the roles its input names, and on one that issues links the actions they grant, as IAM requires); each takes the author's seed, the state
  `seedWorlds` writes into both rows. `leaked` and `own` also take the author's application rows (`appRows`), which
  `seedApplicationRows` writes before they ask and removes, with every row that refers to them, once the case and the runs
  it kicked are over; both scopes may see them, so their values are never counted as the other scope's. An `app` or `creates` procedure gets `scoped` (a holder of the action in one
  scope: exactly 403, from the proxy or IAM) and `global` (a global holder: answered unless a 401, 403 or 5xx), and an application table `appPolicyIsolationKit`, whose probe procedures are
  `app` endpoints over one row `seedRow` writes. A leak scans every value of
  the other row's chain, so an outer dimension's value is a leak too. A subpath of its
  own, because it loads `@fabrika/db/testing` (Bun SQL, the migration runner) and the root
  kit does not. Its API is what `fabrika db test-scaffold` writes against: a change
  regenerates `packages/cli`'s fixture tests, `examples/zerops-app`'s and `packages/check`'s `architecture-app`.
- **`testKit(…).runJob(name)` runs a cron job once** through `boot`'s own job runner (`application.jobs.run`): its
  lease, its key's signed actions, its fenced writes. A `link` test caller binds its key with `{ link: { mount, chain } }`.
- **The generated tests catch mistakes; the data layer is the enforcement.** They catch what an
  application's author, usually an agent, gets wrong. A deliberately hostile author runs in the
  same process and can always subvert them. Never rely on them for a guarantee `@fabrika/db` or
  the pipeline does not give.
- **The generated tests register through captured runner functions** (`testing/runner.ts`).
  `@fabrika/app/testing/preload`, which `fabrika db test-isolation` preloads, captures Bun's
  `test`, `describe`, `expect` and `afterAll` in a non-configurable global before any
  application module loads; without it the module's own import is used. A case that ran no
  `expect` fails. `endpointAccessKit` fails a case whose input the endpoint refuses (400) and
  counts a text marker of the other scope's rows as a leak, wherever it is in the answer.
- **The test kits refuse a serving process.** The generated entrypoint calls
  `markProductionProcess` (`@fabrika/db/production`, re-exported by both adapters) before it
  imports the application; `@fabrika/app/testing*`, `@fabrika/db/testing` and `@fabrika/db/testing-sqlite` then refuse to
  load, and `testKit` to run. `boot` does not mark: `testKit` and the adapter tests call it
  in-process. `generated-entry.test.ts` runs the entrypoint with each kit.

## The Cloudflare runtime

An application environment runs in one Durable Object
([ADR-0065](../../docs/decisions/0065-an-application-on-cloudflare-runs-in-one-durable-object-per-environment.md)).
`cloudflare-runtime.test.ts` runs `cloudflare-fixture/` in Lopata; `cloudflare-runtime-adapter.test.ts` constructs the
object directly over `bunSqliteStorage` (the IAM binding, the assets, the crash reports).

- **The generated Cloudflare entry exports `FabrikaApplication` and the Worker.** `fabrika app build` writes
  `fabrika/entry.generated.ts` and `fabrika/migrations.generated.ts`, the `.sql` files of `db/migrations` by name with
  their text verbatim, so their checksums stay the files'. `createContractWorker(load, { migrations })` registers the
  loader; the Worker's `fetch` removes `X-Fabrika-Tick` (`TICK_HEADER`), sets the proxy secret and forwards the request
  to the object named `application` of `FABRIKA_APPLICATION`; its `scheduled` sends the tick with the `scheduledTime`.
  Without `FABRIKA_PROXY_SECRET` or the binding it forwards nothing.
- **The object answers only its own Worker.** A request without the environment's proxy secret is an empty 404 before
  anything else, the digests compared in constant time, so another Worker that binds the class learns nothing.
- **It boots once per isolate.** The constructor runs the boot in `blockConcurrencyWhile` and settles either way: a
  failed boot answers every request with its failure, is reported once, and is not kept, so the next instance boots
  again. For an application with a data layer, before the boot and for every later instance of the isolate, it applies `SQLITE_FRAMEWORK_MIGRATIONS` and the
  application's bundle through `migrateSqlite`, then binds the layer to `openSqlite` over a storage it swaps per
  instance (the layer binds once). It captures the environment without `IAM` and `ASSETS`, and boots with
  `requireProxySecret`, `clientAddress: 'vouched'` (the proxy Worker sets the client address from `CF-Connecting-IP`),
  the R2 file store (`r2-files.ts`) and IAM's binding for keys, membership and workload tokens (`bindings.ts`).
- **Jobs run on the minute tick.** The object runs every contract job whose schedule `isDueAt` the tick's UTC minute,
  and the file sweep when the contract has file kinds, each in `waitUntil`, then `jobs.check()`; a kick runs in the
  object after its commit. A scanning file kind does not boot there (`sqliteProblems`).
- **Every handler holds the object's transaction.** workerd resets an object whose transaction runs about 30 s, so the
  provider refuses a procedure's or a webhook's `timeoutMs` above 25 s (`CLOUDFLARE_MAX_HANDLER_MS`).

## Jobs

- **A job runs only under its lease.** `fabrika job run <name>` (the crontab's command, `runContractJob` in `bun.ts`)
  captures the environment, boots like the server and takes the job's row in `fabrika_job_leases`. A live lease
  held by another run means this run does not start (`skipped`). Each attempt holds its own generation and a
  deadline the database enforces: `RequestFrame` carries the fence and the runtime's authority answers it (`fence()`), so
  `@fabrika/db` refuses every write of an attempt that timed out, failed or lost the lease, and cancels one still
  running when the attempt ends (`attemptOnce` calls `cancelInFlight` before the runner touches the lease again). A
  retry renews the lease to a new generation before its backoff. Never run a handler outside `attemptOnce`.
- **Lease times are the database's**: the runner passes durations, never a timestamp, so a container whose clock is
  minutes off cannot take a live lease over. `JobClock` has only the waits and the jitter.
- **Kicks coalesce on one shared flag: at most one run and one pending, across instances.** A kick takes the lease
  with `tryAcquire`, which never waits for a lock: it shares the request pool, and a run's attempt holds the lease
  row as its fence while it writes. Without the lease it sets `fabrika_job_kicks.pending` (`markPending`, a row no
  attempt locks) and tries once more. Every run clears the flag when it starts (it covers every kick before it) and,
  after it succeeded, takes it and runs once more, cron runs included; a failed run leaves it for the schedule. A run
  that took the flag but finds a newer run holding the lease sets it again (`handOver`): that run may have read before
  the kick's row. There is no process-local kick state; every kick asks the lease. Never let a kick wait on the lease, and never drop the cron of a kicked job: it is the recovery path. `serveContract` drains
  kicked runs on SIGTERM before it closes the database, and `kit.runJob` waits for them before it runs.
- **A job acts only with what IAM signs for its key** (`implement/workload.ts`, ADR-0022 "Principal kinds"). Control
  writes `FABRIKA_JOB_<NAME>_KEY`; each attempt exchanges it through the adapter's `WorkloadTokenSource` (on Bun
  `issuerWorkloadTokens`, IAM's public `WORKLOAD_TOKEN_PATH`), verifies the token with the application's own
  verifier and requires `ptype: 'job'` and `workload: <name>`. `ctx.within(action, dim)` is a `Within` over every
  value, `ctx.ref(action, dim, id)` a located `Ref`; both refuse an undeclared action, an action the token lacks, an
  unknown dimension and an ended attempt. A refused key fails the attempt `unauthorized`, an unreachable IAM
  `iam_unavailable`; no handler runs. The token is cached until `TOKEN_REFRESH_SKEW_SECONDS` before it expires. The
  grants' principal is `job:<name>`. There is no in-process mint and no unscoped handle; keep no second path. A job
  creates no scope and manages no member. **It issues links only for the mount the approved artifact says it
  `issues`** (`jobLinks` in `runner.ts`, by the artifact whatever the leaf; `boot` refuses one without a membership
  transport): `ctx.links.issue` takes a `Ref` of this attempt for the mount's `issuedBy` on its dimension and asks
  IAM with the job's current token (`WorkloadAuthority.token`) under the attempt's id; `ctx.links.revoke` ends a link
  the job issued. IAM checks the same declaration again, so a job never holds more than it declares. `ctx.links` of an
  attempt that ended asks IAM nothing (`CapabilityRefusedError` `ended`): a replacement attempt may already have acted.
  The check runs again synchronously right before each IAM call, because the token lookup it awaits can outlast the attempt.
- **A webhook's refs come from its key the same way** (`FABRIKA_WEBHOOK_<NAME>_KEY`, one per webhook declaration,
  not per binding: a binding is runtime data no snapshot names). `boot` refuses a job or webhook without its key or
  without a token exchange (`BootOptions.workloadTokens`); the test kit and the harness stand in for both.
- **`boot` refuses** a job scoped to a dimension (per-binding jobs are not built), a job without a bound
  `scoped(tables)` (the lease and the fence live in the application's schema), a schedule `schedule.ts` cannot read,
  a missing handler and a `handlers.jobs` entry the contract does not declare. An Operations DSN that is not an
  ingest DSN stops every boot, jobs or not: no failure would reach anyone.
- **A failure is a fixed code**: `timeout`, `lease_lost`, `handler_failed`, `query_refused`, `capability_refused`,
  `driver_failed`, `crashed`, `unauthorized`, `iam_unavailable` in the run's result, its log lines and its report, and
  `boot_failed` in the CLI. The code is chosen by `instanceof` against the framework's own classes (`LeaseLostError`,
  then `failureCode`, so a refusal is named as a request names it), never by `name`. A refusal also carries its catalog
  `reason`: in the result, in each log line with its fixed text, and as the report's `reason` tag. An application error's
  name and message are never logged or returned: either may carry a secret. The report carries them scrubbed.
- **Reports go through the ingest every application has** (`FABRIKA_OPERATIONS_DSN`): a run that failed after its
  retries, or crashed (its lease expired before it finished, found by the next run or the check), is one `JobFailed`
  error event; a job that has not succeeded within twice its period (from its first-seen time when it never did) is
  `JobMissed`, claimed in the database at most once per period. The serving process (`serveContract`) registers
  every job and runs `jobs.check()` every `JOB_CHECK_INTERVAL_MS`, so a schedule that never fires is reported too.
  Operations ingests error events only, so successes stay in the lease row (`last_status`, `last_succeeded_at`,
  `last_started_at`, `last_duration_ms`) and out of Operations (backlog 96).
- **Job reports are informational, not authenticated.** They travel under the public ingest key, which any holder of
  the browser DSN has, so one can forge a `JobFailed` or `JobMissed` like any other error event. Operations gives the
  `fabrika-job-*` fingerprints no special meaning: no auto-resolve, no state change. The job's key could
  authenticate them, but Operations' ingest would have to ask IAM per event (backlog 96).
- **A staged-kit job reads outside its transaction and writes inside it.** Its `ctx.db` (`siteData` over `'job'`
  handles) reads each statement on its own and refuses every write; `ctx.transaction((tx) => …)` is one transaction
  fenced by the attempt's lease (`DataAccess.transaction`), refused outside the attempt, whose `tx.db` writes and whose
  handles refuse once it returned.
- An attempt is cancelled after its `limits.timeoutMs` (`JOB_LIMITS`: 15 min by default, at most a day), which the artifact
  records as the job's `timeoutMs`; the lease lasts the timeout
  plus `LEASE_GRACE_MS`. Retries back off exponentially from one second, capped at five minutes, half jittered.
- The type witnesses live in `src/__tests__/job-mistakes/`, compiled by `job-types.test.ts`.
