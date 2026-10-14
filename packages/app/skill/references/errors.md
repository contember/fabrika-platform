# references/errors.md — what the checker, the compiler and the runtime tell you

## The checker: refusals and hints

`bunx fabrika-check .` prints one finding per line, `<file>:<line>:<col> <rule> <what> (allowed form: <fix>)`.
Refusals come first and fail the check; hints follow under their own heading and do not. Fix both: a hint is the
architecture, and a refusal's allowed form is the one fix that passes. There is no suppression syntax.

The refusals agents meet most, and their fix:

| Rule                  | Means                                                                                                               | Fix                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `literal`             | the shell (contract, vocabulary, tables, groups, schemas) holds a computed value or call                            | literal objects, `z.*` calls and imported literal consts; move logic into `.handle(…)` |
| `contract`            | the contract does not compile (a reserved role, an unknown action, a wrong field)                                   | the message names the field                                                            |
| `package-replacement` | `package.json` names the app under `@fabrika/*`, or a dependency is `workspace:*`                                   | another name; a registry range such as `^0.0.4`                                        |
| `generated-test-hash` | a generated test is missing, edited or stale                                                                        | `bunx fabrika db test-scaffold`, and commit what it writes                             |
| `endpoint-fixture`    | an endpoint's input cannot be sampled, a fixture or seed names no endpoint, or a member field no directory endpoint | a literal in `src/__tests__/endpoint-access.fixtures.ts` (`references/tests.md`)       |
| `raw-sql`             | a driver's `sql` (imported from `bun`, Kysely, `postgres`)                                                          | the handles, or `sql: 'read'` and `ctx.sql`                                            |
| `forbidden-import`    | a driver, an S3 client, `jose`, `node:http`, `child_process`                                                        | the handles, a file collection, a connector                                            |
| `forbidden-global`    | `Bun.sql`, `Bun.serve`, `Bun.spawn`; `globalThis`, `window`, `self`, `global` or `Bun` in a server module           | the handles; state lives in a table, not in a global; `crypto.randomUUID()` for an id  |
| `env-read`            | `process.env`, `Bun.env`                                                                                            | `defineDeps(build)`, which receives the application's variables                        |
| `client-identity`     | an input field `userId`, `ownerId`, `createdBy`, `tenantId`, `workspaceId`                                          | the access form's `from`, `ctx.principal.id`, or `createdBy` in the policy             |
| `type-assertion`      | `as T` (other than `as const`), `<T>x`                                                                              | fix the type; `fromRow` parses a row into a schema's type                              |
| `sensitive-log`       | a log of an error object, a request, headers or the environment                                                     | log a short fixed message                                                              |
| `migration-name`      | a migration not named `YYYYMMDDHHMMSS_slug.sql` (UTC)                                                               | `bunx fabrika db new <slug>`                                                           |
| `test-only-import`    | `@fabrika/app/testing` or `@fabrika/db/testing` outside a test file                                                 | import them only from `*.test.ts` or `__tests__/`                                      |
| `spa-server-import`   | the SPA loads a server module                                                                                       | the SPA imports `@fabrika/app/client`, the contract and `src/schemas.ts` only          |
| `skipped-test`        | `.skip`, `.only`, `.todo`                                                                                           | run the test                                                                           |

The hints:

| Hint                   | Means                                                         | Fix                                                         |
| ---------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| `handler-location`     | a `.handle(…)` outside a slice's `endpoints.ts`               | move the endpoint into `src/<slice>/endpoints.ts`           |
| `data-access-location` | `ctx.db` or `ctx.sql` outside `endpoints.ts` and `queries.ts` | pass the handle into a function of the slice's `queries.ts` |
| `logic-data-access`    | `logic.ts` reaches data                                       | keep `logic.ts` pure; pass it plain values                  |
| `cross-slice-queries`  | a slice loads another slice's `queries.ts`                    | move the function, or call that slice's endpoint            |
| `sql-undeclared`       | `ctx.sql` in a handler whose endpoint declares no `sql`       | add `sql: 'read'` (or `'write'`) to that endpoint           |

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
| `admin is a role IAM defines itself for every application (reserved: admin)`    | another role name                                                       |
| `Property 'id' does not exist on type 'Ref<…>'`                                 | `ctx.target.value`                                                      |
| `Property 'margin' does not exist on type 'Omit<DealsTable, "margin">'`         | the column has its own read action, which this capability lacks         |
| `Type 'Date' is not assignable to type 'string'` on a `date` column             | a `YYYY-MM-DD` string                                                   |
| `Cannot find module '@fabrika/…'` and implicit `any`s everywhere                | `bun install` (at the repository root in a monorepo)                    |

## Runtime answers

A procedure, a form, a webhook and a file collection answer JSON in an envelope: a 200 is `{ result: <output> }` (a
procedure's output, a form's `{ received: true }`, a file list's `{ items, next }`), any other status
`{ error: { type, message } }`. The typed client unwraps it; a plain `fetch` (a form, a test) reads `result`. A health
check (`{ status: 'ok' }`) and the SPA's browser configuration answer without one.

| Answer | Comes from                                                                                                                                                                                                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | the input does not match its schema; `BadRequestError`                                                                                                                                                                                                                  |
| 401    | no valid credential. In a test, the caller is missing                                                                                                                                                                                                                   |
| 403    | the caller lacks the action, or for `in` the scope: a missing grant, never a bug to code around; `ctx.members.list()` below the org for a caller without the list action on the org itself; a path no endpoint declares                                                 |
| 404    | `on`: the object does not exist or is not the caller's, also when a concurrent delete removed it first; `NotFoundError`                                                                                                                                                 |
| 409    | a stale `expectVersion`; `ConflictError`; a lost `getForUpdate` race                                                                                                                                                                                                    |
| 500    | a throw without a numeric `httpStatus` below 500, a `type` and a `message`, a refused statement, a call of `ctx.sql` the endpoint does not declare (`undeclared_reach`), an update that sets no column, a `ctx.sql` row the schema refuses (`count(*)` without `::int`) |
| 503    | IAM cannot be asked, or the member directory has no transport                                                                                                                                                                                                           |

An undeclared path is 403 at the proxy, also for a signed-in caller who holds every action: the proxy serves only the
contract's endpoints, picks the most specific one, and never falls through to a broader one. A test that asks for a
route you did not declare (an edit that does not exist) expects 403, not 404. An unknown procedure that reaches the
application under an RPC prefix is 404, but the proxy stops it first.

A connector call is not an HTTP answer: it resolves to an outcome (`references/webhooks-links-connectors.md`), and the
handler decides what to answer. Any thrown value with a numeric `httpStatus` below 500, a `type` and a `message` (an
`HttpError` of `@fabrika/app`, such as `ForbiddenError`, or a plain object of those fields) answers its own status
with its message; throw the three business errors for the application's own refusals.

A 500 answers a fixed message; the server log has one line, `fabrika: <endpoint>: <code>: <reason>: <text>`, with a
fixed failure code and, for a framework refusal, its reason and the reason's fixed text (`sql_read_only`,
`undeclared_reach`, `unknown_column` …), never a value or your error's message. With an Operations DSN the same 500
is a `RequestFailed` issue in Operations. A `DatabaseError` carries
only the SQLSTATE: `23505` is a unique violation, `23503` a foreign key, `23502` a null in a `NOT NULL` column.
