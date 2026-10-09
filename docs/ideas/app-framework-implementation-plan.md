# Application framework and platform enforcement: implementation plan

The implementation plan for two proposals and their companions:

- **Part A — [opinionated application framework](opinionated-app-framework.md):** the contract, the implementation
  API, the [data layer](scoped-database-access.md), [files](app-file-storage.md), [jobs](app-scheduled-jobs.md),
  [connectors](declarative-app-connectors.md), the checker, the skill and the template. It runs on today's platform.
- **Part B — [platform enforcement](platform-enforcement.md):** the proxy, IAM, Control and the providers make the
  same contract binding against an agent that edits any file.

Part A delivers most of the value on its own and goes first. Part B reads the contract part A introduced. A short
part 0 fixes holes in the current code and is independent of both.

It is still an idea: nothing here is scheduled. When a milestone starts, its work units move into a sprint plan
(`docs/sprints/`), and the ADR rewrites it lists come first.
[Orchestration](app-framework-orchestration.md) describes how agents execute it: lanes, the work unit loop, gates
and checkpoints.

**Design rule:** no new services and no multi-step orchestration. Every step extends an existing component. Where a
stronger guarantee would need more, the plan states what v1 gives up and names the later step.

**No backward compatibility.** Schemas, token claims, the proxy manifest and the `@fabrika/app` API change in
place; a reinstall is acceptable. The platform services (IAM, Control, Operations) keep the current `defineApp` and
gates only until they move to contracts (B10); then the old code is deleted.

## Contents

1. [Decisions](#decisions)
2. [Facts at HEAD that shape the plan](#facts-at-head-that-shape-the-plan)
3. [Relation to MCP authoring](#relation-to-mcp-authoring)
4. [Part 0 — fixes in the current code](#part-0--fixes-in-the-current-code)
5. [Part A — the framework](#part-a--the-framework)
6. [Part B — platform enforcement](#part-b--platform-enforcement)
7. [Milestones and sequencing](#milestones-and-sequencing)
8. [Test strategy](#test-strategy)
9. [Documents that change](#documents-that-change)
10. [Out of scope for v1](#out-of-scope-for-v1)
11. [Risks](#risks)

## Decisions

Settled on 2026-10-08. Each row says which part it belongs to, what v1 does and what it deliberately gives up.

| #   | Part | Topic                    | Decision                                                                                                                                                                                                                                                                                        | Gives up in v1                                                                                        |
| --- | ---- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| D1  | B    | Proxy and app switch     | **Per-endpoint requirement digests.** The proxy sends `X-Fabrika-Endpoint: <id>@<digest>`; the application answers 503 for an endpoint whose digest differs from its own. The publish order stays as today: proxy, application, IAM.                                                            | During a switch, changed endpoints answer 503 and new ones 404.                                       |
| D2  | A, B | Database and migrations  | **The cheap namespace is one trust boundary.** Applications in it share the namespace Postgres. Migrations run through `fabrika db migrate` in `run.initCommands`. An application that must be isolated goes to an exclusive namespace (ADR-0014).                                              | Isolation between applications in a cheap namespace; separate migration and runtime credentials; RLS. |
| D3  | B    | Build                    | **One build, fixed order.** The authored SPA commands run first; then the generated commands install, check and build the server. No authored command runs after the checks.                                                                                                                    | Protection against deliberate sabotage of the toolchain by an authored SPA command.                   |
| D4  | A    | Schema library           | **Zod 4** (`zod/v4`, already in the pinned dependency), restricted to a serializable subset in contracts; a peer dependency of `@fabrika/app`. Validation inside handlers stays library-neutral.                                                                                                | Other validators in contracts.                                                                        |
| D5  | A, B | Contract source          | **The contract is a literal, and Control parses it statically.** The contract, its schema modules and `src/db/tables.ts` contain literals, the known `c.*` and `z.*` calls and `const` imports of such values. Part A's checker enforces the rule; part B's Control reads the source.           | Computed values in the contract.                                                                      |
| D6  | B    | Provider exposure        | **Refused, with no approval path:** public or raw-policy buckets, subdomain access, routes, `workers_dev`, preview URLs, bindings to another application. Only CSP extensions are approvable. Control reads back `subdomainAccess`; buckets must be created by the platform as private.         | Detecting a bucket policy changed outside Fabrika (Zerops has no API to read it back).                |
| D7  | A, B | Gates                    | **Applications use contracts only.** The proxy reads endpoint tables: an application's from its contract, an installation service's from its service contract (installation entries, MCP authoring's `oauth` caller included). Gates and applications without a contract are gone (B10g, B10h). | Nothing; there are no applications to keep.                                                           |
| D8  | B    | Environment              | **The environment is part of the IAM application id** (`notes@prod`). `@` is reserved in application ids. Cross-application grants reach platform audiences only.                                                                                                                               | Nothing material; IAM administration lists one entry per environment.                                 |
| D9  | B    | Approval action          | **`access.approve`**, outside the `deploy.*` wildcard. Only a user principal can approve; a service principal, the builder key and any OAuth or MCP token are refused.                                                                                                                          | Nothing.                                                                                              |
| D10 | A, B | Workload callers         | **`px_` keys with their own principal kinds** (`link`, `app`, `job`, `webhook`), each added with the feature that needs it. Part A checks the kind in-process; part B at the proxy.                                                                                                             | Nothing.                                                                                              |
| D11 | A    | Application lint         | **A small syntactic checker** (`@fabrika/check`) on a TypeScript parser, over the application's source graph, with no suppression syntax. Part A runs it in the template's build; part B in the platform's build. Biome stays for the repository's own code.                                    | Aliased or indirect calls can escape a rule; the runtime checks stay the boundary.                    |
| D12 | A, B | Revocation delay         | **The token TTL of 300 s is accepted and documented**, including share links. Membership operations are checked live at IAM.                                                                                                                                                                    | Revocation within seconds.                                                                            |
| D13 | B    | Protected environments   | **Only production is protected by default.** Each environment has a `protected` flag (`prod` true, others false), changed by an IAM administrator, audited.                                                                                                                                     | Approval on staging. Staging must not hold production data; a rule, not enforced.                     |
| A1  | B    | Classification           | **A conservative diff** of the normalized access data of the candidate against the environment's active snapshot. No change passes; a removal passes; everything else waits.                                                                                                                    | Automatic recognition of harmless additions; head counts in the prompt.                               |
| A2  | B    | Who approves             | **A human user in the dashboard**, with `access.approve` and a same-origin request; the approval records the candidate and baseline digests.                                                                                                                                                    | Proof of physical presence. WebAuthn is the next step.                                                |
| A3  | B    | Where approval lives     | **A snapshot on the deploy run.** `app_envs` points at the published run and carries a generation for compare-and-swap. A rollback is a new deploy, classified like any other.                                                                                                                  | Rollback without a prompt.                                                                            |
| A4  | A, B | Response headers         | **One conservative policy** for every application response. Part A sets it in the framework; part B at the proxy, including denials. Downloads get the file treatment.                                                                                                                          | Per-endpoint profiles and caching of static assets.                                                   |
| A5  | B    | Proxy-to-application hop | **A secret per application and environment**, generated by Control and written as a managed variable to the proxy and the application; the proxy strips client `X-Fabrika-*` headers.                                                                                                           | Nothing.                                                                                              |

## Facts at HEAD that shape the plan

Surveyed on 2026-10-08 at `3a4e76b8`. `✔` confirms a claim of the proposals; `⚠` is a nuance.

**Application runtime**

- ✔ The router drops empty segments (`packages/app/src/router.ts:46-48`); the gate matcher reads the raw path, and a
  test asserts that it keeps repeated slashes (`packages/auth-core/src/__tests__/gates.test.ts:20-22`).
- ⚠ The router decodes `%2F` inside a parameter into `/` (`router.ts:50-56`).
- ✔ RPC is one mount with `{ method, input }` or `{ batch }` (`packages/app/src/rpc/dispatcher.ts:297-382`); no
  client sends `{ batch }`.
- ⚠ `@fabrika/app` accepts any Standard Schema validator; zod `^3.25.76` (which contains `zod/v4`) is the only
  validator in the repository.
- ⚠ Schema and gates files export plain `AppSchema` and `AppGates` values (`packages/auth-core/src/types.ts:44-115`).
  Gates are anchored globs in array order; an absent `service` credential falls through to the next rule.
- ⚠ The provider manifest takes `schema` and `target.proxy.gates` from `fabrika.config.ts`
  (`packages/provider-zerops/src/manifest.ts:330-360`); on Cloudflare the config builds its own proxy Worker with
  its gates (`packages/provider-cloudflare/src/proxy.ts:28-69`). This is where part A's generated gates plug in.
- ⚠ Both examples bypass the framework: `examples/zerops-app/src/server.ts:296` calls `Bun.serve`, `:271` opens
  `new SQL(...)`, `src/authz.ts:189` verifies with `jose`.
- ⚠ Platform services use the current API heavily (Control: 30 `.require` calls and 14 raw routes; IAM: 30 and 8;
  Operations: 0 and 6).

**Proxy**

- ✔ An absent service credential falls through to later rules (`packages/proxy-core/src/authorize.ts:167`).
- ⚠ A `service` gate accepts any `px_` key — a user key, a service key or a share link — without checking `ptype`.
  Part A checks the kind in-process.
- ⚠ The method defaults to `GET` when the header is missing (`packages/proxy-core/src/service.ts:338`).
- ⚠ Parsing the forwarded URI resolves dot segments; on Cloudflare the forwarded URI is rebuilt from the parsed URL
  (`packages/provider-cloudflare/src/proxy-worker.ts:111`).
- ⚠ The proxy strips a fixed list of headers (`packages/proxy/src/caddy.ts:339`, `proxy-worker.ts:145-150`) and sets
  no response headers.
- ✔ Nothing authenticates the proxy to the application.
- ⚠ The manifest has no version and is read once, at build on Zerops (a rebuild takes about 190 s plus 60 s of
  deploy) or as a Worker variable on Cloudflare.

**IAM**

- ✔ A signed-in user with no grants gets a token with `perms: []` (`packages/iam/src/tokens.ts:45-96`).
- ✔ Cross-application grants (`app IS NULL`, bootstrap `admin = ['*']`) enter every application's token
  (`packages/iam/src/repositories/grants.ts:40-49`, `src/resolve.ts:84-86`).
- ✔ `issueKey` stores no expiry in service mode (`packages/iam/src/issue.ts:77`, `:86`).
- ⚠ `revokeKey` never compares the credential's application with the caller's (`issue.ts:142-157`).
- ⚠ The `audit` RPC takes a self-asserted application (`src/rpc.ts:181-201`).
- ✔ Every Cloudflare application may bind `propustka-worker`, whose entrypoint exposes `issueKey`, `revokeKey`,
  `listPrincipals` and `audit` (`packages/iam/src/index.ts:79-135`).
- ⚠ IAM has no membership metadata on roles, no delegation operations and no scope creation; an application exists
  once its schema is put.
- ⚠ The proxy mints with the application id only (`authorize.ts:218,269`); IAM has no environment.

**Control**

- ⚠ `app_envs.provider_artifact_json` is one mutable value; `apps.environments.put` republishes the proxy when it
  changes (`packages/control/src/api/registry/environments.ts:91-102`).
- ⚠ IAM receives the schema from the uploaded artifact on Zerops (`packages/provider-zerops/src/provider.ts:589-614`)
  and from the runner's outcome on Cloudflare (`packages/provider-cloudflare/src/control.ts:288-357`).
- ✔ `GitHubMetadataClient.descriptor()` reads one bounded file at an exact commit on both runtimes
  (`packages/control/src/github/source/metadata.ts:150-168`).
- ⚠ The deploy publishes the proxy before the application (`packages/control/src/run-lifecycle.ts:528-541`).
- ⚠ The `operator` role grants `deploy.*` (`packages/control/fabrika.schema.ts:43`).
- ⚠ Control cannot reach a namespace's Postgres: Zerops projects share no private network
  (`docs/reference/zerops-platform.md:38-41`). This is why D2 keeps migrations in the container.

**Providers**

- ✔ `postgres` is an allowed shared reference (`packages/provider-zerops/src/service-references.ts:8`); under D2 it
  stays.
- ⚠ Storage policy, raw policy, `enableSubdomainAccess`, `buildFromGit`, inline `zeropsYaml`, `mount` and `enableCdn`
  are copied unchecked (`packages/provider-zerops/src/compile.ts:105-147`).
- ⚠ No Zerops endpoint is known to read a bucket policy back; `subdomainAccess` can be read back
  (`api/readers.ts:129`).
- ✔ The provider already re-renders the execution descriptor (`overlayRelease`,
  `packages/provider-zerops/src/managed-env.ts:90-105`).
- ⚠ Exec readiness gating a Zerops deploy is unverified; `httpGet` is a recorded fact.
- ⚠ A service variable is mutable across restarts and rollbacks, so `FABRIKA_CONTRACT_DIGEST` must be a literal in
  the execution descriptor, like `FABRIKA_RELEASE`.
- ⚠ Control's `assertUnmanagedName` (`packages/control/src/api/registry/validation.ts:201-205`) and the provider's
  `MANAGED_KEYS` (`provider-zerops/src/managed-env.ts:6-21`) are two lists.
- ⚠ Cloudflare imports the application config with the account token in the environment
  (`packages/runner-container/src/runner.ts:582`); nothing refuses `workers_dev`, preview URLs or foreign bindings.
- ⚠ `applyPostgresMigrations` (`packages/platform-node/src/postgres-migrations.ts:122-165`) rejects a
  schema-qualified ledger and has no checksum or timeouts.
- ⚠ `S3BlobStore` has put, get and delete only.

## Relation to MCP authoring

The `mcp-authoring` branch (ADR-0049 there) lets a person author an application through Claude or ChatGPT over MCP:
Control serves eight tools at `/mcp`, IAM is an OAuth 2.1 server, the proxy has an `oauth` gate kind, a workspace is
a Git branch, and production changes go through a pull request.

- **Merge `mcp-authoring` before IAM or proxy work** (A12, B2, B5). It touches `proxy-core/src/manifest.ts` and
  `auth-core/src/token.ts`, and claims the next IAM and Control migration files and ADR-0049. New ADRs here start at
  0050.
- **Part A:** an MCP agent has no local toolchain, so the template's build runs every framework check and its
  messages are the agent's only feedback (through `get_deployment`); migration file names and crontab entries are
  checked by the checker because the agent cannot run `fabrika db new`; the skill reaches hosted agents through the
  MCP server's instructions and the template's `AGENTS.md`; the template is the contract-based example.
- **Part B:** D5 exists because of MCP — Control must read the contract from source. Once approval exists, a
  workspace may edit `fabrika.contract.ts`, its schema modules and `src/db/tables.ts` (today every `fabrika.*` file is
  protected); `zerops.yaml` and `.github/` stay protected. `get_deployment` reports `awaiting_approval` with the
  approval link. Runs record their actor.
- Applications as OAuth or MCP resources are out of scope for v1.

## Part 0 — fixes in the current code

Independent of everything else. They close holes that exist today.

**P0.1 — Canonical paths (S)**

- One `isCanonicalPath` in `packages/auth-core`: refuse an empty segment, `.` or `..`, an encoded `/` or `\`, and a
  literal `\`. A trailing `/` is significant and matched literally; the router keeps it, so `/a/` and `/a` are
  different routes (Sentry's `/api/<id>/envelope/` depends on it).
- Router: answer 400 for a non-canonical path (`packages/app/src/router.ts`).
- Proxy: check the raw `X-Forwarded-Uri` before `new URL()` (`packages/proxy-core/src/service.ts`); on Cloudflare,
  check the raw request URL before `proxy-worker.ts:111`. Deny a request without a method header.
- Correct the comment in `packages/control/fabrika.gates.ts:17`.
- Witness: deny-matrix rows for `//admin/users`, `/a/../admin`, `/a/%2e%2e/b`, `/x%2Fy` and a missing method; router
  tests for the same.

**P0.2 — IAM key issuing (S)**

- `issueKey`: require an expiry in every mode, with a maximum; refuse actions outside the application's catalog.
- `revokeKey`: refuse when the credential's application differs from the caller's.
- `audit`: take the application from the verified caller.
- Witness: tests for a missing expiry, an unknown action, a cross-application revoke and a forged audit application.

**P0.3 — A narrow IAM entrypoint for Cloudflare applications (S)**

- Verify first: list what applications call through the `IAM` binding.
- A `WorkerEntrypoint` with `getJwks` and the handoff methods only; applications bind it
  (`packages/provider-cloudflare/src/plan.ts:84-85`).
- Witness: an application binding resolves to the narrow entrypoint, which has no `issueKey`.

**P0.4 — Provider refusals (S)**

- Zerops: refuse a non-private or raw storage policy, `enableSubdomainAccess`, `buildFromGit`, inline `zeropsYaml`,
  `mount` and `enableCdn` on application services (`packages/provider-zerops/src/compile.ts`, `manifest.ts`).
- Cloudflare: refuse `routes`, `preview_urls` and any `workers_dev` other than `false` on application Workers
  (`packages/provider-cloudflare/src/plan.ts:116-132`).
- Witness: a compiler test per refused field.

## Part A — the framework

Everything in part A runs on today's proxy, IAM and Control. The contract generates the gates and the IAM schema the
platform already consumes; the application runtime enforces the rest in-process.

**A0 — Binding documents (S)**

- ADR-0012 rewritten: the contract is the decision; `implement`; no raw routes or middleware for applications; the
  router and the gates come from one endpoint table.
- `packages/app`, `packages/auth`, `packages/auth-core` CLAUDE.md: batch removed; contracts require zod 4 (D4); the
  framework's requirement check is authorization in the vocabulary of `docs/reference/overview.md`, not a second
  gate evaluator; the SDK requests scopes, membership and links from IAM and mints nothing itself.

**A1 — Contract model and matcher in `@fabrika/auth-core` (M)**

- `ContractArtifact`: types only, because `auth-core` stays dependency-free. Its zod schema lives where the artifact
  is parsed: `@fabrika/app/contract` (build) and `proxy-core/manifest` (proxy), as gate rules do today. The types cover dimensions with containment and membership actions, actions, roles
  (exact actions, `member` scope, `assignableBy`, creator), mounts with callers, endpoint rows
  `{ id, kind, method, path, callers, requirement }`, files, jobs, webhooks, link mounts, exports, imports, CSP
  extensions, table policies.
- `planEndpoint(table, method, rawPath)`: canonical check (P0.1; a trailing `/` is matched literally), then the most
  specific endpoint; an RPC prefix is reserved. `assertNoAmbiguity(table)`.
- `satisfies(requirement, perms)`: `member` is any permission of the application; an action form is the action in
  some scope, including global.
- Witness: table-driven tests for specificity, ambiguity, canonical refusal and satisfaction.

**A2 — `defineContract` (L)**

- `@fabrika/app/contract`, browser-safe: `defineContract(vocabulary, (c) => mounts)` with `c.rpc`, `c.query`,
  `c.mutation`, `c.link`, `c.spa`, `c.health`, `c.form`, `c.webhook`, `c.files`, `c.cron`, `c.export` and
  `imports`. Every kind has its type from the start; its runtime ships with its work unit.
- Types: access required; actions typed from the vocabulary; no wildcard roles; no public caller; `link` is not an
  RPC caller; `from` names an input field; strict input objects; no loose output.
- `compileContract(contract, tables) → ContractArtifact`.
- Type tests: the spike's 14 mistakes as fixtures, compiled by `tsc` from a test that asserts the diagnostic text
  (the repository forbids `@ts-expect-error`).
- Witness: fixture diagnostics; 200 procedures type-check in under 10 s with zod 4.

**A3 — `implement`, `boot` and dispatch (L)**

- `implement(contract, { database, deps, handlers })`, typed per endpoint.
- `boot(app, { env, iam, origin })`, called only by the generated entrypoint: reads framework-only variables and
  deletes them from `process.env`, then serves.
- Per request: canonical path → `planEndpoint` → token verification with the existing verifier → the principal kind
  must be one of the mount's callers → `satisfies` → admission for a session request that is not `GET`
  (`Sec-Fetch-Site: same-origin`, `Content-Type: application/json` for RPC) → strict input → the access form →
  remove the `from` field → handler → output projection → the response header policy (A4).
- `Ref<dim, action>` and `Within<dim, action>`: classes with private fields, bound to the request with
  `AsyncLocalStorage`.
- Errors map to 400, 403, 404 and 409 with one envelope. Bun and Cloudflare adapters reuse
  `packages/app/src/bun.ts` and `cloudflare.ts`. `{ batch }` is removed.
- Witness: every access form allowed, denied and missing; a share-link key on a `machine` mount is refused; a
  cross-site `POST` with a session is refused; a `Ref` used after its request is refused; output projection drops
  undeclared fields; every response carries the header policy.

**A4 — Gates and schema from the contract (M)**

Superseded by B2 on 2026-10-09: a contract application is served behind its endpoint table, `gatesFromContract` is removed, and only `schemaFromContract` remains.

- `gatesFromContract(contract)`: one gate rule per endpoint path in order of specificity; `human` → `human`;
  `machine`, `link` and `app:<id>` → `service`; both → `service` first; anonymous kinds → `public`. No rule for an
  undeclared path.
- `schemaFromContract(contract)`: actions and roles for today's IAM reconcile.
- Both providers take them from `fabrika.config.ts`; the Cloudflare proxy Worker gets the generated gates.
- `fabrika app build` writes the generated entrypoint `fabrika/entry.generated.ts`.
- Witness: a property test that every endpoint path is admitted by exactly the gate kinds of its callers and that
  an undeclared path matches no rule; the example deploys in the local stack with generated gates.

**A5 — Typed client (S)**

- `createClient<typeof contract>(mount)`: `api.notes.remove({ id })` → `POST /api/notes.remove`; a link client that
  sends its key as a bearer.
- Witness: client tests through the test kit.

**A6 — Test kit (M)**

- `@fabrika/app/testing`: a request through `gatesFromContract`'s decision and the real dispatcher;
  `testCaller(grants)` built on `permits`.
- Witness: the example's tests use only this kit.

**A7 — The checker (M)**

- `@fabrika/check` (D11) with the rules of the framework document's section 8, including the literal rule of D5,
  migration file names and crontab entries.
- The parser is `@babel/parser` 8.0.7, pinned exactly, with the `typescript` and `estree` plugins (decided
  2026-10-08 after a spike). It is plain JavaScript, about 71 KB gzip, and runs on Bun and in a Worker. Control's
  Worker is about 91 KB gzip today. TypeScript's JavaScript line has ended, and oxc is 0.x and needs WASM.
- The template's build runs it; it prints one actionable line per finding.
- Witness: a positive and a negative fixture per rule.

**A8 — `@fabrika/db` (L, Zerops)**, in two parts (decided 2026-10-08):

- **A8a**, which does not need A3. Kysely 0.29.6 and `kysely-postgres-js` 5.0.1, both pinned exactly, over
  `Bun.SQL` with `prepare: false`. A spike confirmed transactions, savepoints, `SET LOCAL`, `READ ONLY` and cancel.
  It cannot stream, and v1 does not need it. The data layer never binds a JavaScript array and never stringifies
  JSON before binding. `defineTables`, `defineStore` and `defineChildStore`; the frozen description builder; the
  `OperationNode` guard; runtime column lists; refusal of unknown keys; `move`; aggregates; optimistic concurrency.
  Port the spike's attack suite.
- **A8b**, after A3: request binding and action checks through `Ref` and `Within`.
- Witness: the attack suite; no scoped query compiles without its scope predicate.

**A9 — Migrations and codegen (M)**

- Extend `applyPostgresMigrations` for applications: ledger in the application schema, checksum, `lock_timeout` and
  `statement_timeout`, a lock key derived from `fabrika-db:<appId>`.
- `fabrika db migrate` (in the template's `initCommands`), `fabrika db new`, `fabrika db codegen`.
- Witness: a changed applied migration fails; a blocked `ALTER` fails within the timeout.

**A10 — Locators (M)**

- Generated locators from table policies, wired into `on`, `in` and `over`.
- Witness: a note of `w2` is 404 for a caller of `w1`; a moved note's `Ref` carries the new chain.

**A11 — Database test kit and isolation tests (M)**

- `@fabrika/db/testing`; `fabrika db test-scaffold`; the checker verifies the content hash of generated tests.
- Witness: a weakened generated test fails the check.

**A12 — IAM features for multi-tenant applications (L)**

- Roles carry membership metadata (`member` scope, `assignableBy`, the creator role) from the contract's schema.
- `scopes.create(app, dimension)`: IAM generates the value and grants the creator role atomically.
- `members.assign`, `revoke` and `list`, evaluated against the caller's live permissions, with the caller's token as
  proof. Invitations by verified email with an expiry; verify first how password-only installations verify an email.
  Revoke cannot remove the last creator. Keep the tables compatible with backlog 91.
- Share links: required expiry up to the mount's `maxDays`, the link mount id, the bound containment chain; revoke
  by the issuer, by `members.manage`, or by mount removal; principal kind `link` (D10).
- A duplicate admin grant already answers 409 (backlog 82, closed by the local-hardening port). Membership
  writes are idempotent: a repeated assign or revoke answers the same result.
- Workload principals cannot create scopes or manage members.
- Needs `mcp-authoring` merged (IAM migrations).
- Witness: every rule of the framework document's membership table.

**A13 — Membership, links and anonymous kinds in the framework (L)**

- `ctx.members` (only for endpoints whose action is the dimension's `members.manage`) and `creates`.
- `c.link`: the share SPA with the fragment bootstrap, link procedures, the chain re-check per request,
  `ctx.links.issue`. Operations redacts URL fragments, `Authorization` headers and `px_` patterns. ADR-0022's "no
  issuing or redeeming method" is reworded: IAM issues every key; the SDK only requests one.
- `c.health` and `c.form` (an inbox table, a body limit, a per-form rate limit).
- `c.webhook` for GitHub: bindings in a framework table, a generated secret, signature, account id and delivery
  deduplication; a `Ref` for the bound scope only.
- Witness: a link stops working after its note moves; a delivery signed for another binding is refused; a replay is
  ignored; a form cannot read.

**A14 — Files (L, Zerops)**

- Streaming in the S3 port (size limit, content type, metadata read); `c.files` with generated endpoints, sniffing,
  a table per collection, deletion by a framework job, the file header treatment.
- Witness: an upload over `maxBytes` stops while streaming; an SVG is an attachment; a file of another workspace is
  404.

**A15 — Cron (L, Zerops)**

- `c.cron`; `fabrika job run <name>`; leases with generation-fenced writes; timeouts and retries; `ctx.within` for
  the declared actions; Operations reporting and the missed-run alert. The template's crontab is checked against
  the contract (A7).
- Witness: a run that lost its lease cannot commit; an overlapping run does not start.

**A16 — Connectors (L)**

- Verify first the connector document's open questions.
- `c.export` and `imports`; the generated description path; `fabrika connect add` and `pull`; `ctx.connect` only in
  `usedBy` handlers; the read-only context with a `READ ONLY` transaction; typed outcomes, deadlines and retries;
  runtime validation against the vendored schema. Identity: an operator-provisioned key per edge on the export's
  `service` gates.
- Witness: an export handler cannot write; a response that breaks the vendored schema is `contract_violation`.

**A17 — Skill, template and examples (M)**

- The skill (the framework document's section 9) in the builder catalog, the MCP server's instructions and the
  template's `AGENTS.md`.
- `examples/zerops-app` on the contract, the data layer, files and a job, as the MCP template; `examples/app`
  (Cloudflare) on the contract.
- Witness: an opice scenario in which an agent adds an endpoint and a table without loosening anything; both
  examples deploy in the local stack.

## Part B — platform enforcement

Part B changes the proxy, IAM, Control and the providers so that the contract is binding. It needs A1, A2, A3 and
A7, and `mcp-authoring` merged.

**B0 — Binding documents (M)**

| ADR                                    | Change                                                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0005 static manifest                   | Control reads the contract by static parsing (D5); nothing is executed.                                                                                     |
| 0014 namespaces                        | A cheap namespace is one trust boundary between applications; an exclusive namespace isolates (D2).                                                         |
| 0017 migrations                        | The application ledger with a checksum and timeouts, run by the generated init command.                                                                     |
| 0022 the proxy is the only enforcement | Endpoint tables, specificity, caller kinds, requirements, admission; digests (D1); stripped headers and the proxy secret (A5); `px_` principal kinds (D10). |
| 0042 builder                           | Uploads carry no gates or schema; the builder key cannot approve.                                                                                           |
| 0043 Zerops descriptor                 | The platform-owned `run` section and server build (D3).                                                                                                     |
| 0048 Cloudflare commit binding         | The contract is read from the commit; the platform builds the proxy Worker.                                                                                 |
| 0049 MCP authoring                     | Protected paths shrink to `zerops.yaml` and `.github/`; the contract and table policies are classified instead.                                             |
| 0050 (new) approved access             | Snapshots on runs, compare-and-swap publication, the conservative diff, `access.approve`, protected environments.                                           |

- Root, `packages/proxy` and `packages/proxy-core` CLAUDE.md: "array order is precedence" holds for installation
  gates only.

**B1 — The static contract reader (M)**

- `readContractSource(files) → ContractArtifact` on the A7 parser; refuses anything that is not a literal with the
  file, the line and the allowed form. Used by Control, `fabrika contract check`, the platform build and the checker.
- The parser is A7's (`@babel/parser`); the spike measured it on Bun and in workerd.
- Witness: a **differential test** over every fixture contract: the static reader and `compileContract` on the
  evaluated module produce the same artifact and digest.

**B2 — The proxy decides per endpoint (L)**

- `requirementDigest(endpoint)` in `auth-core`; a test that changing any field of a row changes its digest.
- The manifest carries `{ id, hosts, upstream, endpoints, snapshot }` for contract applications; installation services
  keep gates, including the `oauth` kind (D7). Producers: `provider-zerops/src/namespace/manifest.ts`, the
  installation template, `local-stack/src/prepare.ts`, the platform-built Cloudflare proxy (B8).
- `packages/proxy-core`: canonical raw path → `planEndpoint` → a `px_` key minted through `mintFromKey`, whose kind
  must be one of the endpoint's callers → the session or the login redirect → `satisfies` → admission. The allow
  response carries the token and `X-Fabrika-Endpoint: <id>@<digest>`.
- The framework dispatches by the endpoint id, answers 503 on a digest mismatch, and refuses to start when its
  contract digest differs from `FABRIKA_CONTRACT_DIGEST`.
- Witness: deny-matrix rows for each step; a digest mismatch answers 503.

**B3 — Stripping and the proxy secret (M)**

- One list of every `X-Fabrika-*` name in `packages/auth-core/src/wire.ts`, used by Caddy's first step and the
  Cloudflare worker.
- The secret per application and environment (A5): generated by Control, written as a managed variable, read by
  Caddy through an `{env.…}` placeholder.
- Witness: a client-sent `X-Fabrika-Endpoint` never reaches the upstream (`caddy.test.ts`); the application refuses a
  request without the secret.

**B4 — Headers at the proxy (S)**

- The A4 policy set by Caddy's response operations, the Cloudflare worker and proxy-core's denials; the file
  treatment for download endpoints.
- Witness: a Caddy config test, a worker test, a denial with the headers.

**B5 — IAM restrictions (L)**

- Application tokens carry only grants of that application; cross-application grants and bootstrap `admin` reach a
  registry of platform audiences separate from `adminAudiences`.
- The environment in the application id (D8): the proxy mints for `<app>@<env>`; Control registers schemas, return
  origins and keys under it; one helper in `auth-core` builds and parses it.
- For contract applications: wildcards refused on every write path; no global grant of a membership role, including
  the raw SQL in `src/repositories/device.ts:98`.
- Application tokens cannot call `issueKey`, `revokeKey` or `listPrincipals` on any transport.
- Delegation grants: for an endpoint whose action is a dimension's `members.manage`, the proxy obtains a single-use
  grant bound to the endpoint and request (consumed like `auth_codes`), and IAM requires it for membership
  operations.
- A bound on token size.
- Witness: a global `admin` is absent from an application token; a staging key is refused at production; a
  membership call without a delegation grant is refused; each write-path refusal.

**B6 — Control: snapshots and approval (L)**

- `readFileAtCommit(path, maxBytes)` from `GitHubMetadataClient.descriptor()`; read the contract, its schema
  modules, `src/db/tables.ts` and the migration list with checksums right after the run's commit is pinned
  (`run-lifecycle.ts:471`), and run B1.
- The run stores its snapshot (A3); `app_envs` gains `published_run_id` and `generation`. One function,
  `approvedSnapshot(app, env)`, feeds every write path: the deploy, `environments.put` and `delete`, `apps.delete`,
  `namespaces.reconcile`, namespace jobs, Zerops `reconcile-schema`, cancel and reconcile, Cloudflare deploy and
  reconcile. Publication is `UPDATE … WHERE generation = ?` inside the existing namespace lease. Uploads carry no
  gates or schema.
- `packages/control/src/approval/diff.ts`, pure (A1), with plain-language lines.
- A `protected` flag per environment (D13); a widening on a protected environment parks the run in
  `awaiting_approval`; `approvals.list`, `get` and `complete` behind `access.approve`, user principals only (D9);
  the approval records both digests (A2). Runs record their actor. MCP's `get_deployment` reports the parked run;
  workspaces may edit the contract files. Dashboard: an approval page with the diff lines.
- Witness: a test per write path that a pending widening is published nowhere; a concurrent publication loses; a
  widening waits on `prod` and applies on `stage`; a builder key, an OAuth token and a service principal cannot
  approve; a removal runs through.

**B7 — Zerops lock-down (L)**

- Facts first (platform-facts rows): exec readiness gating a deploy; an `initCommands` failure stopping activation.
- The generated execution descriptor from `overlayRelease`: `run` (`fabrika db migrate`, the generated entrypoint,
  the crontab, the readiness check, `prepareCommands` from a typed allowlist, `FABRIKA_CONTRACT_DIGEST` as a
  literal) and `build` as in D3. Authored `run` keys, `build.addToRunPrepare`, `build.deploy` and
  `deploy.temporaryShutdown` are refused at compile time.
- The build checks: frozen install with lifecycle scripts off, the `@fabrika/*` lockfile hash, `tsc` with the
  platform's `tsconfig`, the checker, the contract check, migrations into a throwaway schema with codegen
  verification, the isolation tests. The routine replacement mechanisms of `@fabrika/*` are refused. The checker
  version is pinned and recorded in the snapshot.
- Exposure: Control reads back `subdomainAccess`; buckets must carry the platform's private provenance (D6); a
  failure blocks activation and raises an Operations alert.
- One list of framework-only variable names for `assertUnmanagedName` and `MANAGED_KEYS`.
- Witness: one fixture repository per refusal; a provider fake with subdomain access on blocks the run.

**B8 — Cloudflare lock-down (M)**

- The deployer builds the proxy Worker from the snapshot; an authored proxy is refused.
- Bindings whose names belong to another application of the installation are refused, using Control's registry.
- The checker and type checks stay advisory on Cloudflare until the runner separates a credential-free step.
- Witness: a config that builds its own proxy is refused; a binding to `prod-otherapp` is refused.

**B9 — Workload credentials and connector edges (M)**

- Credentials per job, webhook binding and connector import, reconciled from the snapshot and narrowed to the
  declared actions; kinds `job`, `webhook` and `app`; keys stored in Control's vault and written as managed
  variables. The proxy admits `app:<id>` callers only on export paths.
- Control computes connector edges from both snapshots and checks compatibility on consumer and owner deploys.
- Witness: a job key is refused on the application's own `machine` mount; an owner deploy that removes an imported
  field is refused.

**B10 — Platform services on contracts (L)**

- IAM, Control and Operations move to contracts (including the `oauth` caller for `/mcp`); the proxy's admission
  replaces Control's `sameOrigin`; gates and `defineApp` are deleted.
- Witness: the installation's proxy manifest has no gates.

## Milestones and sequencing

| Milestone                         | Work units | Result                                                                                                         |
| --------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| **M0 — current holes closed**     | P0.1–P0.4  | Today's applications are safer.                                                                                |
| **A-M1 — framework core**         | A0–A7      | Both clouds: applications written against the contract, with generated gates, in-process checks and a checker. |
| **A-M2 — data**                   | A8–A11     | The scoped data layer on Zerops.                                                                               |
| **A-M3 — multi-tenant**           | A12–A13    | Workspaces, members, share links, forms, GitHub webhooks.                                                      |
| **A-M4 — companions**             | A14–A17    | Files, cron, read-only connectors; the skill and the template.                                                 |
| **B-M1 — binding contract**       | B0–B6      | The proxy enforces endpoints; IAM is restricted; a widening on production waits for a human.                   |
| **B-M2 — locked providers**       | B7–B8      | The platform owns the run section and the build; exposure is refused and read back.                            |
| **B-M3 — workloads and platform** | B9–B10     | Narrow workload credentials; one model for the whole installation.                                             |

**When can a production application start?**

- Written by a developer who reviews the code: after M0, A-M1 and A-M2 (A-M3 for multi-tenant).
- Written by an inexperienced person through an agent: additionally after B-M1, and preferably B-M2. Without them a
  loosened role or contract is visible only in the pull request.

**Dependencies**

| Work unit | Waits for                                     |
| --------- | --------------------------------------------- |
| A1–A7     | A0; P0.1 for the canonical check              |
| A8a       | —                                             |
| A8b–A11   | A3, A8a                                       |
| A12       | `mcp-authoring` merged                        |
| A13       | A10, A12                                      |
| A14–A16   | A10; A15 and A16 also A12 for principal kinds |
| B1        | A2, A7                                        |
| B2, B3    | A1, A3, `mcp-authoring` merged                |
| B5        | `mcp-authoring` merged                        |
| B6        | B1, B2                                        |
| B7        | A4, A9, B1                                    |
| B8        | B2                                            |
| B9        | A12, A15, A16, B6                             |

Part A and part B can run in parallel once A1–A3 exist: B5 (IAM) and B1 (reader) do not wait for the rest of part A.

## Test strategy

- **Pure modules** (matcher, gate generation, static reader, diff, satisfaction): table-driven unit tests and golden
  files.
- **Gates against the router:** a property test that the generated gates and `planEndpoint` agree on every path of
  every fixture contract (A4).
- **The static reader against the runtime:** a differential test on every fixture contract (B1); the startup digest
  check is the production backstop.
- **Type behaviour:** fixtures compiled by `tsc` from a test, asserting the diagnostic text.
- **Fail-closed first:** every decision step, in the framework and at the proxy, gets deny rows before allow rows.
- **Backends:** Postgres and S3 suites follow the existing skip convention; the platform build sets
  `FABRIKA_TEST_POSTGRES_REQUIRED=1`.
- **Zerops facts:** every new dependency on Zerops behaviour gets a row in the platform-facts table.
- **Adversarial suites:** the data-layer attacks and the build-refusal fixtures run in CI and on Kysely or Bun
  upgrades.
- **End to end:** an opice suite with the notes template, driven through the local stack and through MCP authoring:
  IDOR attempts, a link after a move, a cross-site `POST`; with part B, a widening that waits on `prod` and applies
  on `stage`.

## Documents that change

- Part A: ADR-0012; the CLAUDE.md files of `app`, `auth`, `auth-core`, `platform-node`; new CLAUDE.md files for `db`
  and `check`; `docs/reference/portability-surface.md` (Kysely for applications).
- Part B: the ADRs of B0; the CLAUDE.md files of the root, `proxy`, `proxy-core`, `iam`, `control`,
  `provider-zerops`, `provider-cloudflare`; `docs/reference/overview.md` (caller kinds, requirements, admission);
  `docs/reference/zerops-platform.md` (new facts).
- The idea documents are deleted once their content lives in ADRs and reference documents.

## Out of scope for v1

| Deferred                                                      | Next step when needed                         |
| ------------------------------------------------------------- | --------------------------------------------- |
| Isolation between applications in a cheap namespace; RLS      | Per-application Postgres roles                |
| Proof of human presence at approval                           | WebAuthn on `approvals.complete`              |
| Revocation faster than 300 s                                  | A revocation epoch checked by the proxy cache |
| Per-endpoint header profiles and asset caching                | Profiles selected by the proxy decision       |
| Head counts and harmless-addition detection in approvals      | A reachability classifier                     |
| Toolchain sabotage by an authored SPA command                 | A separate build for the SPA                  |
| Tasks, connector mutations and on-behalf-of, scoped exports   | As in the companion documents                 |
| Presigned storage URLs; data layer, files, jobs on Cloudflare | As in the companion documents                 |
| Slack and Stripe webhooks; self-signup; SSR                   | —                                             |
| Applications as OAuth or MCP resources                        | A contract caller kind for OAuth              |
| Declared report kinds beyond the query builder                | The first expected follow-up after A-M2       |
| A platform data executor                                      | The long-term hard boundary                   |

## Risks

| Risk                                               | Effect                                                         | Mitigation                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Part A ships and part B is postponed               | Loosened roles and contracts are visible only in pull requests | Production guidance above; B-M1 before applications built by inexperienced people                |
| The literal rule is too restrictive                | Agents fight the checker; larger contracts get verbose         | Collect real contracts during A-M1; extend the reader with specific forms, never with evaluation |
| The static reader disagrees with the runtime       | Control approves a different contract from the one that runs   | Differential tests; the startup digest check fails closed                                        |
| No parser fits Control's Worker budget             | B1 changes shape                                               | Verify in A7; fallback: parse in the Bun process only                                            |
| Approval fatigue from the conservative diff        | Humans approve without reading                                 | Only production is protected; measure prompts per deploy; a reachability classifier later        |
| An agent drives the approver's browser             | A widening is approved without a human decision                | The skill forbids it; WebAuthn is the next step                                                  |
| Shared namespace database                          | One application can read another's tables in a cheap namespace | State it in the namespace choice; exclusive namespaces for sensitive applications                |
| Report queries do not fit the builder              | Agents push for raw access                                     | Declared report kinds after A-M2                                                                 |
| Token size in many workspaces                      | Proxy header limit exceeded                                    | B5 bound; scope-compressed claims later                                                          |
| `mcp-authoring` and this plan touch the same files | Merge conflicts, migration numbering                           | Merge `mcp-authoring` before A12, B2, B3 and B5                                                  |
