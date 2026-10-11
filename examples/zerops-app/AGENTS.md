<!-- Generated from skill/SKILL.md of @fabrika/app. Change that file, not this one. -->

# Fabrika application rules

An application declares who may call what in `fabrika.contract.ts` and implements it in `src/app.ts`. The proxy
enforces the contract, the data layer (`@fabrika/db`) enforces the table policies, and the checker (`fabrika-check`)
refuses the shortcuts around both. Keep all three intact.

## Ask the human first

- When a request answers 401 or 403, or a generated test fails, do not change the contract, a table policy or a
  role to make it pass. Tell the human which action or role the caller lacks.
- Never loosen a policy to make a test pass.
- Before you add an anonymous endpoint (`c.link`, `c.form`, `c.webhook`), a CSP origin, an export or an import, a
  job or a job action, a role grant, or a table policy change, explain to the human in one sentence what it lets
  someone do, and wait for a yes.
- Never change a table's scope mode without asking. Data repairs go to the operator, not into a job.
- When a tool or the platform refuses a file as protected, stop and ask the human. Do not move the change elsewhere.

## The contract first

- Declare every endpoint in `fabrika.contract.ts`, then implement it. There are no other routes, middleware or
  servers.
- Keep the contract a literal: object and array literals, strings, numbers, top-level `const`s declared above their
  use, and named imports of literal `const`s from relative modules. No spreads, functions or computed values.
- Schemas: `z` from `zod/v4`. Use `z.strictObject`, never `z.object`. No `transform`, `refine`, `pipe`,
  `preprocess`, `passthrough`, `lazy` or `custom`. Compose through factories (`z.nullable(Note)`, `z.array(Note)`),
  never a method call on a schema const.
- Actions are exact names. A role lists actions; there is no `*`.
- Pick the access form by what the endpoint addresses:

| Access                                             | Use it for                          | The handler gets                                   |
| -------------------------------------------------- | ----------------------------------- | -------------------------------------------------- |
| `{ action, on: 'note', from: 'id' }`               | one object, addressed by id         | `ctx.target`; 404 when missing or not the caller's |
| `{ action, over: 'workspace' }`                    | a list                              | `ctx.within`                                       |
| `{ action, in: 'workspace', from: 'workspaceId' }` | creation inside a scope             | `ctx.target` of the scope; 403 when not held       |
| `{ action, creates: 'organization' }`              | a new top-level scope, made by IAM  | `ctx.created`                                      |
| `{ member: true }`                                 | any member, for no application data | nothing                                            |

- Never use `member: true` for an endpoint that returns application data.
- Never take a user, owner or tenant id from the input. The scope comes from the access form.
- Mounts: `c.rpc(prefix, { callers: ['human'] }, procedures)` (or `['machine']`), `c.spa(prefix, { dir, access })`,
  `c.health('/healthz')` (required on Zerops), `c.link`, `c.form`, `c.webhook`. Sections: `files`, `jobs`,
  `exports`, `imports`, `csp`. No path under `/__fabrika`.

## Tables and policies

- Every table has a policy in `src/db/tables.ts`: `defineTables<DB, Action>(columns)({ … })`, with `columns` and
  `DB` from the generated `src/db/schema.generated.ts`.
- A policy names its scope: a dimension table `{ dimension, key, in: { dimension, column } }`, a child table
  `{ child, key, column, inherit }`, or `{ reference: '<why>' }`. A child carries its parent's scope columns and a
  composite foreign key to `UNIQUE (<key>, <chain columns>)` of the parent.
- `actions` maps `read`, `insert`, `update` and `delete` to contract actions. `insert` and `update` list the
  writable columns. `version` names an INTEGER column, `createdBy` the creator column. A column that needs its own
  read action goes in `columns: { name: { read } }`.
- Call `scoped(tables)` once, in `src/db/database.ts`. Define stores with its `defineStore` / `defineChildStore` in
  `src/db/stores/`. Every store function takes a `Ref` or a `Within`, never a bare id.
- A mutation answers `{ id, version }`. Read the row with a read capability when you need it.

## Migrations and codegen

- `fabrika db new <slug>` writes `db/migrations/<UTC YYYYMMDDHHMMSS>_<slug>.sql`. Without a shell, use that name.
- Write plain SQL for the application's own schema. Never name `public`, an `app_…` or a `fabrika…` schema.
- Never edit, rename or delete a committed migration. Add a new one. Change a schema by expand, switch, contract;
  the checker does not refuse a destructive change yet, so ask before you drop or rename anything.
- `fabrika db migrate` (with `FABRIKA_APP_ID` and `FABRIKA_APP_DATABASE_URL`), then `fabrika db codegen`, which
  writes `src/db/schema.generated.ts`. Commit it. The platform runs `fabrika db codegen --verify` at start.
- Codegen types `int8` and `numeric` as strings and refuses JSON, `bytea`, arrays and domains.

## Handlers

- `export default implement(contract, { database, deps, handlers })` in `src/app.ts`. `handlers` is a function of
  what `deps` returned. Never read `process.env`.
- Return only what the output schema declares. Throw `BadRequestError`, `NotFoundError` or `ConflictError` of
  `@fabrika/app` for a client error. Every other error is a 500 with a fixed message.
- Never log an error object, a request, headers or the environment.

## Files, jobs, connectors, members, links, forms and webhooks

- **Files:** to attach files, declare a collection on the owner table, which must have a dimension scope:
  `files: { photos: c.files({ owner: '<table>', read, write, delete, maxBytes, types }) }`. Create its table
  `fabrika_files_<name>` in a migration, with the DDL that `fileTableSql(name, { table, key, chain })` of
  `@fabrika/db` returns. Never return or build a storage URL; downloads go through the application. On Zerops,
  declare one `object-storage` service in `fabrika.config.ts`; the platform writes `FABRIKA_APP_STORAGE_*` from it.
- **Jobs:** background work is a job in the contract: `jobs: { purge: c.cron('0 3 * * *', { actions, scope: 'app' }) }`
  and `handlers.jobs.purge`. Use `ctx.within(action, dimension)` and `ctx.ref(action, dimension, id)`. No
  `setInterval`, self-scheduled timers or loops. A failed attempt is retried, so make each write idempotent. The
  platform gives each job and webhook its own key; never read, set or copy `FABRIKA_JOB_*` or `FABRIKA_WEBHOOK_*`.
- **Connectors:** to use another application's data, import its export. If the export does not exist, ask the
  owner application's maintainer. Run `fabrika connect add <app>/<export>@<version> --consumer=<this app> --env=<env>`,
  then add `imports` to the contract and `connect` to `implement`. `ctx.connect.<import>.<procedure>()` answers an
  outcome; handle every outcome besides `ok`. Exports are read-only. Never import per-user data. The platform writes
  each import's `FABRIKA_CONNECT_*`; never read, set or copy them. A deploy fails when the snapshot is not what the
  owner serves (run `fabrika connect pull`); as an owner, change an export only by adding to it, or by a new version.
- **Members:** a dimension with `members: { manage, list }` gives `ctx.members` to an endpoint whose action is that
  `manage` action. A dimension with a `creator` role can be the target of `creates`.
- **Share links:** `c.link(prefix, { spa, dimension, grants, issuedBy, maxDays, procedures })`. An endpoint whose
  action is `issuedBy` gets `ctx.links.issue(ref, { mount, days })`. The share SPA reads the key with `shareKey()`
  of `@fabrika/app/client`; never read `location.hash`.
- **Forms:** `c.form(path, { input, appendTo })` appends one row to its inbox table. It has no handler.
- **Webhooks:** `c.webhook(path, { scheme: 'github-sha256', boundTo, actions, input })`. A handler runs at least once
  per delivery: a failed run runs again on GitHub's redelivery, after its writes committed. Make each write
  idempotent, keyed on `ctx.delivery.key`.

## Tests

- After every change to the contract or `src/db/tables.ts`, run `fabrika db test-scaffold` and commit what it
  writes: `src/db/__tests__/<table>.policy-isolation.test.ts` and `src/__tests__/endpoint-access.test.ts`.
- When the scaffold cannot sample an endpoint's input, add a plain literal under the endpoint id in
  `src/__tests__/endpoint-access.fixtures.ts`.
- The platform runs `fabrika db test-isolation` at container start. The application is not ready until every
  generated case passes.
- Test your own endpoints with `testKit` of `@fabrika/app/testing`: `kit.testCaller(grants)` and
  `createClient(contract, 'api', { fetch: kit.browser(caller) })`. Test the denied caller too. Import the kit only
  from test files. A database test beside the generated endpoint test needs `bun test --isolate`.
- Database tests need `FABRIKA_TEST_POSTGRES_URL`; without it they skip, and a skip proves nothing.

## What the checker refuses

`fabrika-check` prints each finding with its allowed form. Use that form; there is no suppression. It refuses: a
contract or `src/db/tables.ts` that is not a literal; database drivers, S3 clients, `jose`, `node:http`/`net`/`tls`,
`child_process`; `Bun.sql`, `Bun.serve`, `Bun.spawn`; raw SQL; `as` casts other than `as const`; `any`;
`@ts-ignore`, `@ts-expect-error`, `biome-ignore`, `eslint-disable`; `Ref` or `Within` widened with `string`;
prototype writes; writes to a member of a `@fabrika/*` or `zod` value; `import()` or `require()` of a computed
specifier, `import.meta.resolve` and `node:module`; `process.env` and `Bun.env`; `import.meta.env` other than `FABRIKA_PUBLIC_*`; `fetch` of a
fixed absolute URL; a `px_` key in a string; client-supplied identity fields; logging errors, requests or headers;
`innerHTML` and `dangerouslySetInnerHTML`; `eval` and `new Function`; misnamed migrations; `.skip`, `.only` and
tests without an assertion; edited, missing or stale generated tests; `mock.module` of `bun:test` or `@fabrika/*`;
missing endpoint fixtures; test kits imported outside test files; replaced `@fabrika/*` or `zod` packages.

## Never edit generated files

`fabrika/entry.generated.ts`, `src/db/schema.generated.ts`, the generated tests, and the snapshots under
`fabrika/connect/`. Regenerate them with their command. On Zerops, write only `build.base`, `build.os` and the SPA's
`build.buildCommands` in `zerops.yaml`; the platform generates the rest, the crontab included.

## Not built yet

- The data layer runs on Bun with Postgres only, so on Cloudflare a contract application has no `@fabrika/db`:
  files, forms, webhooks and jobs do not boot there. The Cloudflare build does not run `fabrika-check` yet; run it
  yourself.
- Not supported: a job scoped to a dimension, a file collection with `link: true`, a webhook bound to `app`, a store
  for `reference` tables, reading a form's inbox, and a generated test for `move`.
- An MCP workspace has no shell, so `fabrika db codegen` and `fabrika db test-scaffold` cannot run there, and a
  change to the contract or the tables needs them. Tell the human; never write a generated file by hand.
