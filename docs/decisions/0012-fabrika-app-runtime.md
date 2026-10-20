---
id: 0012
title: An application declares one contract with the staged kit and serves it through serve
status: accepted
date: 2026-10-20
---

# 0012 — An application declares one contract with the staged kit and serves it through `serve`

## Context

fabrika owns an application's deployment, identity model, authorization policy, proxy enforcement and
audit. `@fabrika/app` is its first-party server framework: the contract kit, typed RPC, `.require()`, the runtime
adapters and the contract runtime. It came from the separate Trasa project, which was absorbed so that the auth
contracts and the framework change in one repository.

Without one declaration, an application declares its access surface three times, by hand:

- a schema module holds the IAM vocabulary (actions, roles, scope dimensions);
- a rule list holds the proxy's path rules;
- the router holds the routes, the middleware and the `.require()` calls.

Nothing ties the three together. The likely mistakes, in order:

1. An endpoint with no authorization, or a check in one handler that is missing in the next.
2. Authenticated mistaken for authorized. IAM mints a token for every person who can sign in, with
   `perms: []` when the person has no grant in this application.
3. Object-level access (IDOR): the handler checks `notes.read`, then loads any note by id.
4. Identity or scope taken from the request body (`ownerId`, `workspaceId`).
5. A whole database row returned.
6. Code around the framework: a hand-written server, a database driver, a query that ignores the scope.

A coding agent makes these mistakes routinely, because it optimizes for "it works". When something refuses it, it
loosens whatever refused it or finds a way around it.

Two matchers can also read paths differently. A router that drops empty segments selects by a
different path than a proxy that reads the raw path. The proxy can then decide for one rule while the
router serves a different handler.

The platform must be able to read the access surface without executing application code
([ADR-0005](0005-compile-app-config-to-static-manifest.md)). An application authored over MCP has no
local toolchain, so Control reads it from source. A declaration that only exists after
the application's module graph runs cannot serve that purpose.

A first form of the framework met these needs with a literal contract and a mirrored handler tree
(`implement(contract, { handlers })`), hand-written stores and table policies that restated the action names. A
dogfood CRM on it wrote each fact three or four times (538 hand-written server lines): the actions, the scope
hierarchy, the entity shape, the writable columns, the endpoint tree, and endpoint access against table actions. A
write capability could not read its own row, there was no locking read, and every store call owned its
transaction, so a precondition such as "reopen a deal only from won or lost" could not be enforced on the server.
Reports that need a join had no road at all: raw SQL was refused, so an agent loaded every row or invented a hack.

What the platform can guarantee at the high level is two things: nobody reaches an endpoint outside authorization
(the proxy, [ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)), and a widening waits for a human on a
protected environment ([ADR-0050](0050-approved-access.md)). What a handler does with data is the code's and the
review's job. The framework's job is to make the straightforward way the sound way, and to make every step off it
visible to the person who approves the deploy.

## Decision

**We will make one contract, built with the staged kit of `@fabrika/app`, the whole access surface of an
application, and serve it with `serve`. A declaration states where a request enters, who may send it, how it is
admitted, what it carries and what reach the code behind it holds; it never encodes an application operation (§9).
Handlers sit beside their endpoints on a paved road scoped by the endpoint's capabilities; every step off that road is
declared in the contract, allowed, and shown to the approver.**

### 1. The contract is the declaration, built in stages

The application's **shell** is pure data, browser-safe, and the only declaration of its access surface; there is
no separate schema module and no rule list. It is built in a fixed order, so the types stay acyclic and nothing
imports `typeof contract` to type a table:

1. `src/vocabulary.ts`: `defineVocabulary({ app, dimensions, actions, roles })` — scope dimensions with
   containment, actions, roles that list exact actions, and the actions that manage and list membership.
2. `src/db/tables.ts`: `defineTables(vocabulary, columns)({ … })` — the table policies. Action and dimension names
   come from the vocabulary, and each table's containment (its key, its container column, a child's parent column
   and chain) is derived from the vocabulary and the generated column list unless the policy states it.
3. `src/app-kit.ts`: `defineApp(vocabulary, tables, { imports, tokens }?)` — the kit, typed by the vocabulary, the
   database and the policies, with the contracts it imports and its signed-token purposes (§14). An application
   without tables writes `defineApp(vocabulary)`.
4. `src/<slice>/endpoints.ts`: `app.group({ callers }, (r) => ({ … }))` — endpoints with their access requirement,
   their input and output schemas, and a handler beside each; `app.cron`, `app.webhook`, `app.link` and
   `app.export` the same way.
5. `fabrika.contract.ts`: `app.contract((c) => ({ … }))` — the mounts (`c.rpc(prefix, groups, { compatibility? })`,
   once per mount, each with its callers `human`, `machine`, `link` or `app:<id>`), the SPA, health, file kinds
   (`c.files`), jobs, webhooks and exports.
6. `src/app.ts`: `serve(contract, { database, deps })` — the composition entry (§2).

Rules of the shell:

- **The shell is a literal.** Its modules — the contract, the vocabulary, the tables, the kit, the groups and the
  schema modules they import — contain only object and array literals, strings, numbers, booleans, the known
  builder and `z.*` calls, and `const` imports of such values. No computed value and no call of the application's
  own functions. The handlers are not part of it: the reader reads each module as its **shell slice**, which drops
  every `.handle(<inline function>)` and whatever only those handlers use (§2). The checker (`@fabrika/check`)
  enforces the rule in the application's build, and Control's reader applies the same one.
- **Schemas are zod 4** (`zod/v4`), restricted to a serializable subset: strict objects, no
  transforms, no `passthrough`. Validation inside a handler stays library-neutral.
- **Nothing is open by omission.** Every procedure declares `access`. There is no default, no `none` and no
  `public` caller. Every endpoint for a signed-in caller requires an action or membership in this application.
  Anonymous traffic exists only where the contract says so: a procedure that declares `access: { public: true }`
  (§10), an SPA with `access: { public: true }`, and the fixed kinds `c.health`, `app.webhook` and `app.link`.
- **One path per procedure.** A procedure is served at `<mount>/<procedure>`, for example
  `POST /api/notes.remove`, with `POST` unless its HTTP shape says `GET` (§11). The `{ batch }` request form is
  removed.
- **A role may not take a name IAM reserves** (`admin`); `defineVocabulary` refuses it as a type error at the role.

### 2. Handlers sit beside their endpoints; `serve` is the only serving surface

Each procedure, job, webhook, link procedure and export procedure takes its handler beside its declaration:
`r.query({ input, output, access }).handle(async ({ input, ctx }) => …)`. The kit types each handler by its
endpoint: a returned field the output does not declare, a handle the access form does not give, and a write in a
query are type errors at the endpoint's line.

- `serve(contract, { database, deps })` (`@fabrika/app/implement`) is the application's composition entry. It
  takes only the object `app.contract` returned and refuses an endpoint, job or webhook without `.handle(…)`.
  `database` is `scoped(tables)` of `@fabrika/db`, or `null` for an application without tables; `deps` is
  `defineDeps(build)`, built at each boot from the application's own variables.
- There is no slot for middleware, raw routes, `authenticate`, a custom server or a WebSocket upgrade.
  An application cannot add surface that the contract does not declare.
- **The reader slices the handlers off.** Control, the checker and the SPA build (`@fabrika/check/bun-plugin`) read
  every shell module as its slice, so they never fetch, parse or run a module that only a handler imports. A
  `.handle` the slice cannot remove whole (a named function, a computed or wrapped spelling) is refused. `boot`
  refuses a compiled contract other than the approved `FABRIKA_CONTRACT_DIGEST`, which backs what the slice cannot
  see.
- The entrypoint is generated (`fabrika app build` writes `fabrika/entry.generated.ts`). Its runtime adapter
  ([ADR-0013](0013-explicit-runtime-adapter-entrypoints.md)) takes the framework's variables out of `process.env`
  before it imports the application, then calls `boot`, which binds the data layer and serves.
- A handler receives authorized capabilities, not raw ids: `Ref<dim, action>` for one object (`ctx.target`) and
  `Within<dim, action>` for the scopes where the caller holds the action. An endpoint of several capabilities gets
  each by its name (`ctx.capabilities.<name>`, §10). A workload site (a job, a webhook bound to `'app'`, a public
  procedure) mints `ctx.app('<action>')` for a declared action its token carries. Capabilities are bound to their
  request and checked at runtime too, because TypeScript cannot prevent every widening.
- Errors come from `@fabrika/app` (`ConflictError`, `NotFoundError`, `BadRequestError`) and map to 400, 403, 404
  and 409 with one envelope.

The mirrored handler tree of the first form (`implement(contract, { handlers })`) stays only as the framework's own
test entry; it is not on the application surface.

The installation's own services (IAM, Control, Operations) do not use an application contract. Each declares
a **service contract** (`defineServiceContract` in `@fabrika/app/service`): one endpoint table per
service. `serveService` is its thin dispatcher over `planEndpoint`. The proxy reads such a table as an
installation entry, which platform composition marks and which may use five forms no application
contract can declare ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) "Installation
entries"), among them the `oauth` caller of MCP authoring.

### 3. The router and the proxy select from one endpoint table

The contract compiles to one endpoint table. The framework dispatches from it through `planEndpoint`
in `@fabrika/auth-core`, which refuses a non-canonical path and selects the most specific endpoint.
An unknown procedure under an RPC prefix is 404 and never falls through to the SPA.

The proxy selects from the same table. The router therefore cannot serve a path under different rules
than the proxy applied, and `X-Fabrika-Endpoint` names the endpoint and the digest of those rules.

### 4. The proxy reads the endpoint table; the contract generates the IAM schema

The contract compiles into the two artifacts the proxy and IAM consume:

- **`contractProxyTable(artifact)`** (`@fabrika/proxy-core/manifest`) produces the endpoint table of
  the proxy manifest: every row's rules, its delegation and digest, the reserved prefixes and the
  contract digest. The proxy decides per endpoint with it
  ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) rule 3). The manifest parser refuses
  any other form of entry.
- **`schemaFromContract(contract)`** produces the `AppSchema` that the deploy reconciles into IAM:
  scopes with their membership metadata, actions, roles, link mounts, and the endpoints that spend
  membership authority (`creates`, and the dimension's `members.manage`) as delegations.

Both providers take these from `fabrika.config.ts`. The application never writes either by hand.

### 5. The framework authorizes; the proxy stays the only enforcement point

The vocabulary is the one of [ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) and
[`overview.md`](../reference/overview.md). The proxy decides with the endpoint table and the canonical
matcher, and it is the only enforcement point. The framework makes no enforcement decision.

Per request, after the proxy has admitted it, the framework runs these steps in order:

1. Refuse a non-canonical path; select the endpoint with `planEndpoint`.
2. Verify the proxy-injected token with the shared verifier
   ([ADR-0040](0040-share-one-token-verifier.md)).
3. Check that the token's principal kind is one of the mount's callers.
4. Check the endpoint's requirement: `member` (any permission of this application), the action in
   some scope, for the `app` form the action held as a global grant, and for `capabilities` each of its actions.
5. For a session request that is not `GET`, require `Sec-Fetch-Site: same-origin`, and the body codec of the
   endpoint's HTTP shape (§11): `application/json`, `multipart/form-data` for an input with file fields, or
   `application/x-www-form-urlencoded` where declared.
6. Charge the endpoint's rate buckets (§11), read the body within its limit, parse the input strictly, run the access
   form (`on`, `in`, `over`, `creates`, `app`, each capability of `capabilities`), remove the `from` fields, call the
   handler within its time limit, and project the output through its schema.

A public procedure has no caller and no requirement: the framework skips steps 2 to 4 and runs the handler as the
endpoint's own workload ([ADR-0063](0063-a-public-procedure-runs-as-its-own-workload.md)).

The caller-kind check (step 3), the requirement check (step 4) and the access form (step 6) are
**authorization**. The same-origin and content-type check (step 5) is **admission**. Neither is a
second enforcement decision: neither selects whether a request reaches the service, and the proxy has
already made that decision.

The proxy checks the caller kind and the requirement too
([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) rule 3). The framework repeats them as
authorization.

### 6. Membership, scopes and share links come from IAM

The framework requests a new scope value, a membership change, a member list or a share link from IAM on the
caller's behalf, with the caller's token as proof. IAM evaluates each request against the caller's
live permissions, does the write and issues every key. The application supplies no actor, writes no
grant and mints no credential. IAM has these operations (`IamMembershipRpc`) and reads the membership
metadata from the application's schema: containment, the creator role, the members actions,
`assignableBy`, link mounts and the endpoints that may spend a delegation grant.

- **Membership management** (`ctx.members.assign`, `revoke`, `list`) exists only on an endpoint whose action is its
  dimension's `members.manage`. A change spends the proxy's delegation grant, so one request makes one change.
- **The member directory** (read-only) exists on every endpoint `on` or `in` a dimension that declares members or
  lies below one: it reads the nearest such dimension's members, at the value the object's chain (resolved from the
  database, as the access form resolved it) holds. `ctx.members.get(principalId)` answers one member — principal id,
  label, whether disabled — or `null`, so a handler validates a picked person and takes its label from IAM, never from
  the input. IAM establishes a lookup's authority itself (`findMember`): the endpoint's own action must be one of the
  dimension's `lookups`, which the reconciled schema takes from the approved artifact's `directories`, and the caller
  must hold it on the directory's value itself. IAM knows no containment below a value, so a grant on a contained
  object does not count, and the application cannot widen a lookup by what it sends: it can misstate only which of its
  approved endpoints asks. The lookup needs no second action. `ctx.members.list()` (with roles) exists only where the
  endpoint's action is that dimension's `members.list`, and IAM checks that action live on the directory's value
  itself. Neither spends a delegation grant. Each endpoint's reach is recorded in the artifact (`directories`), so the
  digest covers it and its first appearance widens.
  A member's label is derived from its email, so both answer it as `null` unless the dimension opts in with
  `directory: 'labels'` in the vocabulary; that opt-in is in the approved artifact and widens with closer review
  ([ADR-0050](0050-approved-access.md) §3). Emails and open invitations stay with `members.manage`. A lookup tells a
  caller whether one id it names is a member: it cannot enumerate.
- **Share links** (`ctx.links.issue`, `ctx.links.revoke`) exist on an endpoint that declares `issues: '<mount>'` and
  whose `Ref` carries that mount's `issuedBy` for its dimension, and on a cron job that declares `issues: '<mount>'`
  and whose actions hold the mount's `issuedBy` and every grant. IAM binds the key to the object's whole chain. A
  job issues for an object it located with `ctx.ref(<issuedBy>, <dimension>, id)` and presents its own token; IAM
  admits it only for the mount the approved schema records with the job, and lets it revoke only links it issued.
  The job is app-wide for that mount: the link is bound to one object, the job is not. This is how an anonymous
  visitor gets a credential: a public procedure inserts a submission row and kicks a job
  ([ADR-0063](0063-a-public-procedure-runs-as-its-own-workload.md)), and the job claims the row, creates the record and
  issues the link. A file of the submission is a file column that the job copies into the record in the same
  transaction ([ADR-0061](0061-a-file-is-a-value-in-a-table-column.md)). Single use stays application state (a
  `verified_at` set once under `getForUpdate`); IAM's revocation is the stop, effective within the token lifetime of
  300 s.

`endpointMembers` (`@fabrika/auth-core`) decides which members facility an endpoint has, for the types, `boot` and
Control alike. An invitation by email is accepted on IAM's own page by the principal that owns the invited mailbox,
proven by the one-time link IAM mails; without an email service there are no invitations.

### 7. The paved road, and every step off it declared

A handler reaches data through `ctx.db`, which `boot` builds for its site from the capability the access form
minted, the site's kind (query, mutation, job, webhook, export) and its declaration:

- **The mini-ORM is scoped by the endpoint's capability.** `ctx.db.target` is the handle bound to `ctx.target` (its
  row, its child tables and the tables it contains), `ctx.db.within.<table>` lists under a `Within` in keyset pages,
  `ctx.db.created` inserts into a scope IAM just made, and `ctx.db.reference.<table>` reads reference tables. Data of
  the whole application has a form of its own: an endpoint declared `{ action, app: true }` is admitted only for a
  global grant of its action, and `ctx.db.app.<table>` reads and writes the application tables (`scope: { app:
  '<why>' }`) with that action and reads every row of each dimension and child table whose read action it is, as
  `over` with `'all'` would. A dimension or child table may name further actions that read every row app-wide,
  read-only with the columns of that action (`actions.appRead`: an export, a bulk send), and actions that only count
  its rows (`actions.appCount`: an operations counter, no aggregate, whose groups would be values), so an export is
  granted apart from reading. An `on`, `in` or `over` endpoint reads an application table too, read-only and every
  row, where its action is the table's read action: the table's read action decides who reads it. So a code list an
  administrator edits, the check of a value against it in a scoped mutation, and the log row of an export across
  every record stay on the road; a reference table stays migration-managed and read-only. A workload site reaches the
  application tables by the actions its token carries, `ctx.db.app('<action>').<table>`; a public procedure's reach is
  narrower still ([ADR-0063](0063-a-public-procedure-runs-as-its-own-workload.md)). Each operation of a table policy
  names one action or a list, any one of which allows it, so staff and a public procedure can read one table under
  their own actions. A
  capability reads its own target, except a column that declares another action's read
  ([ADR-0050](0050-approved-access.md) §3). Writes answer `{ id, version }`; `update` and `remove` take
  `expectVersion`; `getForUpdate()` is the precondition read a concurrent write waits behind. `fromRow(Schema, row)`
  turns a row into an output.
- **The transaction is the invocation's.** An endpoint request and a webhook delivery each run every statement in
  one transaction, committed after the handler returned and its output passed validation, rolled back on a throw, a
  refused output, a cancellation or a refused statement. A query and an export run `READ ONLY`. A job reads outside
  and writes only in its fenced `ctx.transaction((tx) => …)`. IAM, object storage and connector calls never roll
  back, so data work comes first and the external call after.
- **Raw SQL is legitimate.** `ctx.sql(Row)` is a tagged template whose every value is a bound parameter, run in the
  invocation's transaction and parsed by `Row`. It exists only on a site that declares `sql: 'read' | 'write'`; a
  query and an export may declare only `'read'`.
  A scope fragment (`ctx.sql.scope`) carries its capability's action, and the tag holds it to what the statement does
  with the relation in its own query block: the relation an `UPDATE`, `DELETE` or `ON CONFLICT … DO UPDATE` writes needs
  that operation's action, any other an action the handles read it with, and a reference table is never a write
  target. The blocks come from the lexer's parentheses, not from a SQL parser: the tag reads no grammar it does not
  need, and a write without a fragment stays the declared deviation. `sql` stays one declaration per site; there is
  no per-table `sql` declaration, so a write without a fragment is the declared deviation, not a checked one.
- **Every step off the road is declared in the shell**, as a plain literal the contract digest covers:

  | Field                                      | On                                       | What exists only there                                       |
  | ------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------ |
  | `sql: 'read' \| 'write'`                   | endpoint, job, webhook                   | `ctx.sql` (`tx.sql` in a job), in that mode                  |
  | `unscoped: { <table>: 'read' \| 'write' }` | endpoint, job, webhook                   | `ctx.db.unscoped.<table>`: no scope predicate, still guarded |
  | `connect: ['<import>']`                    | endpoint                                 | `ctx.connect.<import>`                                       |
  | `issues: '<mount>'`                        | endpoint, job                            | `ctx.links.issue` and `revoke`                               |
  | `mailer: 'installation' \| 'own'`          | cron job (kit contract only)             | `ctx.mail` ([ADR-0019](0019-portable-outbound-email.md))     |
  | `actions: ['<action>']`                    | public procedure, job, webhook           | `ctx.app('<action>')` and `ctx.db.app('<action>')`           |
  | `kicks: ['<job>']`                         | mutation, job, webhook                   | `ctx.kick` (§12)                                             |
  | `binds: '<webhook>'`                       | credentialed mutation                    | `ctx.webhooks('<webhook>').bind` and `unbind` (§13)          |
  | `signs: ['<purpose>']`                     | procedure of an RPC mount, job, webhook  | `ctx.tokens.sign` (§14)                                      |
  | `egress: ['https://<host>']`               | credentialed RPC procedure, job, webhook | `fetch` to those origins (§15)                               |

  The runtime builds each handle only for the declaring site and enforces its mode. It takes the declaration from
  the approved artifact (`ContractArtifact.declared`), not from the handler module, and refuses to boot a site whose
  own declaration differs. Database code in a migration — a function, trigger, view, rule, policy or `DO` block — is
  the same kind of step, declared by the migration file itself
  ([ADR-0017](0017-service-owned-postgres-migrations.md)).
- **A step off the road is a review signal, not a refusal.** Control puts each declaration and each piece of
  database code into the approval snapshot, and a new one, or one whose reach grows, is a widening the approver sees
  marked for closer review ([ADR-0050](0050-approved-access.md) §3). Hard refusals stay only for platform
  integrity: secrets, framework internals and `fabrika_*` objects, and escaping the application's schema or the
  invocation's transaction.
- **The name rules are defense in depth; the role is the privilege boundary.** `ctx.sql` refuses, from the
  template's static text and before anything is sent, more than one statement, DDL, transaction control, `SET`,
  `COPY`, a name outside the application's schema, any `fabrika_*` or `pg_*` relation and a call outside the reviewed
  built-ins; migrations are classified the same way. Those rules see names, not rights. What an admitted statement
  can do is bounded by the application's role family: the runtime role `run_<id>` has DML on the schema's tables
  only, and the migration role `app_<id>` owns that schema and nothing else
  ([ADR-0017](0017-service-owned-postgres-migrations.md)).

Where application code goes — vocabulary, tables, kit, slices with their `endpoints.ts`, `logic.ts` and `queries.ts`,
the composition entry, the SPA — is the [application architecture](../reference/application-architecture.md). The
checker reports a break of platform integrity as a **refusal**, which fails the build, and a step out of that
structure as a **hint**, which it prints and does not fail on. Hints stay checker output and never reach the
snapshot. A syntactic hint such as "declare `sql: 'read'` on `pipeline`" helps the author; it is not the boundary,
because destructuring, helper modules and `ctx[k]` evade any syntactic detector. The declarations are.

### 8. Where the contract becomes binding

The framework runs inside the application process and the application's own build. An agent that
edits the contract, a role, `fabrika.config.ts`, the build commands or the checker's invocation can
loosen any of it, and only the pull request shows the change.

Other ADRs make the contract binding outside the application process:

- The proxy reads the endpoint table, and checks caller kinds, requirements and admission itself:
  [ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md).
- Control reads the shell from source by static parsing
  ([ADR-0005](0005-compile-app-config-to-static-manifest.md)), and a widened contract, a new step off the road
  included, waits for a human on a protected environment ([ADR-0050](0050-approved-access.md)).
- The application's database roles bound what its code and its migrations can do in Postgres
  ([ADR-0017](0017-service-owned-postgres-migrations.md)).
- The platform owns the run section and the server build on Zerops
  ([ADR-0043](0043-validate-and-render-one-zerops-descriptor-meaning.md)) and builds the proxy Worker
  on Cloudflare ([ADR-0048](0048-bind-cloudflare-delivery-to-the-recorded-commit.md)).
- The installation's own services declare service contracts, not application contracts, and their tables
  reach the proxy as installation entries
  ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)).

All five are built, so the contract binds outside the application process too.

**Inside the process, application code is trusted.** The framework, `@fabrika/db` and the application share one
process, so the runtime checks there stop mistakes and make a bypass conspicuous; they do not contain hostile code.
The framework closes the same-process patches it knows of:

- The Kysely compiler, `Database` (class and prototype) and the capability classes' prototypes are frozen at load,
  and the checks use built-ins captured at load.
- The adapter takes `Database.postgres` before it imports the application. Each `boot` call makes its own
  capability issuer and binds its data layer to it, and every handle is bound to its invocation, so no import, also
  by URL, no second runtime booted with keys of the application's own, and no handle kept past its request reaches
  what the served runtime's data layer accepts.
- `fabrika-check` refuses the source forms that reach around them: a write to a `@fabrika/*` or `zod` value, a
  prototype write, an import of `boot`, a database driver's SQL, and a load by computed specifier, by resolved path,
  through an indirect loader call, `node:module` or `process.getBuiltinModule`.

This does not stop code that sets out to escape. Application code or one of its dependencies can still alias a
framework object past the checker, or read the runtime database URL from `/proc/self/environ`. A dependency's code
is not read by the checker at all. Object-level access independent of application code needs an isolated handler
host or a platform data executor, both rejected for now (Alternatives); within Postgres, the role family bounds the
damage to the application's own schema.

### 9. A declaration states the surface, never an operation

A declaration is read by the platform without running application code: the static reader, the artifact, the proxy
table and the approval diff all work from it. So it describes the surface:

| Belongs in a declaration   | Examples                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Where a request enters     | path, method, mount prefix                                                                                  |
| Who may send it            | callers, access forms, `public`                                                                             |
| How it is admitted         | body codec, body and time limits, origins, rate buckets, challenge, signature                               |
| What it carries            | input and output shapes, file fields, a file answer, a redirect and its allowed targets                     |
| What reach the code holds  | capabilities, workload actions, `sql`, `unscoped`, `connect`, `issues`, `binds`, `signs`, `kicks`, `egress` |
| What platform state exists | tables and their policies (file columns included), file kinds, token purposes, job schedules                |

Never in a declaration: which rows a request writes or reads, how input maps to them, what an answer is computed from,
or a lifecycle step written as an option flag. The framework still does the platform work a declaration asks for: it
parses, admits, encodes, quarantines, verifies signatures, schedules and cleans up.

The test for a new option: **does it bound what code may do, or does it make the framework perform an application
operation?** `kicks: ['intake']` bounds; a `then: 'intake'` that kicks on every commit performs. A table's `insert`
action bounds; a generated upload endpoint performs.

Corollary: **every request that touches application data runs a handler**, with its caller's capabilities or as a
declared workload (a job, a webhook, a public procedure). The framework serves on its own only what the platform owns:
SPA files, the browser config, the caller document, health and signature verification. So the framework has no form
kind, no inbox table, no generated file endpoint and no generated webhook binding endpoint.

The procedure kinds follow the credential, not the encoding. An RPC procedure (a session or a service key), a link
procedure (an IAM link key with its share SPA) and an export procedure (a consumer application with a versioned
contract) share one procedure engine. Public access is an access form, not a kind (§10). The body codec follows the
input and the HTTP shape (§11).

### 10. Access forms: public, and several capabilities

- **`access: { public: true }`** on an RPC procedure says anyone may call it. Its top-level `actions` say what the
  handler may do. It runs as the endpoint's own workload, which IAM signs for, and the data layer narrows its reach
  ([ADR-0063](0063-a-public-procedure-runs-as-its-own-workload.md)). A group whose procedures are all public declares
  no callers: `app.group({}, (r) => …)`.
- **`access: { capabilities: { <name>: <form>, … } }`** hands a handler at least two capabilities, each `{ action,
  over }`, `{ action, in, from }` or `{ action, on, from }`. An operation that reads one dimension and writes another
  then stays on the road. The proxy checks every requirement; the runtime mints each capability through the one issuer,
  in declared order, the first refusal answering (`on` 404, `in` and `over` 403); the handler reads
  `ctx.capabilities.<name>` and binds each with `ctx.db.on`, `.in` or `.over`. An endpoint of several capabilities has
  no `ctx.target`, `ctx.within`, `ctx.db.app`, members or links. The generated tests add a denied case per
  capability. `creates`, `app` and an export take no `capabilities`.

`capabilities` removes one cause of off-road reach, not all. Reads across tables (joins, filters over related tables,
aggregates) and locks over many rows still need `sql`.

### 11. Admission, limits and the HTTP shape

- **`admission: { origins?, rate?, challenge? }`** on every procedure. `rate` holds `perClient` (by the client
  address, public procedures only), `perCaller` (by principal or link key, credentialed and link procedures only),
  `perEndpoint` (every call) and `bytesPerHour`. Every bucket is charged before the body is read and stays charged
  whatever the handler does. A public mutation counts 10 per client and 100 for the endpoint per minute unless it
  declares its own; a declared `rate` merges into that default, and `null` turns one bucket off. A public query and a
  credentialed procedure have no bucket unless they declare one: a bucket is a database write per call. `origins` is
  `'same-origin'` by default, `'listed'` for the environment's listed origins (bearer only when credentialed), or
  `'any'` (public only). `challenge` (public only) names its provider and the variables of its secret and site key.
- **`limits: { maxBytes?, timeoutMs? }`** on every procedure, webhook and job, and nothing else. A procedure's body is
  64 KiB by default and at most 1 MiB; with file fields its default adds each field's files at the kind's `maxBytes`,
  at most 48 MiB. The body must arrive within `max(30 s, maxBytes at 16 KiB/s)`, which stays below the hour a pending
  file is safe from the sweep ([ADR-0061](0061-a-file-is-a-value-in-a-table-column.md)). The handler's time starts
  after the last body byte: 10 s by default, at most 60 s, on a procedure and a webhook. A webhook's body is 1 MiB. A
  job runs 15 min by default, at most 24 h. The file count comes from the schema's `.max(n)` (at most 20), the
  per-file size from the kind.
- **`http: { method?, query?, body?, cache? }`** describes the wire independently of the output.
  - `method` is `POST` by default. A query may declare `GET`, and is `GET` by default when its output is a file or it
    declares `cache`; its input is then read from flat scalar URL parameters in their canonical spelling, a name sent
    twice refused, the URL bounded. A mutation is `GET` only when it is public and its input holds a required signed
    token (§14), and it answers `redirect()` or a schema; the approval reads "changes state on GET; link scanners may
    trigger it". A session mutation is never `GET`: a top-level navigation carries the session cookie.
  - `query`, on a `POST` only, is a flat schema of the URL's parameters, passed to the handler as `query`.
  - `body` is JSON by default, multipart when the input has a file field, and `'urlencoded'` for flat scalar fields
    without files, which a native HTML form sends.
  - `cache`, on a public `GET` query only, is `{ maxAgeSeconds }` (1 s to a year) or `'immutable'` (a year, for an
    input that names a value that never changes, such as a file id). A successful answer gets `Cache-Control: public`;
    every other answer and every other procedure is `no-store`.
- **`redirect({ origins? })`** is an output. The handler returns `{ to }`, and the framework answers 303 after a
  `POST` and 302 after a `GET`, to a path of the application's own origin, a URL of a listed origin, or a URL that a
  verified signed token of this request carries. Any other target is a 500 and a log line, never an open redirect. A
  request whose `Accept` names JSON and not HTML (the typed client) gets `200 { result: { to } }` instead.
- **`ctx.client`** is `{ ip, userAgent }` on every request context: information, never a check.

Each of these compiles into the artifact, and the effective value of every bound, derived ones included, is shown in
the approval ([ADR-0050](0050-approved-access.md)). The proxy applies the browser admission matrix from the row
([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md), "Cross-origin endpoints").

### 12. Kicks, claims and idempotent writes

A mutation, a webhook or a job declares `kicks: ['<job>']` and calls `ctx.kick('<job>')`; the framework sends the kick
after the commit. A job drains its rows with the data layer's `claim` over a table whose policy declares `queue`, and
finishes each through `row.ref` in a transaction of its own
([ADR-0060](0060-a-handler-kicks-a-declared-job-after-its-commit.md)). `insert(values, { onConflict })` writes
idempotently without `sql`.

### 13. Webhooks

- **`scheme`** is a preset (`github-sha256`, `standard-webhooks`, `stripe`) or a shape the framework computes:
  `{ hmac: { header, algorithm, encoding, prefix?, timestamp?, signed: 'body' | 'timestamp.body', id? } }`, checked
  against the binding's secret over the raw body. A signed timestamp must be within five minutes. A verifier is never
  application code. `{ basic: true }` and `{ bearer: true }` are refused at build: the proxy removes `Authorization`
  from an anonymous row's request ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) rule 3), so they could
  never verify.
- **`boundTo`** is a dimension or `'app'`. One binding of an `'app'` webhook serves the whole application, and its
  handler mints `ctx.app('<action>')` like a job.
- **Binding** is a procedure's: a credentialed mutation that declares `binds: '<webhook>'` calls
  `ctx.webhooks('<webhook>').bind(capability, account)` or `.unbind(capability, id)` with this request's `Ref` of the
  bound dimension or its `AppCapability`, in its transaction, and answers the secret once (`WebhookSecret`). The
  framework owns the secret, the binding storage, the replay records and the signature check. Only a `github-sha256`
  webhook of an older framework release keeps generated binding endpoints, which the platform still serves.
- **The delivery claim is recoverable.** The replay key is claimed with a lease (the handler's time limit plus 30 s)
  and completed in the handler's transaction, right before it commits. A failure gives the claim back; a claim whose
  lease passed without completion is taken over by the provider's redelivery. Delivery stays at-least-once, so a
  handler writes idempotently (§12).
- A webhook handler may `put` files ([ADR-0061](0061-a-file-is-a-value-in-a-table-column.md)).

### 14. Signed tokens and links to the application

- **A purpose is declared once**, in the kit's options: `defineApp(…, { tokens: { unsubscribe: token(Recipient, {
  maxDays: 400 }) } })`. The claims schema and the longest lifetime live there, not at each use. The contract carries
  the kit's purposes; a handler types the claims it verifies and a site the claims it signs without importing the
  contract.
- **Verifying.** `signedToken('<purpose>')` is a top-level field type of a procedure's input or its `http.query`. The
  framework verifies an HMAC-SHA256 over the key id, the purpose, the expiry and the claims as it parses the input,
  parses the claims again by the purpose's schema, and the handler receives the typed claims.
- **Signing.** A procedure of an RPC mount, a job or a webhook that declares `signs: ['<purpose>']` calls
  `ctx.tokens.sign('<purpose>', claims, { days })`, `days` at most the purpose's `maxDays`. An export and a link
  procedure never sign.
- **Keys.** Each application environment has its own keys. Control keeps them in its vault and hands them as
  `FABRIKA_TOKEN_KEYS`, the signing key first. `apps.environments.rotateTokenKey` asks the next deploy to rotate; a
  platform upgrade never rotates. A retired key verifies until its retirement plus the largest `maxDays` the contract
  had while it signed, so a 400-day unsubscribe link survives a rotation and a later shorter `maxDays` cannot cut it
  off.
- A token is single-purpose and no credential: it opens no mount. Single use and revocation are the application's
  state. A token fits one action without a session (unsubscribe, a tracked click, managing one booking); a link mount
  fits a holder who works over an object across visits.
- **`ctx.url('<endpoint id>', { input?, query? })`** on every site builds an absolute link to one of the application's
  own procedures: the environment's canonical origin (`FABRIKA_APP_ORIGIN`, which every deploy writes), the
  procedure's path, and the parameters its HTTP shape reads from the URL. The checker's `url-endpoint` rule refuses a
  literal id that names no procedure.

### 15. Egress and mail

- **`egress: ['https://<host>']`** on a credentialed RPC procedure, a webhook or a job declares the exact HTTPS origins
  its code calls: no path, no wildcard, at most 16. `boot` wraps the global `fetch` once; while a site's handler runs,
  a call to an origin the site does not declare is refused (`undeclared_egress`). A site that declares none reaches no
  origin. The framework's own requests (mail, connectors, IAM, the object store) run outside the site's scope. This
  stops mistakes and makes a bypass conspicuous; it is no sandbox (§8): code that kept the `fetch` it found before
  boot, or opens its own sockets, escapes it. The checker's `cross-app-fetch` rule accepts an absolute URL under an
  origin some site declares.
- **Mail.** `ctx.mail.send` in a mailer job takes `attachments: [fileRef]` (only a `live` file the attempt holds, within
  the transport's `maxAttachmentBytes`) and `unsubscribe: { url }`, from which the transport writes `List-Unsubscribe`
  and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). There are no free headers. A transport without
  the capability refuses the message on the send ([ADR-0019](0019-portable-outbound-email.md)).

### 16. A mount may promise backward compatibility

`c.rpc('/api/v1', groups, { compatibility: 'backward' })` gets the export's rule: Control refuses a publication that
removes a procedure of the mount, narrows its input or `http.query`, changes its output, its HTTP shape, its file
answer or its access, or removes or moves the mount, whoever approves it. The approved side's promise binds, so the
deploy that drops the promise is still held to it. A breaking change is a new mount (`/api/v2`) beside the old one.
The default is `'unchecked'`.

## Consequences

- An application declares its access surface once. The proxy's endpoint table, the IAM vocabulary, the
  router, the typed client and the handler types derive from it.
- Each fact is written once: the action names and the containment in the vocabulary, the table scopes derived from
  it, each endpoint and its handler in one place. No mirrored handler tree and no hand-written store restate them.
- A missing access declaration is a type error and a path no endpoint serves. A forgotten endpoint
  stops being a silent hole. A missing handler stops `serve`.
- The router and the proxy select by one table, so a path cannot pass one endpoint's rules and reach a
  different handler.
- The straightforward handler is the sound one: it reads and writes through its capability, in one transaction, with
  optimistic or locking preconditions, and cannot name another scope's rows without declaring so.
- An agent that needs more than the road gives does not loosen access or invent a hack: it declares `sql`,
  `unscoped`, `connect`, `issues` or database code, and the change waits for a human on a protected environment with
  a "needs closer review" line. A declaration is reviewable; the code behind it is the review's to read.
- The literal rule makes the shell more verbose. Shared schema fragments must be `const` imports;
  computed contracts are impossible. Handlers are ordinary TypeScript.
- Contracts depend on zod 4. Other validators cannot appear in a contract.
- `@fabrika/app` has two serving surfaces: `serve` for applications and `serveService` for the
  installation's own services. Both dispatch through `planEndpoint` and run on the same runtime
  adapters; a service's typed RPC mount uses the same RPC wire (`dispatchRpcRequest`).
- RPC clients can no longer send `{ batch }`. One request is one procedure.
- `@fabrika/auth-core` holds the contract model, `planEndpoint` and the requirement check. The proxy
  and the framework select with the same `planEndpoint`, and the per-endpoint digest proves they
  applied the same rules.
- A loosened contract or role does not reach a protected environment unseen: Control reads it from source, and the
  widening waits for a human (ADR-0050). On an unprotected environment it applies at once, so there the framework
  and the review are the only checks.
- Data security is not statically provable. A handler with `sql: 'write'` can write any row the runtime role can;
  the proxy, the approval and the role are what bound it, not the framework.
- The framework generates no data endpoint. Each operation an application wants (an upload, a file list, a webhook
  binding, an anonymous submission) is a procedure of a few lines that the approval reads like any other and the
  generated access tests cover. A helper the handler calls keeps it short; a helper adds no reach, because the
  capability it uses comes from `ctx`.
- Less reach goes off the road: an operation over two dimensions (`capabilities`), an outbox drain (`claim`) and an
  idempotent write (`onConflict`) stay on it. Reads across tables (joins, filters over related tables, aggregates) and
  locks over many rows still need `sql`; a read block for the road is its own decision.
- Anonymous entry, signed one-action links, outbound calls and file storage each have one declared, reviewable form,
  and the approval shows the effective value of every bound.
- `{ basic }` and `{ bearer }` webhook verifiers wait for a proxy decision on `Authorization` for anonymous rows. A
  provider that issues its own secret (Stripe, Standard Webhooks senders) needs a set-secret operation that `bind`
  does not have: `bind` generates the secret. Slack and Twilio signatures do not fit `{ hmac }`.
- An application on framework 0.4 or 0.5 keeps its forms, inbox tables, `then`, file collections, generated file and
  webhook endpoints and job options: Control reads it with its own release's reader, and the platform keeps serving
  them inside the window ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)). An author moves to
  this form when raising the pin ([`framework-migrations.md`](../reference/framework-migrations.md)).

## Alternatives considered

- **Keep a separate schema module and rule list and add a consistency check.** Rejected: a check
  catches disagreement between the files, not a widening that keeps them consistent.
- **Code-first: mounts inside a router, the access surface extracted by importing the application.**
  Rejected: the build must execute the application's module graph, and the extracted data is the
  application's self-report. The shell slice keeps handlers beside their endpoints without that: the reader reads
  the declarations and never runs or fetches the handlers.
- **A literal contract with a mirrored handler tree (`implement(contract, { handlers })`).** It was the first form.
  Replaced: every endpoint is written twice, the tables restate the action names, and a spike of colocated handlers
  gave a byte-identical approval diff at fewer type instantiations.
- **Tables typed by `typeof contract`.** Rejected: with handlers in the contract's slice modules the types form a
  cycle (TS7022). The staged order — vocabulary, tables, kit, groups, contract — has none.
- **File-based routing.** Rejected: per-endpoint requirements stay invisible outside the application,
  URLs move with files, and a spike of it cost 42 % more lines.
- **Resource-first: tables with policies and generated CRUD, or entity sugar on top of the contract.** Rejected:
  strong for CRUD, with an expressiveness cliff for everything else; two spikes of entity sugar did not pay for
  themselves.
- **Declared operations** (`c.read`/`c.update` with `when`, `set`, `inc`): every data operation declared in the
  contract, so the platform could read what each endpoint does. Rejected as too declarative: business logic is
  TypeScript, and only the reach off the road is declared.
- **Application-wide data as `over` of a dimension, or an `over` endpoint that writes an application table when its
  `Within` is `'all'`.** Rejected: the approver reads "over candidate" for data that belongs to no candidate, and
  whether such an endpoint may write would depend on each caller's grants at run time, so a scoped caller would fail
  inside the handler. The `app` form puts the requirement where the proxy checks it: the action held as a global
  grant. Its reads of the dimension tables by the read action add no authority, because that holder already lists
  every row through `over`; an `appRead` or `appCount` action does add authority, so the table's policy names it and
  the approver sees it as a widening of that table.
- **An `app` endpoint that names the read action it reads with** (`{ action: 'candidates.export', app: true, reads:
  'candidates.read' }`), the proxy requiring both global grants. Rejected: a second action in the requirement, and in
  the proxy, for what a table action states as data of the policy, which the approval diff already shows.
- **Deriving zod inputs from table rows.** Rejected: a spike lost bounds silently and turned a migration into an API
  change. `fromRow` covers outputs.
- **Refuse raw SQL and add declared report kinds to the scoped builder instead.** Rejected: every report shape
  (aggregates over joins, anti-joins, nested conditions, SQL functions, full-text search) would need its own kind,
  and an agent that hit a gap loaded every row or worked around the framework. Raw SQL, declared and parametrized in
  the invocation's transaction, is one reviewable step.
- **Detect steps off the road syntactically in handler code.** Rejected as the boundary: destructuring, helper
  modules and `ctx[k]` evade it. It stays a checker hint; the declaration in the shell is what the runtime enforces.
- **Row-level security, or any attempt to make data security statically provable.** Rejected: it constrains the
  arbitrary code the road is meant to allow, and the high-level guarantees (the proxy, the approval, the role) do
  not depend on it.
- **An isolated handler host, or a platform data executor that holds the database credentials.** Rejected for now:
  they are the only designs that make object-level access independent of application code, but an earlier spike
  built an executor and dropped it as too costly for the first users. They remain the long-term hard boundary;
  `@fabrika/db` runs in the application process.
- **Keep middleware and raw routes for applications next to the contract.** Rejected: any slot for
  raw surface is a path that the contract and the proxy's table do not describe.
- **A computed contract.** Rejected: the platform could read it only by executing application code.
- **Accept any Standard Schema validator in contracts.** Rejected: the contract must be readable
  without evaluation, which needs one known set of schema calls.
- **A closed list of named webhook providers.** Rejected: one framework release per provider. Presets plus a
  framework-owned `{ hmac }` shape cover most providers. Slack stays out: it signs with one secret per Slack app and
  its signature does not cover the URL, so one tenant could replay its own signed delivery to another tenant's binding.
- **Keep `c.form`, the inbox scope, `then` and generated file and webhook endpoints.** Rejected: each encodes an
  operation, and anything it needs beyond that becomes a new option with its own runtime (§9). A declaration macro
  that expands `c.form` into a procedure keeps the inbox concept and hides the handler to save four lines.
- **Fixed HTTP rules per use** (`GET` only for a file query, an `inputFrom` for unsubscribe, a `GET` mutation only with
  `redirect()`). Fewer knobs, but each rule exists for one scenario. One `http` shape, independent of the output,
  covers them all.
- **Rate buckets on every public procedure by default.** Rejected: a database write per image of a page. A public read
  is bounded by the in-flight share and its cache.
- **A token schema at each use and a short rotation overlap.** Two uses may disagree, and a rotation breaks year-long
  unsubscribe links. A purpose declares its claims and lifetime once, and keys verify until their last token expires.
- **A link key in an e-mail's URL.** A credential in logs and referrers. A single-purpose signed token opens no mount.
- **Undeclared outbound calls**, or a provider network policy. Undeclared calls are invisible to the approver; a
  network policy is stronger and stays possible later. Dynamic destinations (outbound webhooks to customer URLs) need
  approved destination bindings, a decision of their own.
- **Keep `@trasa/core` independent and add a Fabrika integration package.** Rejected: the shared auth
  contracts and the framework are one product surface and must change together.
