# references/errors.md — what the checker, the compiler and the runtime tell you

## The checker: refusals and hints

`bunx fabrika-check .` prints one finding per line, `<file>:<line>:<col> <rule> <what> (allowed form: <fix>)`.
Refusals come first and fail the check; hints follow under their own heading and do not. Fix both: a hint is the
architecture, and a refusal's allowed form is the one fix that passes. There is no suppression syntax.

The refusals agents meet most, and their fix:

| Rule                           | Means                                                                                                                                                                                                                                                     | Fix                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `literal`                      | the shell (contract, vocabulary, tables, groups, schemas) holds a computed value or call                                                                                                                                                                  | literal objects, `z.*` calls and imported literal consts; move logic into `.handle(…)`    |
| `contract`                     | the contract does not compile (a reserved role, an unknown action, a wrong field)                                                                                                                                                                         | the message names the field                                                               |
| `package-replacement`          | `package.json` names the app under `@fabrika/*`, or a dependency is `workspace:*`                                                                                                                                                                         | another name; a registry range such as `^0.0.4`                                           |
| `generated-test-hash`          | a generated test is missing, edited or stale                                                                                                                                                                                                              | `bunx fabrika db test-scaffold`, and commit what it writes                                |
| `endpoint-fixture`             | an endpoint's input cannot be sampled, a fixture or seed names no endpoint, a member, invitation or link field no endpoint that reads, cancels or revokes one, a file names no file field or a path outside the application, or a refusal is `validation` | a literal in `src/__tests__/endpoint-access.fixtures.ts` (`references/tests.md`)          |
| `raw-sql`                      | a driver's `sql` (imported from `bun`, Kysely, `postgres`)                                                                                                                                                                                                | the handles, or `sql: 'read'` and `ctx.sql`                                               |
| `forbidden-import`             | a driver, an S3 client, `jose`, `node:http`, `child_process`                                                                                                                                                                                              | the handles, a file column with `ctx.files`, a connector                                  |
| `forbidden-global`             | `Bun.sql`, `Bun.serve`, `Bun.spawn`; `globalThis`, `window`, `self`, `global` or `Bun` in a server module                                                                                                                                                 | the handles; state lives in a table, not in a global; `crypto.randomUUID()` for an id     |
| `env-read`                     | `process.env`, `Bun.env`                                                                                                                                                                                                                                  | `defineDeps(build)`, which receives the application's variables                           |
| `client-identity`              | an input field `userId`, `ownerId`, `createdBy`, `tenantId`, `workspaceId`                                                                                                                                                                                | the access form's `from`, `ctx.principal.id`, or `createdBy` in the policy                |
| `type-assertion`               | `as T` (other than `as const`), `<T>x`                                                                                                                                                                                                                    | fix the type; `fromRow` parses a row into a schema's type                                 |
| `sensitive-log`                | a log of an error object, a request, headers or the environment                                                                                                                                                                                           | log a short fixed message                                                                 |
| `migration-name`               | a migration not named `YYYYMMDDHHMMSS_slug.sql` (UTC)                                                                                                                                                                                                     | `bunx fabrika db new <slug>`                                                              |
| `test-only-import`             | `@fabrika/app/testing`, `@fabrika/app/react/testing`, `@fabrika/db/testing` or `@fabrika/db/testing-sqlite` outside a test file                                                                                                                           | import them only from `*.test.ts` or `__tests__/`                                         |
| `spa-server-import`            | the SPA loads a server module                                                                                                                                                                                                                             | the SPA imports `@fabrika/app/client`, the contract, `src/schemas.ts` and `src/shared/`   |
| `shared-import`                | a module under `src/shared/` loads a slice, `src/db/`, `@fabrika/*` or a builtin                                                                                                                                                                          | a shared module imports `zod/v4` and other shared modules only                            |
| `skipped-test`                 | `.skip`, `.only`, `.todo`                                                                                                                                                                                                                                 | run the test                                                                              |
| `file-column-migration`        | a file column without `REFERENCES fabrika_files (id)` or without an index it leads                                                                                                                                                                        | both, in a new migration (`references/table-and-migration.md`)                            |
| `on-conflict-index`            | `insert(…, { onConflict: { columns } })` whose columns are no unique index the migrations create                                                                                                                                                          | a `UNIQUE` constraint or a `CREATE UNIQUE INDEX` without `WHERE` on exactly those columns |
| `cross-app-fetch`              | a `fetch` of an absolute URL under no origin a site declares in `egress`, or one a job's `egress: 'public'` refuses (an IP address, `localhost`)                                                                                                          | `egress: ['https://…']` on the site that calls it (`references/endpoint.md`)              |
| `url-endpoint`                 | `ctx.url('<id>')` names no procedure of the contract                                                                                                                                                                                                      | the endpoint id `<mount>.<group>.<procedure>`                                             |
| `cloudflare-sql`               | on Cloudflare, a site that declares `sql`                                                                                                                                                                                                                 | the handles (`ctx.db`), without `sql`                                                     |
| `cloudflare-scan`              | on Cloudflare, a file kind with `scan: true`                                                                                                                                                                                                              | the kind without `scan`, and no public procedure that takes its files                     |
| `cloudflare-current-timestamp` | on Cloudflare, `DEFAULT CURRENT_TIMESTAMP` in a migration: SQLite stores `YYYY-MM-DD HH:MM:SS`, which every read of the table refuses                                                                                                                     | `DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`, in a new migration                     |

The hints:

| Hint                   | Means                                                                                                    | Fix                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `handler-location`     | a `.handle(…)` outside a slice's `endpoints.ts`                                                          | move the endpoint into `src/<slice>/endpoints.ts`                                      |
| `data-access-location` | `ctx.db` or `ctx.sql` outside `endpoints.ts` and `queries.ts`                                            | pass the handle into a function of the slice's `queries.ts`                            |
| `logic-data-access`    | `logic.ts` reaches data                                                                                  | keep `logic.ts` pure; pass it plain values                                             |
| `cross-slice-queries`  | a slice loads another slice's `queries.ts`                                                               | move the function, or call that slice's endpoint                                       |
| `sql-undeclared`       | `ctx.sql` in a handler whose endpoint declares no `sql`                                                  | add `sql: 'read'` (or `'write'`) to that endpoint                                      |
| `cloudflare-held-call` | on Cloudflare, a mutation that declares `egress` or `connect` holds the whole environment while it waits | record a row and `ctx.kick('<job>')`; the job makes the call outside `ctx.transaction` |

The first run may report only the contract's refusals: the generated-test findings appear once the contract compiles.

## Type errors

A kit error lands on the line of the mistake, in one or two lines that name the fix. Read the last line first.

| The compiler says                                                               | Fix                                                                     |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `add .handle(…) to tasks.get: every endpoint takes its handler beside it`       | add the handler; when the handler exists, fix the error inside it first |
| `the handler returns version, which the output does not declare`                | return only the output's fields                                         |
| `… where the output is camelCase: map it with fromRow(Schema, row)`             | `fromRow(Schema, row)`                                                  |
| `update on tasks needs the action 'tasks.write', and this endpoint holds '…'`   | the endpoint's action, a column write action, or a separate endpoint    |
| `getForUpdate locks the row, so it runs only in a mutation`                     | `r.mutation`                                                            |
| `update acts on one object: declare access with on`                             | access `on`, not `in` or `over`                                         |
| `tasks is not under in: 'org' (it lies in project): declare …`                  | the access form the message names                                       |
| `ctx.sql needs a declaration: add sql: 'read' …`                                | declare `sql` on the endpoint                                           |
| `tasks is outside this site's scope: declare unscoped: { tasks: 'read' } on it` | declare it, or use the capability's handles                             |
| `a job writes inside ctx.transaction((tx) => …): use tx.db there`               | move the write into the transaction                                     |
| `listing the members of org needs the action '…'; get(principalId) checks one`  | `ctx.members.get(id)`, or an endpoint of the directory's `members.list` |
| `neither task nor a dimension containing it declares members`                   | declare `members` on the dimension whose people the endpoint picks      |
| `'member.label' is possibly 'null'`                                             | a nullable column or output; only `directory: 'labels'` makes it text   |
| `admin is a role IAM defines itself for every application (reserved: admin)`    | another role name                                                       |
| `Property 'id' does not exist on type 'Ref<…>'`                                 | `ctx.target.value`                                                      |
| `Property 'margin' does not exist on type 'Omit<DealsTable, "margin">'`         | the column has its own read action, which this capability lacks         |
| `Type 'Date' is not assignable to type 'string'` on a `date` column             | a `YYYY-MM-DD` string                                                   |
| `Cannot find module '@fabrika/…'` and implicit `any`s everywhere                | `bun install` (at the repository root in a monorepo)                    |

## Runtime answers

A procedure and a webhook answer JSON in an envelope: a 200 is `{ result: <output> }`, any other status
`{ error: { type, message } }`. The typed client unwraps it; a plain `fetch` (a test) reads `result`. A file answer,
a health check (`{ status: 'ok' }`) and the SPA's browser configuration answer without one.

| Answer | Comes from                                                                                                                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | the input does not match its schema; `BadRequestError`                                                                                                                                                                                   |
| 401    | no valid credential. In a test, the caller is missing                                                                                                                                                                                    |
| 403    | the caller lacks the action, or for `in` the scope: a missing grant, never a bug to code around; `ctx.members.list()` below the org for a caller without the list action on the org itself; a path no endpoint declares                  |
| 404    | `on`: the object does not exist or is not the caller's, also when a concurrent delete removed it first; `NotFoundError`                                                                                                                  |
| 409    | a stale `expectVersion`; `ConflictError`; a lost `getForUpdate` race                                                                                                                                                                     |
| 500    | a throw without a numeric `httpStatus` below 500, a `type` and a `message`, a refused statement, a call of `ctx.sql` the endpoint does not declare (`undeclared_reach`), a `ctx.sql` row the schema refuses (`count(*)` without `::int`) |
| 503    | IAM cannot be asked, or the member directory has no transport                                                                                                                                                                            |

An undeclared path is 403 at the proxy, also for a signed-in caller who holds every action: the proxy serves only the
contract's endpoints, picks the most specific one, and never falls through to a broader one. A test that asks for a
route you did not declare (an edit that does not exist) expects 403, not 404. An unknown procedure that reaches the
application under an RPC prefix is 404, but the proxy stops it first.

A connector call is not an HTTP answer: it resolves to an outcome (`references/webhooks-links-connectors.md`), and the
handler decides what to answer. Any thrown value with a numeric `httpStatus` below 500, a `type` and a `message` (an
`HttpError` of `@fabrika/app`, such as `ForbiddenError`, or a plain object of those fields) answers its own status
with its message; throw the three business errors for the application's own refusals.

A 500 answers a fixed message; the server log has one line, `fabrika: <endpoint>: <code>: <reason>: <text>`, with a
fixed failure code and, for a framework refusal, its reason and the reason's fixed text, never a value or your error's
message. The codes you meet most:

| Code                 | Means                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `query_refused`      | the data layer refused a statement or an operation: `undeclared_reach`, `sql_read_only`, `unknown_column`, `read_only`, `sql_outside_transaction`, `sql_dialect` (`ctx.sql` on SQLite, Cloudflare) …; the reason's text names the rule                                         |
| `capability_refused` | a capability of another kind, dimension or action than the call takes (`wrong_capability`, `wrong_action`, `out_of_reach`), one kept past its request (`ended`, `foreign_work`), or a `fetch` its `egress` refuses (`undeclared_egress`, `refused_egress`, `oversized_egress`) |
| `handler_failed`     | your handler threw something else; the log has no more: the Operations issue has the stack, or test the handler                                                                                                                                                                |

With an Operations DSN the same 500 is a `RequestFailed` issue in Operations. Its event also carries what your handler
threw: the error's type, its message, its stack and its `cause` chain. Read the stack there, not in the log. A crash
outside a request (an uncaught exception, an unhandled rejection, a failed start) is an issue too, titled by the error.

The framework removes the values of your secrets and anything shaped like a credential (a token, a key, a password in a
URL) from the message before it leaves. It cannot recognize personal data or a secret it was not told about:

- never put an e-mail address, a name, a record's text or any other personal data into an error message; name the
  record by its id;
- never put a secret, a token or a request header into an error message;
- name an application variable that holds a secret so its name says so (`STRIPE_SECRET_KEY`, `MAIL_API_TOKEN`): only
  such a name tells the framework to remove its value;
- keep the original error as `cause` when you rethrow (`throw new Error('could not load the invoice', { cause })`), so
  the chain shows both.

A job attempt names its failure with the
same codes and reasons: `fabrika job run` prints `job <name> failed after 1 attempt: query_refused: undeclared_reach`,
its log line adds the text, and `kit.runJob` answers `{ status: 'failed', code, reason }`. A `DatabaseError` carries
only the SQLSTATE: `23505` is a unique violation, `23503` a foreign key, `23502` a null in a `NOT NULL` column.
