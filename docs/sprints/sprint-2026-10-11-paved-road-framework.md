<!--
On close, prepend an OUTCOME block here, then `git mv` this file to ../archive/:

> **OUTCOME — shipped YYYY-MM-DD.** <one-paragraph result.> Commit map: WU1 → <sha>,
> WU2 → <sha>, … Verification: <the gate command + numbers>. Backlog closed:
> <ids deleted/rescoped>. Deferred: <honest notes>.
-->

# Sprint — the paved-road application framework (2026-10-11)

**Goal.** An agent writes a Fabrika application on a paved road: a declarative shell, handlers colocated with their
endpoints, a mini-ORM scoped by the endpoint's capability, and raw SQL when it needs it. Every step off the road is
declared in the shell, so the human who approves the deploy sees it.

**Theme.** The platform guarantees two things at the high level: nobody reaches an endpoint outside authorization
(the proxy, [ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md)), and a widening waits for a human
on a protected environment ([ADR-0050](../decisions/0050-approved-access.md)). What a handler does with data is the
code's and the review's job. The framework makes the straightforward way the sound way. A step off the road (raw SQL,
an unscoped table, a connector, database code) is a declared deviation: allowed, bound to its endpoint at runtime, and
a review signal instead of a refusal. Success is the CRM rewritten in the new form, shorter than the dogfood baseline,
written by fresh agents from the skill alone, with an off-road request declared, flagged and parked for approval.

## Evidence carried over

The declared-operations proposal (`docs/ideas/agent-friendly-app-framework.md`, deleted with this sprint; git holds
it) is rejected by the owner as too declarative. Its still-valid evidence:

- **Baseline.** The dogfood CRM (`fabrika-dogfood-crm` at `204b8f6`) has 538 hand-written server lines in 10 files:
  the contract (176), `fabrika.config.ts` (39), `src/app.ts` (150), `src/db/tables.ts` (59), `src/db/database.ts` (5)
  and 5 stores (109). Its migrations are 115 lines and its authored test 236 lines. Each fact is written 3–4 times:
  actions, scope hierarchy, entity shape, writable columns, the endpoint tree, endpoint access against table actions.
- **Spike A (`derive`, local branch):** contract-derived `defineTables` (vocabulary and containment), `TableInsert` /
  `TableUpdate` and `fromRow`: −21 % lines, an identical endpoint table. Deriving zod inputs from rows lost bounds
  silently and turned a migration into an API change.
- **Spike B (`colocated`, local branch):** `.handle()` beside each procedure and a syntactic contract slice in the
  reader: the endpoint tree is written once, the approval diff is byte-identical, and 200 colocated procedures cost
  499,544 type instantiations against 524,957 for `implement`. Open: links, webhooks, exports, `deps`, one file only,
  and a bundler plugin for the SPA.
- **Spikes C (file-based, +42 % lines) and D (entity sugar, two styles)** are rejected.
- **The shared wall of all spikes:** a write capability cannot read its row, and `@fabrika/db` has no locking read,
  so "reopen a deal only from won or lost" cannot be enforced on the server.
- **The operations spike (`spike/operations`, not merged):** fresh agents with only the skill text finished a domain
  in at most 2–3 tsc/checker runs per endpoint group. Type errors are product surface: an error must land on its own
  line, name the fix, and print no mapped-type dump or `never`.
- **Two independent reviews of this plan** (at `cf1e292c`) found a type cycle in the first file order (contract →
  slice → tables → `typeof contract`, TS7022 with tsc 5.9), and that a syntactic deviation detector is evaded by
  destructuring, helper modules and `ctx[k]`. WU0 and the declared off-road fields answer them.

## Refs re-verified at HEAD (2026-10-11, `5b81b901`)

`✔` = confirmed live · `⚠` = drift, or HEAD contradicts an owner decision (the unit that resolves it is named).

- ✔ The mirrored tree: `implement(contract, { database, deps, handlers })` takes a handler tree typed equal to the
  contract — `packages/app/src/implement/implement.ts:50-57`, `ExactHandlers` at `packages/app/src/implement/types.ts:193`.
- ✔ The composition entry is `src/app.ts`; the generated entrypoint imports it — `packages/app/src/build.ts:15`, `:31`, `:41`.
- ✔ The hand-written action union: `defineTables<DB, A extends string>(columns)` — `packages/db/src/policy.ts:193`.
- ✔ The read gap: `DimensionTable.get` takes only a `Ref` of the table's read action; `update` takes the update
  action — `packages/db/src/store.ts:630`, `:642`. `expectVersion` already exists — `store.ts:363`.
- ✔ No locking read: the guard admits one lock, `FOR SHARE` on a mutation's destination —
  `packages/db/src/guard.ts:22-23`, `:313-314`.
- ✔ The framework's own tables live in the application's schema: `fabrika_webhook_bindings`,
  `fabrika_webhook_deliveries`, `fabrika_job_leases` — `packages/db/src/migrations.ts:8-10`; file tables are
  `fabrika_files_<name>` and the ledger is `fabrika_migrations`.
- ✔ The boot digest backstop for a slice: `boot` refuses a compiled contract other than `FABRIKA_CONTRACT_DIGEST` —
  `packages/app/src/implement/boot.ts:140-147`.
- ✔ The snapshot holds the contract and the migration list with checksums only; the digest keeps a trailing `null` so
  stored approvals stay valid — `packages/control/src/approval/snapshot.ts:16-23`, `:57-61`. `classifyAccess` sees a
  migration only by name and checksum — `packages/control/src/approval/diff.ts:33-43`.
- ✔ Control reads at most 256 files per snapshot — `packages/control/src/approval/read.ts:20`.
- ✔ The SQL lexer is pure TypeScript with no import — `packages/platform-node/src/migration-sql.ts`. `platform-node`
  exports only `.` and `./postgres-migrations`; `@fabrika/check` does not depend on it directly.
- ✔ The migration checks: statement allowlist `disallowedStatement` — `packages/platform-node/src/migration-allowlist.ts:294`;
  catalog check `databaseCodeQuery` / `databaseCodeCheck` — `packages/platform-node/src/database-code.ts:131`, `:256`;
  `codegen --verify` runs the same query — `packages/db/CLAUDE.md:223-229`. Codegen refuses domains —
  `packages/db/CLAUDE.md:214-216`.
- ✔ The generated schema file declares interfaces and `columns` — `packages/db/src/codegen.ts:218`. Kept (Out of scope).
- ✔ Application jobs are cron only (`c.cron`); there is no on-demand job kind and no application job queue —
  `packages/app/src/contract/define.ts:384`.
- ✔ The skill is one file read from the package — `packages/app/src/agent-skill.ts:9-24`; Control answers its own
  copy through `get_app_rules` — `packages/control/src/mcp/handler.ts:154`; the builder copies `SKILL.md` only —
  `packages/builder/cli/src/inject-skills.ts`.
- ⚠ Two `ConflictError` classes: `packages/app/src/errors.ts:54` and `packages/db/src/errors.ts:22`. WU3.
- ⚠ A webhook has no attempt lease: its delivery key is recorded before the handler and forgotten when it throws, and
  "the handler's stores own their transactions" — `packages/app/CLAUDE.md:373-377`. WU3 defines its semantics.
- ⚠ The skill has no version: its frontmatter carries only `name` and `description` — `packages/app/skill/SKILL.md:1-9`.
  WU10.
- ⚠ The local stack deploys only Notes: `prepare.ts` imports `notesContract` — `packages/local-stack/src/prepare.ts:22`
  (dogfood finding 2). WU11 runs the end-to-end deviation trial on Notes for that reason.
- ⚠ `test:examples` runs only `examples/zerops-app` — root `package.json:14`. WU11 adds `examples/crm`.
- ⚠ Decision 4 (raw SQL is legitimate) contradicts: the `raw-sql` rule — `packages/check/src/rules/runtime.ts:259-379`,
  `packages/check/CLAUDE.md:86`; "Do not add a method that takes SQL" — `packages/db/CLAUDE.md:179-181`; the skill's
  refusal list — `packages/app/skill/SKILL.md:137-139`; backlog 104 "Never add a raw handle, a `sql` escape" —
  `docs/backlog/104-the-query-builder-cannot-express-common-reports.md:36`. WU6, WU9, WU10.
- ⚠ Decision 3 (a capability reads its own target) contradicts "A write action does not include the read action" —
  `packages/db/CLAUDE.md:162-163`. WU3, WU9.
- ⚠ Decision 3 (handlers colocated) contradicts "the contract is a literal … no call of the application's own
  functions" — `docs/decisions/0012-fabrika-app-runtime.md:66-69`, the `implement`-only rule at `:79-84`, and the
  literal subset's one allowed function — `packages/check/CLAUDE.md:130-132`. WU0, WU4, WU9.
- ⚠ Decision 6 contradicts "An application's schema holds no database code" — `docs/decisions/0017-service-owned-postgres-migrations.md:144-198`,
  the codegen refusal — `packages/db/CLAUDE.md:223-229`, and the skill's migration rules —
  `packages/app/skill/SKILL.md:72-75`. WU5, WU10.
- ⚠ Decision 5 contradicts ADR-0050's "a code-only change deploys without a prompt" —
  `docs/decisions/0050-approved-access.md:217-219`: a change that declares a new deviation now waits. WU7, WU9.

## Target shape (WU0 fixes the signatures; WU1 the layout; WU3 the API matrix)

```text
src/vocabulary.ts                   defineVocabulary({ app, dimensions, actions, roles }): the authorization vocabulary
src/db/tables.ts                    defineTables(vocabulary, columns)({ … }): table scopes typed by the vocabulary
src/db/schema.generated.ts          codegen
src/app-kit.ts                      defineApp(vocabulary, tables): the kit, typed by the vocabulary, DB and policies
src/schemas.ts                      shared zod schemas (literal), imported by the shell and the SPA
src/<slice>/endpoints.ts            app.group(…) with .handle(…) bodies: a shell module, sliced by the reader
src/<slice>/logic.ts                business rules: plain TypeScript, no ctx, no data access
src/<slice>/queries.ts              reusable data access over the handle a handler passes in
fabrika.contract.ts                 app.contract((c) => …): mounts and sections composing the slices' groups
src/app.ts                          serve(contract, { database, deps }): the composition entry build.ts and the job CLI load
db/migrations/*.sql                 plain SQL; declared database code is a deviation
web/                                the SPA: the contract's types, src/schemas.ts and @fabrika/app/client only
src/**/__tests__/                   generated tests (committed, never edited) and authored tests and fixtures
```

The order breaks the cycle: the vocabulary knows nothing, the tables know the vocabulary, the kit knows both, and
the groups and the contract know the kit. Nothing imports `typeof contract` to type a table.

```ts
// src/deals/endpoints.ts
export const deals = app.group({ callers: ['human'] }, (r) => ({
	reopen: r.mutation({
		input: ReopenDeal,
		output: Saved,
		access: { action: 'deals.write', on: 'deal', from: 'id' },
	})
		.handle(async ({ input, ctx }) => {
			const deal = await ctx.db.target.getForUpdate()
			if (!canReopen(deal.stage)) {
				throw new ConflictError('only a won or lost deal reopens')
			}
			return ctx.db.target.update({ stage: 'proposal' }, {
				expectVersion: input.expectVersion,
			})
		}),
	pipeline: r.query({
		input: OrgInput,
		output: Pipeline,
		access: { action: 'crm.read', in: 'org', from: 'orgId' },
		sql: 'read',
	})
		.handle(async ({ ctx }) => ({
			rows: await ctx.sql(
				PipelineRow,
			)`select stage, count(*) as deals from deals where org_id = ${ctx.target.id} group by stage`,
		})),
}))
```

**Names.** `ctx.target` is the capability (a `Ref`) the access form minted; `ctx.db.target` is the data handle bound
to it. No other API says "target". `ConflictError`, `NotFoundError` and `BadRequestError` come from `@fabrika/app`
only. A paved-road mutation answers `Saved = { id, version }`.

**Declared off-road fields** (literal, in the shell, read by Control, part of the contract digest):

| Field                                      | On                     | Runtime effect                                                                                   |
| ------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `sql: 'read' \| 'write'`                   | endpoint, job, webhook | `ctx.sql` exists only here; `'read'` runs read-only; a query or export may declare only `'read'` |
| `unscoped: { <table>: 'read' \| 'write' }` | endpoint, job, webhook | `ctx.db.unscoped.<table>` exists only for those tables, in that mode; only tables of `tables.ts` |
| `connect: ['<connector>']`                 | endpoint               | `ctx.connect.<connector>` exists only here (replaces the import's `usedBy`)                      |
| link issuing (`issues: '<mount>'`)         | endpoint               | `ctx.links.issue` exists only here                                                               |

A new declaration, a new table or a mode change (`read` → `write`) is a widening with a "needs closer review" line.
The checker's syntactic lint ("declare `sql: 'read'` on `api.deals.pipeline`") is a hint, not the boundary.

## Work units

### WU0 — The staged kit, landed first (M/L)

- **Problem.** Spike B typed handlers through `typeof contract`; with tables typed by the contract and handlers in
  the contract's slice modules, tsc fails with TS7022. Parallel units cannot each invent the fix.
- **Verify first.** Reproduce TS7022 on spike B's CRM with `src/db/tables.ts` typed by `typeof contract`; measure
  today's `contract-scale` and `implement-scale` figures.
- **Scope.** The public signatures of the file order above, each with type-level tests, and runtime stubs that throw
  "not implemented in WU0":
  1. `defineVocabulary`, `defineTables(vocabulary, columns)`, `defineApp(vocabulary, tables)`, `app.group`,
     `app.contract`, `serve(contract, { database, deps })`.
  2. Multi-file groups; exact output through `ExactReturn`; `.handle()` whose return type does not mention the
     handler; the declared off-road fields; connectors and links; a `DbIndex<DB, P>` built once per app.
  3. Method gating by string-literal error tuples, so a gated method fails at its line in at most two lines.
  4. The shared fixtures migrated to the new table form; the skeletons of `differential.test.ts`'s new cases.
- **Acceptance / witness.** `packages/app/src/__tests__/kit-types.test.ts` compiles `src/__tests__/kit-mistakes/`
  (a group in another file, a wrong output field, `getForUpdate` in a query, `ctx.sql` without `sql`, `unscoped` of an
  undeclared table, `write` sql on a query) and asserts each diagnostic at its line, two lines at most, no `never`, no
  mapped-type dump. `kit-scale.test.ts`: 200 procedures in 10 groups within today's `implement-scale` budget.
- **Touch points.** `packages/app/src/contract/{vocabulary.ts,kit.ts,group.ts} (new)`, `packages/app/src/implement/serve.ts (new)`,
  `packages/db/src/{policy.ts (signature only),index.ts (types)}`, `packages/app/src/__tests__/{kit-*}`,
  `packages/check/src/__tests__/differential.test.ts` (skeleton cases), shared fixtures under `packages/app/src/__tests__/fixtures/`.

### WU1 — The application architecture (M)

- **Problem.** No document says where an application's code goes. The dogfood CRM and the spikes each invented a
  layout. The checker has only refusals, so it cannot say "this left the structure" without blocking the build.
- **Verify first.** The layout constants — `packages/check/src/layout.ts` — and that `Finding` has no severity —
  `packages/check/src/finding.ts`.
- **Scope.**
  1. `docs/reference/application-architecture.md`: the layers and the slice (the target shape above), what lives in
     which file, and what each layer may import or call: the shell, handlers, logic, data access (mini-ORM, `ctx.sql`),
     jobs, webhooks, files, the SPA and its typed client, shared schemas, generated and authored tests and fixtures.
  2. **Refusals** (platform integrity): the SPA imports no server module; logic and queries import no framework
     internal or test kit; nothing imports a generated test.
  3. **Structure findings** (checker output only, never in the snapshot): logic that reaches data; a slice that imports
     another slice's queries; a handler outside a slice's `endpoints.ts`; data access outside `endpoints.ts`/`queries.ts`.
  4. `Finding` gains `severity: 'refusal' | 'hint'`. `fabrika-check` prints hints under their own heading and exits 0
     when only hints remain. Still no suppression syntax.
- **Acceptance / witness.** `packages/check/src/__tests__/structure.test.ts` over `fixtures/architecture-app/`: each
  structure violation is reported as a hint, each integrity violation as a refusal, the clean layout reports nothing,
  the CLI exits 0 with hints only and 1 with a refusal.
- **Touch points.** `docs/reference/application-architecture.md` (new), `docs/reference/README.md`,
  `packages/check/src/{finding.ts,layout.ts,check.ts,cli.ts}`, `packages/check/src/rules/structure.ts` (new),
  `packages/check/src/__tests__/{structure.test.ts,fixtures/architecture-app/}`, `packages/check/CLAUDE.md`.

### WU2 — Tables derived from the vocabulary (M)

- **Problem.** `src/db/tables.ts` restates the action names as a hand union and each table's containment
  (`policy.ts:193`). Spike A removed both without changing the endpoint table.
- **Verify first.** WU0's `defineTables(vocabulary, columns)` signature; spike A's derivation (branch `spike/derive`,
  commit `d24b717c`); `packages/db/src/tables.ts` stays browser-safe.
- **Scope.** The implementation behind WU0's signature: action and dimension names from the vocabulary; a container
  column and a child's chain derived from `dimensions`, `in: { column }` only off the `<container>_id` convention;
  `TableInsert` / `TableUpdate`; the static reader reads `src/vocabulary.ts` and the table form. The old form is
  refused; pre-1.0, no dual reader.
- **Acceptance / witness.** `packages/db/src/__tests__/derived-tables.test.ts` (an action, dimension, child parent or
  container-column typo fails tsc at its line; a wrong derived column is refused); WU0's `differential.test.ts`
  table cases filled in and passing.
- **Touch points.** `packages/db/src/{policy.ts,tables.ts}`, `packages/check/src/reader/tables.ts`,
  `packages/db/src/__tests__/derived-tables.test.ts`, the table cases of `differential.test.ts`, `packages/db/CLAUDE.md` (policy).

### WU3 — The mini-ORM and the invocation's transaction (L)

- **Problem.** A handler reaches data through hand-written stores (109 lines in the CRM), a write capability cannot
  read its row (`store.ts:630`), there is no locking read (`guard.ts:313`), and every store call owns its transaction,
  so a precondition races.
- **Verify first.** How `boot` binds the layer and the `RequestFrame` (`boot.ts`, `dispatch.ts`); job fencing
  (`fencedTransaction`, `packages/db/src/job-leases.ts`); the webhook order (`packages/app/CLAUDE.md:363-377`).
- **Scope.**
  1. **The API matrix** (written in `docs/reference/application-runtime.md`, mirrored in the skill):

     | Access form | query                                                                                                 | mutation (adds)                                                                                                            |
     | ----------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
     | `on`        | `ctx.db.target.get()`; child tables `list`/`get`                                                      | `getForUpdate`, `update(v, { expectVersion })`, `remove({ expectVersion })`; child `insert`/`update`/`remove`              |
     | `in`        | `ctx.db.target.get()` (the container); `.<table>.list`                                                | `ctx.db.target.<table>.insert(v)` for a table whose list dimension is the target and whose insert action is the endpoint's |
     | `over`      | `ctx.db.within.<table>.list({ where, orderBy, limit, after })` (keyset), `count`, `aggregate`         | — (a list write is not on the road: `unscoped` or `sql`)                                                                   |
     | `creates`   | —                                                                                                     | `ctx.created` (IAM made the scope), then `in`-style inserts into it                                                        |
     | `member`    | no application data                                                                                   | no application data                                                                                                        |
     | any         | `ctx.db.reference.<table>` reads; `ctx.principal`; `ctx.members` where the action is `members.manage` | —                                                                                                                          |

     Plus: file collections are generated endpoints, not handler API; form inbox reads are not built; a job attempt
     retries, so its writes are idempotent; a webhook keys idempotency on `ctx.delivery.key`; errors from `@fabrika/app`.
     "Target subtree" = the target's child tables plus the dimension tables it contains.
  2. **Own-target read**: a `Ref` of any action the table names reads its own row; every column that carries a read
     action other than the capability's own is hidden, in the runtime projection and in the return type alike.
  3. `getForUpdate()`: `SELECT … FOR UPDATE` on the target's object predicate, in a mutation only; the guard admits that
     lock and no other new one.
  4. **The transaction is a runtime mechanism.** The invocation owns one session, opened on first data use, committed
     after the handler returns and output validation passes, rolled back on throw, validation failure or cancellation;
     the framework sets `idle_in_transaction_session_timeout`. The ORM and `ctx.sql` both route through it.
     Queries and exports run read-only. Jobs: data writes and `ctx.sql` only inside the fenced `ctx.transaction(fn)`.
     Webhooks: one transaction per delivery, idempotent by delivery key, the delivery record outside it. IAM, object
     storage and connector effects never roll back: data work first, external calls after.
  5. No `ctx.jobs.enqueue`: application jobs are cron only and have no queue, so an outbox has no consumer. The pattern
     is a row in the invocation's transaction that the next cron run picks up.
  6. `ctx.db.unscoped.<table>` per WU0's declaration and mode: guarded, in the invocation's transaction, scope
     predicate `true`; never a `fabrika_*` table.
  7. `fromRow(Schema, row)`: snake_case → camelCase, `Date` → ISO; literal-string fields are widened on input and
     checked by `parse`. One `ConflictError` on the application surface (`@fabrika/app`); `@fabrika/db`'s stays internal.
  8. Every handle (`ctx.db.*`, `unscoped`) is bound to its invocation.
- **Acceptance / witness.** `packages/db/src/__tests__/orm.test.ts`, `packages/app/src/__tests__/orm-dispatch.test.ts`
  (Postgres required): a write `Ref` reads its own row, with another action's columns hidden in data and type; two
  concurrent reopens — one wins, one 409; a thrown handler and a refused output commit nothing; a query cannot write,
  not even through `unscoped`; a captured handle called from another live request, from another `boot` and from an
  expired job attempt is refused; a webhook delivery that throws commits nothing and runs again. Type fixtures in
  `src/__tests__/orm-mistakes/`. WU0's scale budget rerun after this unit.
- **Touch points.** `packages/db/src/{store.ts,guard.ts,orm.ts (new),database.ts,errors.ts}`,
  `packages/app/src/implement/{boot.ts,dispatch.ts,types.ts,webhook.ts}`, `packages/app/src/jobs/runner.ts`,
  `packages/app/src/__tests__/{orm-dispatch.test.ts,orm-mistakes/}`, `packages/db/src/__tests__/orm.test.ts`,
  `docs/reference/application-runtime.md` (the matrix), `packages/db/CLAUDE.md`, `packages/app/CLAUDE.md` (Serving a contract).

### WU4 — Colocated handlers and the reader slice (L)

- **Problem.** Every endpoint is written twice (`types.ts:193`). Spike B proved `.handle()` with a reader slice and
  left links, webhooks, exports, `deps`, multi-file groups and the SPA build open.
- **Verify first.** WU0's group and `.handle()` signatures; spike B's `slice.ts` and `bun-plugin.ts` (branch
  `spike/colocated`, commit `f80f07c0`).
- **Scope.** The implementation behind WU0: `.handle()` on `query`, `mutation`, `cron`, `webhook`, link and export
  procedures; groups across files; `serve` binding handlers by endpoint id; the declared fields (`sql`, `unscoped`,
  `connect`, `issues`) in the kit, the artifact and the reader, `connect` replacing the import's `usedBy`; the reader's
  slice on every shell module, so Control reads only the shell; `@fabrika/check/bun-plugin` for the SPA build.
- **Acceptance / witness.** `packages/check/src/__tests__/colocated.test.ts`: a handler-only module that throws at
  import is never requested by `contractReaderInputs` and never runs; the static read equals `compileContract` of the
  evaluated modules; WU0's `differential.test.ts` slice cases pass; a plugin build holds no handler code.
  `colocated-mistakes/` fixtures (missing `.handle`, `ctx.target` on `over`, the wrong principal, an undeclared job
  action) each at its line.
- **Touch points.** `packages/app/src/contract/{define.ts,kit.ts,group.ts}`, `packages/app/src/implement/serve.ts`,
  `packages/auth-core` (artifact fields), `packages/check/src/{slice.ts (new),bun-plugin.ts (new),contract.ts,inputs.ts}`,
  `packages/check/src/reader/{value.ts,surface.ts}`, `packages/check/src/rules/literal.ts`, `packages/check/package.json`,
  the slice cases of `differential.test.ts`, `packages/check/CLAUDE.md` (literal subset).

### WU5 — Migration SQL: refuse escapes, declare database code (L; in progress in its worktree)

- **Problem.** Backlog 108 merged an allowlist that refuses every trigger, function, view and unusual expression
  (ADR-0017 `:144-198`). Decision 6 keeps a refusal only for what escapes the schema, the transaction or the platform.
- **Verify first.** Which allowlist rows are escapes (`migration-allowlist.ts`); what the catalog check reads
  (`database-code.ts:131`); the plan the runner applies (`postgres-migrations.ts`).
- **Scope.**
  1. `@fabrika/platform-node/sql`, runtime-neutral: the lexer, the function allowlist, and
     `classifyMigration(sql, schema) → { refused, deviations, objects }`.
  2. **Refused** (by file and line): transaction control, `SET`/`RESET`, `COPY` (any form), `GRANT`/`REVOKE`, roles,
     `CREATE EXTENSION`, any schema but the application's own, any `fabrika_*` relation, `SECURITY DEFINER`, a function
     `SET` clause, a language other than `sql` and `plpgsql`, event triggers, dynamic `EXECUTE`, and a body the lexer
     cannot parse.
  3. **The function allowlist, not name rules**, in function and `DO` bodies and in expressions: an identifier followed
     by `(` is a reviewed `pg_catalog` built-in or a function the application's migrations declare.
     `query_to_xml`, `cursor_to_xml`, `lo_*`, `pg_read_file`, `pg_advisory_*`, `dblink*` and `set_config` are refused.
     Dollar-quoted and single-quoted bodies are both parsed recursively. A schema qualifier is told apart from a table
     alias and from `NEW`/`OLD`.
  4. **Deviations** (kind and object name): functions, triggers, views, rules, policies, sequences, `DO`, and an
     expression that calls a function the application declares.
  5. **The object manifest**: the objects the migration files declare, with create, `CREATE OR REPLACE`, drop and
     rename applied in file order, is the authority. It is threaded through the runner, the CLI, codegen and the test
     database.
  6. **The catalog check is the runtime witness**, not the approval's detector (Control cannot reach the database):
     before the commit and at every start (`codegen --verify`) it refuses an integrity escape and any object the
     manifest does not declare.
  7. **Domains stay refused**: codegen cannot bind them (`packages/db/CLAUDE.md:214-216`), and a domain adds a type the
     data layer would have to unwrap.
  8. Rewrite ADR-0017's "An application's schema holds no database code" section in place.
- **Acceptance / witness.** `packages/platform-node/src/__tests__/migration-classify.test.ts` (each refused form and
  function, each deviation kind, a single-quoted body, an alias that looks like a schema, a plain file); on Postgres: a
  declared trigger applies and passes the start check, a trigger created outside a migration fails it, a renamed and a
  replaced function stay declared, `COPY … PROGRAM`, `app_other.t` and `fabrika_job_leases` are refused before any SQL runs.
- **Touch points.** `packages/platform-node/src/{migration-sql.ts,migration-allowlist.ts,database-code.ts,postgres-migrations.ts,application-postgres-migrations.ts}`,
  `packages/platform-node/package.json`, `packages/db/src/{codegen.ts,testing.ts}`, `packages/cli/src/db.ts`, their
  tests, `docs/decisions/0017-service-owned-postgres-migrations.md`, `packages/db/CLAUDE.md` (codegen invariant).

### WU6 — Raw SQL, declared (M)

- **Problem.** The checker refuses raw SQL (`rules/runtime.ts:259`), so an agent that needs a join report loads every
  row or invents a hack. Decision 4: `ctx.sql` is legitimate.
- **Verify first.** WU3's invocation session; WU5's `@fabrika/platform-node/sql` lexer and function allowlist.
- **Scope.** `ctx.sql(Schema)` as a tagged template, built only for a site that declares `sql`: values bound as
  parameters only, run in the invocation's session, read-only for `'read'`, rows parsed (snake → camel, `Date` → ISO,
  then zod; no row-type parameter). Runtime refusals from the template's static text: DDL, transaction control,
  `SET`, `COPY`, `LISTEN`/`NOTIFY`, a qualified name outside the schema, any `fabrika_*` or `pg_*` relation, a function
  outside WU5's allowlist, more than one statement. The `raw-sql` rule keeps refusing a driver's `sql`; a `ctx.sql` use
  on a site without the declaration is a checker hint naming the declaration to add.
- **Acceptance / witness.** `packages/db/src/__tests__/raw-sql.test.ts` (Postgres required): a join report answers in
  the invocation's transaction and rolls back with it; a `'read'` site cannot write; a site without `sql` has no
  `ctx.sql` at runtime; a captured `ctx.sql` called from another request is refused; each refused form and function
  throws before anything is sent; an interpolated value is a parameter. `rules.test.ts` holds the changed pair.
- **Touch points.** `packages/db/src/sql.ts` (new), `packages/app/src/implement/dispatch.ts` (binding only),
  `packages/check/src/rules/runtime.ts`, `packages/check/package.json`, their tests, `packages/db/CLAUDE.md` ("No raw
  handle" rewritten).

### WU7 — Deviations in the reviewed snapshot (L)

- **Problem.** Control's snapshot holds the contract and migration checksums (`snapshot.ts:16`); the approver sees no
  data reach beyond the paved road.
- **Verify first.** How `classifyAccess` keys endpoints (`diff.ts`); how the approval page renders `AccessChange`
  (`packages/dashboard/src/routes/approvals/detail.tsx`).
- **Scope.**
  1. **Only data-reach deviations reach the snapshot**: the declared `sql`, `unscoped`, `connect` and link issuing
     (already in the contract) and WU5's migration database code (a new snapshot field). WU1's structure hints stay
     checker output, so they cost no approval.
  2. Comparison: the site's identity (endpoint id, job, webhook, or migration object) is stable; its effect (mode,
     tables, connector) is compared separately. A new site, a new table, a new connector or `read` → `write` widens with
     `review: 'closer'`; a removal narrows; anything the diff cannot classify gets closer review.
  3. The digest covers the migration deviations only when there are some, so stored approvals stay valid.
  4. The approval page and the environment page mark the lines "needs closer review"; the environment page lists the
     published snapshot's deviations, protected or not. MCP `get_deployment` names them.
- **Acceptance / witness.** `packages/control/src/__tests__/approval-deviations.test.ts`: a commit pair adding
  `sql: 'read'` parks on a protected environment and publishes at once on an unprotected one, with the closer-review
  line in both; `read` → `write` and a new `unscoped` table each widen; a moved handler body with the same declaration is
  unchanged; a declared trigger widens; an old snapshot's digest is unchanged.
- **Touch points.** `packages/control/src/approval/{snapshot.ts,read.ts,diff.ts}`, `packages/control-contract/src/` (DTO),
  `packages/dashboard/src/routes/{approvals/detail.tsx,apps/detail.tsx}`, `packages/control/src/mcp/handler.ts`
  (`get_deployment` only), their tests, `packages/control/CLAUDE.md`.

### WU8 — The Zerops example, the generated tests and the application surface (M)

- **Problem.** `examples/zerops-app` (128 hand-written server lines without `fabrika.config.ts`, `implement`, a store)
  and the generated tests (`endpointAccessKit` boots `implement`'s result) show the old form, and agents copy the
  template.
- **Verify first.** `scaffoldInputs` (`packages/check/src/scaffold.ts:277`) and the fixture app in
  `packages/cli/src/__tests__/fixtures/isolation-app/`.
- **Scope.**
  1. `examples/zerops-app` in WU1's structure on WU0–WU4 and WU6; `src/app.ts` is `serve(…)`, the entry `build.ts` and
     the job CLI load.
  2. `test-scaffold` and `@fabrika/app/testing/isolation` boot `serve`. An endpoint that declares `unscoped` gets no
     other-scope isolation case and keeps its authorization-denial cases. Own-target read cases for a write-only role
     and a link holder. Authored seed fixtures set up preconditions (`deals.reopen` needs a won deal); generated tests
     are never edited.
  3. Remove `implement` from its subpath and `defineStore`/`defineChildStore` from `scoped()` on the application surface;
     framework tests keep an internal entry. Regenerate `packages/cli`'s fixtures and the local stack's Notes fixture.
  4. A real SPA build test: the example's SPA bundle through the plugin, with no transitive server import.
- **Acceptance / witness.** `bun run test:examples` and the example's Postgres suite pass; `fabrika-check
  examples/zerops-app` reports no refusal and no hint; the SPA build test passes; the regenerated fixtures pass;
  `bun run local:smoke` deploys Notes.
- **Touch points.** `examples/zerops-app/`, `packages/check/src/{scaffold.ts,scaffold-sample.ts}`,
  `packages/app/src/testing/{isolation.ts,endpoint-access.ts,policy-isolation.ts}`, `packages/app/package.json`
  (exports), `packages/db/src/{index.ts,store.ts (surface only)}`, `packages/cli/src/__tests__/fixtures/`, the Notes
  fixture under `packages/local-stack/` (no other local-stack file).

### WU9 — ADR-0012 and ADR-0050 rewritten (S)

- **Problem.** ADR-0012 states the literal contract and `implement` as the only way (`:66-84`); ADR-0050 says a
  code-only change never prompts (`:217-219`) and does not state the own-target read's action semantics.
- **Verify first.** This sprint's Decisions; ADR-0017 is WU5's.
- **Scope.** ADR-0012 in place: the staged kit, the declarative shell with declared off-road fields, colocated handlers
  and the slice, the paved road, raw SQL as legitimate, deviations as a review signal, and declared operations, RLS and
  the isolated host in Alternatives. ADR-0050 §1 and §3: the declared fields and migration deviations in the snapshot,
  their classification, and the own-target read (a capability reads its row except columns of another action). Both
  state that until WU12 lands the name rules are defense in depth only. Update `docs/reference/application-runtime.md`.
  Delete backlog 104 (raw SQL replaces declared report kinds) and repoint its references.
- **Acceptance / witness.** In operative docs (`docs/reference/`, `docs/decisions/` outside Alternatives, every
  `CLAUDE.md`, the skill; not `docs/archive/`), `grep -rn` finds no statement that `implement` is the only way, that raw
  SQL is refused, or that a code-only change never prompts; `bunx dprint check` passes.
- **Touch points.** `docs/decisions/{0012-fabrika-app-runtime.md,0050-approved-access.md,README.md}`,
  `docs/reference/application-runtime.md` (text around WU3's matrix), `docs/backlog/{104-…md,README.md}`.

### WU10 — Agent skills (M)

- **Problem.** The skill is one 162-line file in refusal order, with no version (`SKILL.md:1-9`); the builder copies
  only `SKILL.md`; dogfood findings 14–16 are gaps in it.
- **Verify first.** Every reader: the builder install (`packages/builder/cli/src/inject-skills.ts`), `get_app_rules`,
  `renderAgentsFile` and `agent-skill.test.ts`.
- **Scope.** **One skill, `fabrika-app`, with focused reference files**, not several skills: one trigger and one
  version to match, the MCP tool and `AGENTS.md` need one body anyway, and the always-loaded part stays short.
  `skill/SKILL.md` (at most ~120 lines): the paved road first, the architecture, the loop (edit → `fabrika db codegen`
  → `test-scaffold` → typecheck → `fabrika-check`), the declared off-road fields and when raw SQL is fine, "data work
  first, external calls after", the one `ConflictError`, when to ask the human, and that the name rules are defense in
  depth until WU12. `skill/references/`: `endpoint.md` (with WU3's API matrix), `table-and-migration.md`, `jobs.md`,
  `files.md`, `webhooks-links-connectors.md`, `errors.md` (checker findings and type errors). Frontmatter `version`
  equals `@fabrika/app`'s; the builder installs every file from the application's pinned `@fabrika/app`;
  `get_app_rules` takes an optional topic, states its version and warns when the workspace pins another;
  `renderAgentsFile` renders all of it. Fix dogfood findings 14 (`admin` is reserved), 15 (`fileTableSql` key and chain
  shape) and 16 (the seed's limits).
- **Acceptance / witness.** `agent-skill.test.ts`: version equals `package.json`; every reference file is rendered and
  installed from the application-pinned package (a builder test over a fixture app); `examples/zerops-app/AGENTS.md`
  is the rendered file; every code block type-checks against the workspace. WU11's fresh-agent trial uses only these files.
- **Touch points.** `packages/app/skill/`, `packages/app/src/agent-skill.ts`, `packages/app/src/__tests__/agent-skill.test.ts`,
  `packages/builder/cli/src/inject-skills.ts` and its test, `packages/control/src/mcp/handler.ts` (`get_app_rules` only),
  `examples/zerops-app/AGENTS.md`, `packages/app/CLAUDE.md` (the skill invariant).

### WU11 — Acceptance: the CRM in the new form (L)

- **Problem.** No unit alone proves the road is shorter, learnable from the skill, and honest about deviations.
- **Verify first.** The dogfood baseline counts (Evidence); the dogfood CRM's 30 endpoints, job, files and SPA.
- **Scope.**
  1. `examples/crm`: the dogfood CRM in WU1's structure with the same surface, plus `deals.reopen` (`getForUpdate`),
     `deals.source`, and a pipeline report on a declared `sql: 'read'`. Add it to `test:examples`.
  2. **Counts** against the baseline, the same file classes. Pass: at most 400 hand-written server lines (−25 %) and no
     file that only mirrors another; migrations and tests reported apart.
  3. **Fresh-agent trial**: agents that see only WU10's skill files write the CRM's endpoint groups from a feature
     brief. Every tsc and checker run is recorded. Pass: at most 3 runs per endpoint group, no edited generated file,
     no loosened access to make a test pass.
  4. **Deviation trial**: an agent asked for something off the road (a cross-scope admin report; an audit trigger on
     `deals`) declares `unscoped`/`sql` or writes the trigger migration; nothing is refused. On Notes through the local
     stack (protected `prod`), the run parks and the approval page shows "needs closer review"; on the CRM, Control's
     reader and `classifyAccess` over the commit pair show the same lines. An agent that uses `ctx.sql` without the
     declaration gets the checker hint and a runtime refusal.
- **Acceptance / witness.** `bun run test:examples` green with `examples/crm` (Postgres required); counts, trial table
  and parked run in the Run log; the parked run seen in the dashboard (agent-browser screenshot named in the log).
- **Touch points.** `examples/crm/` (new), root `package.json` (`test:examples`), this sprint's Run log.

### WU12 — A least-privileged database role per application (L)

- **Problem.** Migrations and the runtime share one credential that may own far more than `app_<id>`
  ([backlog 110](../backlog/110-give-each-application-a-least-privileged-database-role.md)). With raw SQL legitimate,
  the name rules of WU5 and WU6 are defense in depth; only a role bounds what a statement can do.
- **Verify first.** The credential `provider-zerops` writes (`FABRIKA_APP_DATABASE_URL`); the local stack's and the
  test backends' superuser connections.
- **Scope.** Backlog 110's approach: a role family per application that owns `app_<id>` and nothing else (no superuser,
  `CREATEROLE`, `CREATEDB`, `pg_execute_server_program`, `pg_read_server_files`, no other membership); a migration role
  with DDL and a runtime role with DML only; the runner and the runtime use their own; the local stack and the test
  databases exercise the roles. Delete backlog 110 when it ships.
- **Acceptance / witness.** A Postgres test: the application role cannot update a catalog table, call `lo_unlink` on an
  object it does not own, create a function in another schema, run `COPY … PROGRAM` or read another application's
  schema; the runtime role cannot create a trigger; `ctx.sql` on the runtime role cannot write `fabrika_migrations`.
- **Touch points.** `packages/provider-zerops/` (the credentials it writes), `packages/local-stack/` (roles; not the
  Notes fixture), `packages/platform-node/src/application-postgres-migrations.ts`, `packages/db/src/testing.ts`
  (test database role), `docs/decisions/0017-service-owned-postgres-migrations.md` (the role paragraph),
  `docs/backlog/{110-…md,README.md}`.

### WU13a — Paved-road data ergonomics from the probes (M)

- **Problem.** Two fresh-agent probes (`probe/opus`, `probe/gpt` branches, `examples/probe-tasks/PROBE.md`) built a
  task tracker on main after WU6. Both left the paved road for ordinary needs: a separate `tasks.assign` action cannot
  update one column, `update` needs every writable field, `over: 'org'` cannot list tasks two levels down, there is no
  exported row type, a `date` column comes back as a timestamp and a `timestamptz` write needs a `Date`.
- **Scope.**
  1. A column write action: `columns: { assignee: { write: 'tasks.assign' } }` lets a capability of that action update
     exactly those columns through `ctx.db.target.update`; the table's update action keeps the rest. Read by the static
     reader and part of the access snapshot, so a new column write action widens.
  2. `update` takes a non-empty subset of the writable fields.
  3. `over` and `within` reach any table whose containment chain includes the dimension (tasks under `over: 'org'`
     through their stamped `org_id`), not only the nearest container.
  4. A row type: `RowOf<typeof tables, 'tasks', 'tasks.read'>` (the projected row an action reads).
  5. `date` columns are `YYYY-MM-DD` strings end to end (codegen, handles, `fromRow`, `ctx.sql`); timestamp writes accept
     an ISO string as well as a `Date`.
- **Acceptance / witness.** Postgres tests per item; type fixtures for each misuse at its line; the probe app's
  `tasks.assign`, `tasks.close` and the overdue job rewritten on the handles without `ctx.sql` compile.
- **Touch points.** `packages/db/src/{policy.ts,vocabulary-tables.ts,orm.ts,orm-types.ts,codegen.ts,guard.ts}`,
  `packages/check/src/reader/tables.ts`, `packages/control/src/approval/diff.ts` (column write actions), their tests.

### WU13b — Shell and checker ergonomics from the probes (M)

- **Problem.** The probes hit errors that point at the wrong line or reveal limits only late.
- **Scope.**
  1. A reserved role name (`admin`) is a type error at `defineVocabulary`, naming the reserved names.
  2. A handler body's type error no longer cascades into "add .handle(…)" at the mount; a missing table under an
     access form names the table and the form in one line, no `DbIndex<…>` dump; returning a raw row where the output
     is camelCase names `fromRow`.
  3. The static reader accepts modifiers on an imported literal schema (`Status.optional()`, `.nullable()`, `.array()`)
     and reports a refusal at the offending call, not at the importing group.
  4. The `raw-sql` rule refuses a driver's `sql` by its origin (import), not by a parameter's name; `queries.ts`
     functions that take the declared `ctx.sql` tag are allowed, as the architecture doc says.
  5. A read-only member directory through IAM: `ctx.members.list()` (id, label) for an endpoint whose access action
     reads the dimension, without the member-management action, for assignee pickers and membership checks.
- **Acceptance / witness.** Type fixtures for 1–2 (≤2 lines, no dump); checker pairs for 3–4; an IAM-backed test for 5
  (a member lists, a non-member gets 403 through the proxy, the list is scoped to the dimension).
- **Touch points.** `packages/app/src/contract/{vocabulary,group,kit,context}.ts`, `packages/check/src/{reader/value.ts,
  rules/literal.ts,rules/runtime.ts}`, `packages/app/src/implement/membership.ts`, `packages/iam` (read path only),
  `packages/auth-core` if the RPC needs it, their tests.

## Out of scope (explicit)

- **Declared operations** (`c.read`/`c.update` with `when`/`set`/`inc`): rejected by the owner as too declarative.
  Business logic is TypeScript; only the reach off the road is declared.
- **Row-level security** and any attempt to make data security statically provable: decision 1.
- **An isolated handler host or a platform data executor**: decision 1; the long-term hard boundary in ADR-0012's
  Alternatives.
- **A syntactic detector as the boundary**: destructuring, helper modules and `ctx[k]` evade it. It stays a hint.
- **One literal column catalogue in `schema.generated.ts`**: the file is generated and `codegen --verify` guards it.
- **Deriving zod inputs from rows**: spike A lost bounds and made a migration an API change. `fromRow` covers outputs.
- **File-based routing** (spike C) and **entity sugar** (spike D).
- **`ctx.jobs.enqueue`**: application jobs are cron only and have no queue (WU3 §5).
- **Form inbox reads** and **list writes on the road** (`over` mutations): `unscoped` or `sql` cover them, declared.
- **Two-capability access** for `move` and merges ([backlog 97](../backlog/97-the-generated-tests-have-no-move-case.md)).
- **Destructive-migration rules** ([backlog 98](../backlog/98-application-migrations-have-no-destructive-change-rules.md)).
- **A data layer on Cloudflare**: still Bun and Postgres only.
- **Dogfood findings not addressed:** 1 (unpublished packages), 2 (a second app on the local stack: WU11 uses Notes),
  6 (a membership stand-in for the endpoint test), 7 (the seed and `CHECK` columns), 8 (a deploy failing before the
  build gives no reason), 9 (own rows only), 10 (listing attachments), 11 (listing members without `members.manage`),
  12 (author tests for jobs), 13 (`fabrika dev`), 17 (builder and MCP locally), 18 (the template's `bun.lock`), 19
  (refusal texts), 20 (the checker reads dev scripts: reading less is a place to hide code), 21 (smaller items).
  WU10 fixes 14–16.
- The 105/106/109 hardening and 107 stay as they are; no unit relaxes them.

## Decisions

Owner decisions, binding (condensed):

1. **Declarative shell, arbitrary code.** The shell is the vocabulary (dimensions, actions, roles), endpoints (kind,
   callers, access form, input/output), jobs, files and webhooks. Business logic is TypeScript. No operation grammar,
   no RLS, no isolated host, no static proof of data security.
2. **The platform protects at the high level:** the proxy admits only authorized calls (ADR-0022); a human approves
   every widening on a protected environment (ADR-0050). What a handler does with data is the code's and the review's.
3. **A paved road with strong guarantees:** the mini-ORM scoped by the endpoint's capability, which reads its own
   target; `expectVersion` and `getForUpdate`; `fromRow`; table scope and action names derived from the vocabulary;
   `.handle()` colocated with the endpoint and sliced off by the reader; no mirrored `implement` tree.
4. **Raw SQL is legitimate**: `ctx.sql`, parametrized, in the endpoint's transaction.
5. **Deviation is a review signal, not a refusal.** Hard refusals stay only for platform integrity: secrets,
   framework internals and `fabrika_*` objects, escaping the schema or the transaction.
6. **Migration SQL**: refuse only escapes; database code becomes a deviation.
7. The 105/106/109 hardening and 107 stay.
8. **The application architecture** is a reference document (WU1); the examples and the CRM follow it.
9. **Agent skills** ship in `@fabrika/app` and are the only text the fresh-agent trial sees (WU10).

Revision decisions (after two independent reviews), binding:

10. **The staged kit lands first** (WU0): vocabulary → tables → kit → groups → contract → `src/app.ts`, public
    signatures with type tests and stubs, so WU2–WU4 implement against fixed signatures.
11. **Off-road reach is declared in the shell** (`sql`, `unscoped`, `connect`, link issuing). The runtime builds each
    handle only for the declaring site and enforces the mode. The declarations are the deviations; Control keeps
    reading only the shell.
12. **`fabrika_*` objects are reserved**: refused in `ctx.sql`, in migrations, in any body, and in `unscoped`.
13. **A function allowlist, not name rules**, for bodies, expressions and `ctx.sql` text.
14. **Backlog 110 is pulled in** (WU12). Until it lands the name rules are defense in depth only.
15. **The transaction is the invocation's** (WU3 §4), with the stated semantics for jobs, webhooks and external effects.
16. **Own-target read hides every column of another action**, in data and type.
17. **The snapshot holds only data-reach deviations**; structure findings are checker hints.

Resolved in this sprint:

- **The catalog check is the runtime witness, not the detector**: Control decides approval from the commit and cannot
  reach the database. It checks the database against the object manifest the migration files declare.
- **Domains stay refused** (WU5 §7).
- **No `ctx.jobs.enqueue`** (WU3 §5).
- **One skill with reference files** (WU10), not several skills.
- **The ADR text follows the code**: ADR-0012 and ADR-0050 once (WU9); ADR-0017 with WU5 and WU12. Until then this
  sprint outranks them (`docs/CLAUDE.md` precedence).
- The idea document is deleted and its still-valid evidence is above.

## Sequencing

Each unit runs in its own worktree. Units in one step share no source file; where they share a test file, the rows
below say who owns which cases. Each unit edits only its own packages' `CLAUDE.md` sections; the integrator merges them.

| Step | Units               | Why this order                                                                                                                                             |
| ---- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | WU0 (+ WU5 running) | the signatures every later unit implements; WU5 is `platform-node`, `codegen` and the CLI only                                                             |
| 1    | WU1                 | the layout and the hint severity, on WU0's file order                                                                                                      |
| 2    | WU2, WU3, WU4       | `policy.ts`/`reader/tables.ts` · `store.ts`/`guard.ts`/`orm.ts`/`implement/{boot,dispatch,types,webhook}` · `contract/{kit,group,define}`/`serve.ts`/slice |
| 3    | WU6, WU12           | `ctx.sql` on WU3's session and WU5's lexer · the role on WU5's runner                                                                                      |
| 4    | WU7, WU8 (+ WU12)   | WU7 needs WU4–WU6; WU8 needs WU2–WU4 and WU6; WU12 may still run, outside both territories                                                                 |
| 5    | WU13a, WU13b        | the probes' fixes, after WU8; disjoint: db+reader · shell+checker+IAM                                                                                      |
| 5b   | WU9, WU10           | the ADRs and the skill describe what is built                                                                                                              |
| 6    | WU11                | the CRM, the counts and both trials                                                                                                                        |

Shared tests in step 2: `differential.test.ts` — WU0 writes the skeletons, WU2 owns the table cases, WU4 the slice
cases; type fixtures — WU3 owns `orm-mistakes/`, WU4 `colocated-mistakes/`, WU0 `kit-mistakes/`; the scale budget is
rerun after WU3. WU7 and WU10 touch different tools of `packages/control/src/mcp/handler.ts`, in different steps; the
active [MCP authoring sprint](sprint-2026-10-07-mcp-authoring.md) also edits that file, so coordinate there. WU8 touches
only the Notes fixture under `packages/local-stack/`; WU12 owns the rest of that package.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0022"). -->

- **WU1.** Today's `literal` rule refuses the target shell (`defineVocabulary`, `defineApp`, `app.group`,
  `app.contract`), so `structure.test.ts` asserts only the architecture's rules on `fixtures/architecture-app/`, and
  that directory is in `differential.test.ts`'s `refusedOnly` (one line in WU0's file). WU2/WU4: register it as a
  differential fixture and assert the whole check clean on it.
- **WU1.** The architecture puts every `.handle(…)` in a slice's `endpoints.ts`, jobs, webhooks, link and export
  procedures included (`handler-location`). WU0/WU4: a slice must be able to export them for the contract's sections.
- **WU1.** `queries.ts` takes the handle as a parameter typed by the methods it calls (`{ get(): Promise<DB['t']> }`),
  because the kit exports no handle type yet. WU3: add the handle types to the kit and update
  `fixtures/architecture-app/` and `application-architecture.md` to use them.
- **WU1.** `Finding.severity` is required, so every literal `Finding` in `packages/check` gained `severity: 'refusal'`
  (11 files, one line each): a merge note for WU4/WU6/WU8.
- **WU5 — name rules are not a privilege boundary until [backlog 110](../backlog/110-give-each-application-a-least-privileged-database-role.md).**
  The classifier refuses names (schemas, `pg_*`, `fabrika_*`) and calls outside the function allowlist; anything it
  admits runs with the credential's rights. ADR-0017 says so; WU6's `ctx.sql` inherits the same limit.
- **WU5 — `@fabrika/platform-node/sql`** exports `classifyMigration(sql, schema, { file, functions?, framework? })`,
  `classifyMigrations(files, schema)` (two passes: a body may call a function any file declares), `migrationManifest`,
  `declaredFunctions`, and for WU6 `lexSql`/`sqlTokens`/`topLevelStatements`, `statementKind`, `nameReferences`,
  `dmlForeignSchema`, `ddlForeignSchema`, `dmlRelations`, `isFrameworkName`/`frameworkReference`, `functionUse`/
  `refusedFunctionCall`, `unicodeIdentifier`. `sql-subpath.test.ts` pins the import graph to the subpath's own files.
- **WU5 — the function allowlist covers backfills, views, policies, rules and trigger conditions too**, not only bodies
  and expressions: `query_to_xml` in an `INSERT … SELECT` escapes as much as in a function. A stored expression that
  calls a reviewed but not paved built-in (`concat`, `md5`, …) is a deviation as well as one calling a declared
  function; `nextval` is admitted only there, since Postgres resolves its sequence when the default is created.
- **WU5 — framework names:** a file collection's `fabrika_files_<name>` table and its indexes stay creatable in the
  application's migration (`fileTableSql` writes them there); every other `fabrika_*` reference is refused, `ALTER`
  and `DROP` of a file table included. Only the plan's `frameworkBundle` (the first of several) is exempt.
- **WU5 — the runner folds the manifest per file**: the catalog check after file N admits the manifest through N, not
  the whole set (a later rename would otherwise refuse an earlier trigger). Dropping one overload drops the name, so
  the remaining overload fails the catalog check: fail-closed, witnessed.
- **WU5 — domains:** first permitted with a codegen base-type mapping, then reverted to refused when this sprint's
  revision on main fixed WU5 §7.
- **WU5 — a body is a statement allowlist** (`SELECT`/`INSERT`/`UPDATE`/`DELETE`/`WITH`/`PERFORM`/`RETURN`/`RAISE`,
  PL/pgSQL control flow, assignments), so DDL, `SET`, `COPY`, `LOAD` and transaction control in a body are refused,
  and a literal inside a body stays data. `BEGIN ATOMIC` and `E''` bodies are refused; `RETURN <expr>` is read in place.
- **WU5 — still refused, not in scope:** `ALTER TABLE … ENABLE/DISABLE TRIGGER|RULE|ROW LEVEL SECURITY` (so a policy is
  inert), `CREATE AGGREGATE`/`OPERATOR`/`TYPE … AS (…)`/`AS RANGE`, `ALTER SEQUENCE`. `packages/app/skill/SKILL.md`
  and `examples/zerops-app/AGENTS.md` still state the old migration rules → WU10. `packages/cli/src/db.ts` threads
  the manifest into `codegen` (outside WU5's listed touch points, required by §5).
- **WU5 review round 1:** a routine may not take any `pg_catalog` function name or keyword (a generated Postgres 17
  list, `pg-catalog-names.ts`, pinned by a Postgres test; the catalog check also refuses a shadowing routine, which
  catches names a later Postgres adds). Routines are keyed by `proargtypes` typnames, which leave out `OUT` arguments
  for procedures too, so a procedure's drop or rename, whose list includes them, covers every overload of the name
  (fail-closed). The application wrapper's `plan()` no longer scans qualifiers: the runner's role-aware refusal of a
  pending file replaces it. The catalog query takes the schema as a constant `regnamespace`: with a subquery the
  planner's estimate crossed `jit_above_cost` and the query took 200 ms instead of 10 ms.
- **WU5 review round 2 (integrator decision):** the classifier stops emulating Postgres' grammar and refuses the
  hard-to-read forms instead: field-selection calls, parenthesized DML targets, routine overloads (routines keyed
  by name; the signature module is deleted), `serial` and `CREATE SEQUENCE` (identity columns only), any unqualified
  `pg_…` name in DDL. It is a coarse, fail-closed defense in depth; the role (WU12, backlog 110) is the boundary.
- **WU0, verify first.** The reviewers' minimal reproduction gives TS7022/TS2456 with `tables.ts` typed by
  `typeof contract` and compiles clean in the vocabulary-first order. At `12e8685f`: `contract-scale` 151,698
  instantiations, `implement-scale` 510,959 (budget 1,000,000 each).
- **WU0, measurement.** `kit-scale.test.ts`: 200 endpoints in 10 group modules, every handler using its `ctx.db`,
  ~353,000 instantiations after review round 2 — 31 % under today's `implement` over the same count.
- **WU0, codegen: the column list carries the row types.** `fabrika db codegen` emits
  `export const columns: TypedColumnList<DB>` (a type-only brand), so `defineTables(vocabulary, columns)` takes no type
  argument and a hand-written list makes the builder an `Unavailable`. The edit is the emitted declaration only (WU5
  owns the rest of `codegen.ts`). Every committed generated file is regenerated, the Notes example included, so the
  local stack's agent-change patch and `fixtures/source/manifest.json` are regenerated too (`fixtures:pin`).
- **WU0, frozen table types.** The vocabulary form's authoring types take the derived forms (`key` defaults to `id`,
  the container and `<container>_id` from the vocabulary, a child's `column` and chain), and `defineTables` answers
  `NormalizedPolicies`, which `DbIndex` reads. Until WU2 derives at runtime, `defineTables` and
  `readTables(columns, policies, vocabulary)` throw `… is not implemented (WU2)` for an omitted key, container or
  chain, and refuse a container the vocabulary contradicts.
- **WU0, deviation: the reader reads the vocabulary form now.** The shared fixtures migrated to `src/vocabulary.ts`
  and `defineContract(vocabulary, …)`, so `rules/literal.ts` and `reader/value.ts` know `defineVocabulary` (one call
  reads as its object) and `reader/tables.ts` takes `(vocabulary, columns)`. WU2 and WU4 build on that.
- **WU0, deviations in the API.** A group does not nest (a mount nests groups), so a refused endpoint is a one-line
  error at its line. `.handle` answers `ExactReturn<F, O, Endpoint>`: the endpoint, or an `Unavailable` message the
  group refuses at the endpoint's line (not at `.handle`, whose error would print the handler's full type). The
  connectors are the kit's `imports` (`defineApp(vocabulary, tables, { imports })`), so `connect: ['<name>']` types
  `ctx.connect` without the contract. Dependencies are `defineDeps(build)` → `AppDeps<D>`, read with `get()` and
  passed to `serve(contract, { database, deps })`, since handlers are typed before `serve`. Jobs and webhooks bind a
  capability with `ctx.db.on(ref)`, `.in(ref)`, `.over(within)`; a job writes inside `ctx.transaction((tx) => …)`.
- **WU0, after review.** A missing `.handle` is refused by `c.rpc` (naming `<group>.<endpoint>`), not by the group: an
  options-first call fixes the callback's type before it can be checked, and refusing at the endpoint would print the
  builder's whole type. A refused access form keeps its one-line error; the handler's `ctx.db.target` then names the
  refusal (one follow-up line) instead of a union of every form. A widened capability type reads no column of another
  action. Left to WU4: the link mount an endpoint `issues` is not checked against the contract's mounts in the types.
- **WU0, review round 2.** A hidden column is omitted from the row type, not an `Unavailable` property: reading it is
  TypeScript's "Property 'margin' does not exist on type 'Omit<DealsTable, "margin">'", because the row is the
  generated interface where no column has a separate write type. `connect` must be a literal tuple and `issues` one
  literal. A group typed to admit a pending endpoint fails at the mount; a refused callback's fallback (`GroupBuild`,
  marked by a private symbol) does not, so its error is not repeated. A job's writes outside its transaction name
  `ctx.transaction((tx) => …)` and `tx.db`. The checker's allowed form is `defineTables(vocabulary, columns)({ … })`.
- **WU12 — the role family** (→ ADR-0017): `app_<id>` (named like the schema) owns it and runs the migrations;
  `run_<id>` has DML on every table but `fabrika_migrations` and serves. `FABRIKA_APP_DATABASE_URL` is unchanged on
  Zerops and becomes the provisioning credential: passwords are HMAC-derived from it (no store, no new service) and
  sent as SCRAM verifiers. A credential that cannot create roles, a schema the migration role does not own (no
  adoption: an old local `apps-db` volume needs `local:reset` once) and a widened role stop the deploy. Whether
  Zerops' `db` user holds `CREATEROLE`, and whether a new role connects through `portTls`, is UNVERIFIED (two
  `not-probed` platform-facts rows).
- **WU12 — no `ctx.sql` yet:** the witness is a raw connection as `run_<id>` (`application-postgres-roles.test.ts`).
  WU6: add a `ctx.sql` case writing `fabrika_migrations` that fails with `permission denied`. WU9/WU10: the name rules
  are defense in depth and the role is the boundary now; drop "until WU12".
- **WU12 — what stays outside the roles:** framework tests with their own Postgres setup (most of `packages/db` and
  `packages/app`) still connect as the test superuser; the test kit, `serveContract` and `runContractJob` do not.
- **WU12 review round 1:** the serving entry and `fabrika job run` became launchers that re-run the command without
  the provisioning credential; `test-isolation` hands the generated tests a throwaway `fabrika_tests_<hex>`
  provisioner (Postgres 16+). Each migrate clears PUBLIC from the migration role's defaults, resets PUBLIC's and the
  runtime role's grants, verifies effective privileges, and refuses foreign grants and callable SECURITY DEFINER
  routines; the lock wait is bounded at 5 min. Residual (ADR-0017): same-user processes can read the launcher's
  `/proc/<pid>/environ`; large objects and advisory locks stay shared.
- **WU2, derivation.** `defineTables(vocabulary, columns)` and `readTables(columns, policies, vocabulary)` derive every
  key (`id`), container (the vocabulary's), container column (`<container>_id`, else `in: { column }`) and child
  column (`<parent dimension>_id`) and chain (the parent's) in the one parse; a stated value must agree, and a default
  the table has no column for is refused with the field to state. The db test fixture now uses the derived form, so
  every store and Postgres suite runs on derived models.
- **WU2, SIGNATURE CHANGE (mandated: the old form is refused).** The `defineTables<DB, Action>(columns)` overload and
  its types `PolicyMap`, `DefinePolicies` and `TablePolicy` are removed; a one-argument call throws `PolicyError`.
  `readTables`' `vocabulary` is required. The reader refuses any `defineTables` call without two arguments.
- **WU2, SIGNATURE CHANGE (additive, defaulted).** `VocabularyPolicyMap<DB, V, P = unknown>` and
  `VocabularyTablePolicy<…, S = unknown>` take the policies as written; `DefineVocabularyPolicies` constrains
  `P extends VocabularyPolicyMap<DB, V, P>`. Each table's form is picked by the scope it states, so a misspelt
  dimension is reported against all the vocabulary's dimensions ("Did you mean"), and a missing `key` or `in` names
  `NamesItsKey` / `NamesItsContainerColumn` in two lines. `kit-mistakes/12` now passes the plain rule. `kit-scale`:
  354,239 instantiations. New types: `TableInsert<typeof tables, T>` and `TableUpdate<typeof tables, T>`.
- **WU2, outside the listed touch points.** `examples/zerops-app` and `packages/cli`'s `isolation-app` fixture gained
  `src/vocabulary.ts` (the contract is `defineContract(vocabulary, …)`), the skill's table rules and the example's
  `AGENTS.md` describe the derived form, and `packages/local-stack`'s `manifest.json` is re-pinned; the agent change
  patch is unchanged and applies with offsets. WU8 still owns the example's rewrite.
- **WU2, the WU1 ask.** `fixtures/architecture-app` needs the slice reader (`app.contract`), so its registration as a
  differential fixture stays WU4's. Its tables were not a valid policy (`deals` lacked `org_id`, its column list
  carried no row types); the schema, migration and column list are fixed, and a differential table case reads them.
- **WU2 review round 1.** (1) The generated column list carries each table's foreign keys
  (`{ columns, foreignKeys: [{ columns, table, references }] }`, still the one `columns: TypedColumnList<DB>`
  declaration; codegen reads them with `introspectCatalog`). A composite key is kept whole, not only single-column
  ones, because the paved road's contained tables reference `UNIQUE (id, <chain>)` of their container. A container or
  child-parent column must be a column of a foreign key to the owning table's key, or the parse refuses it, naming the
  column that is; an unowned container keeps the convention. Every committed `schema.generated.ts` is regenerated
  (codegen where a migration exists, by hand for `kit-fixture` and the check `derived-tables` fixture), the agent change
  patch is regenerated and the local stack re-pinned. (2) Above an unowned dimension the chain follows the vocabulary on
  `<dimension>_id`; a vocabulary containment cycle is refused. (3) A map annotated `VocabularyPolicyMap<DB, V>` is
  checked against every form again. (4) A child's parent is checked against the tables that state a dimension scope,
  and `column` is required off `<parent dimension>_id` (`NamesItsParentColumn`). (5) Table actions, inbox reads and
  column reads must be vocabulary actions, in the shared parse. `kit-scale`: 356,159 instantiations.
- **WU3 — the seam with WU4.** A site is a handler tree leaf `siteHandler(handler, declared)`
  (`packages/app/src/implement/invocation.ts`, not exported from a subpath); `serve` builds the tree from those, and
  `boot` parses `declared` at the boundary (`parseDeclaration`: a query's `'write'`, a table outside `src/db/tables.ts`
  or `fabrika_*` is a `BootError`). Integrator: once WU4 puts the declarations into the artifact, `boot` should read the
  approved declaration from it and refuse a leaf that says otherwise; until then the leaf is the only source.
- **WU3 — the hook for WU6.** Every handle of a site runs in one `Session`: `Invocation.session()` for a request or a
  webhook delivery (an `InvocationTransaction`, `packages/db/src/database.ts`, a Kysely transaction waiting for the decision,
  `READ ONLY` for a query or an export), the session `DataAccess.transaction` hands a job's `ctx.transaction`. A declared
  `ctx.sql` / `tx.sql` is `sqlStub()` (invocation.ts), which WU6 replaces with the template run in that session. A raw
  statement must go through `Session`'s private `#execute` (as `runFixedStatement` does), so a refused statement marks
  the invocation failed and its commit throws instead of Postgres' silent ROLLBACK.
- **WU3 — own-target read follows `RowFor` exactly.** A `Ref` reads a column only when the column declares no read
  action or exactly the capability's, so a write `Ref` also loses a column that declares the table's own read action.
  `GuardContext.lock` is `'share' | 'update'` (was `true`); `getForUpdate` is the only `FOR UPDATE`.
- **WU3 — a webhook delivery's record stays outside its transaction** (as decided), so a process that dies between the
  record and the commit keeps the key and loses the delivery; a thrown handler rolls back and forgets the key.
- **WU3 — lists are keyset pages** (50 by default, 500 at most; the key is the tiebreak, a reference table's every
  visible column). A member the types make `Unavailable` throws its message at runtime where the handle has the
  method; `ctx.db.target` of `over`/`member` and `ctx.db.unscoped` without a declaration are absent.
- **WU3 — no frozen signature changed.** Added: `DbHandle`, `ReferenceHandle` (`@fabrika/app/contract`, WU1's ask;
  `architecture-app` and `application-architecture.md` use them), `fromRow`/`RowInput` (`@fabrika/app`),
  `dataAccessOf` (`@fabrika/db/framework`). `@fabrika/db`'s root no longer exports `ConflictError`/`NotFoundError`.
  The skill does not mirror the matrix yet → WU10. `kit-scale.test.ts` after WU3: 354,508 instantiations.
- **WU3 review round 1.** Fixed with witnesses: a driver failure leaves the layer as `DatabaseError` (SQLSTATE only, no
  row detail); a column policy on the key or the version is refused and a list's synthesized order is held to the
  capability's columns; an invocation's end and its connection's release are separate, so a failed COMMIT gives the
  connection back (one-connection pool); a fenced job transaction gets the idle timeout and `cancelInFlight` aborts it
  even while its work waits; a cursor carries each order column's database text (microseconds kept). Residual: Bun's
  driver leaves its release of a connection the database closed as an unhandled rejection (printed, not fatal).
  Finding 1 (`boot` takes `declared` from the approved artifact) → WU4's integration: the hook is `boundHandler` in
  `boot.ts`, where `parseDeclaration` reads the leaf's `declared`.
- **WU6 — the tag** (`packages/db/src/sql.ts`): `classifySql` reads the template's static parts joined by `$1…$n`, so a
  value is only ever a bound parameter; the lexer must see exactly n placeholders, so a `${…}` inside a literal, a
  quoted name, a dollar body or a comment (or glued to a word) is refused, and so are `$<digit>` in the static text and
  a digit right after a value. The refusals use WU5's exports (`statementKind`, `nestedStatement`,
  `parenthesizedTarget`, `frameworkReference`, `dmlForeignSchema`, `unicodeIdentifier`, `refusedFunctionCall`), plus
  `SELECT … INTO` and any non-call `pg_*` name. A list value binds as one Postgres array literal (Bun mis-binds a JS
  array). `DataAccess.sql(site)` builds the tag; `Database` gained a `schema` getter for the classifier.
- **WU6 — deviation: no declared function in `ctx.sql`.** `refusedFunctionCall` gets an empty set, because the runtime
  does not know the migrations' manifest; a call of an application function is refused (call it from a view or a
  function a migration declares). Threading the manifest to the runtime is a follow-up if an application needs it.
- **WU6 — `'read'` on a mutation, a job or a webhook is static only**: its transaction writes, so no `READ ONLY` is
  under it. The text refuses every `INSERT`/`UPDATE`/`DELETE`/`MERGE` word and every locking clause, and the
  allowlist admits no built-in that writes (`nextval`, `set_config` are out). A query's and an export's `'read'` also run
  in the `READ ONLY` transaction (witnessed with SQLSTATE 25006 past the classifier).
- **WU6 — the WU12 case:** `ctx.sql` refuses `fabrika_migrations` by name before anything is sent, so the role is
  witnessed on `ctx.sql`'s execution path past the name rule (`runApplicationStatement` as `run_<id>`: 42501, and the
  invocation then refuses to commit). `raw-sql.test.ts` runs entirely as the runtime role (`testDatabase`).
- **WU6 — for WU8/WU10/WU11:** a `Ref`'s id is `ctx.target.value`; the target shape's `${ctx.target.id}` does not
  exist. (Review round 1: `logFailure` now logs a `QueryRefusedError`'s message, which names what was refused and
  never a bound value.)
- **WU6 — checker:** `sql-undeclared` (hint) names the procedure's property key (`'pipeline'`), not the mounted id: the
  mount path is not syntactic at the `.handle` call. `HINT_RULE_IDS` = `STRUCTURE_HINT_RULE_IDS` + `sql-undeclared`;
  `structure.ts` exports `handledProcedure`, which both rules use. `raw-sql` is unchanged in code (a `ctx.sql(Row)`
  tag is a call, never a `…sql` member); its allowed fixture now holds one. `packages/check/package.json` is
  untouched: the checker does not classify `ctx.sql` text.
- **WU6 review round 1.** Any refusal of the tag after its binding check (a statement, a value, a row) now fails the
  site's transaction (`SqlSite.fail` → `InvocationTransaction.fail`, or a job's `Session.fail`), so a handler that
  catches it commits nothing; `InvocationTransaction.commit` refuses a failed invocation even when it never opened, and
  a nested `Session.transaction` (a job's fenced one) whose statement failed throws instead of committing. A row error
  is built from the issue's code, its expected type and the schema's top-level field only (a custom message, a JSON
  key or the input could carry row data). The `sql-undeclared` hint reads options through `satisfies` and `as const`.
  Owner decision: `logFailure` logs a `QueryRefusedError`'s message (`@fabrika/db/framework` exports the class).
- **WU4, the declared reach in the artifact.** `ContractArtifact.declared` holds each site that declares anything, by
  endpoint id (procedures and webhooks) or `job:<name>`, as `DeclaredReach { sql, unscoped, connect, issues }`; it is
  absent when no site declares, so every existing digest is unchanged. `buildArtifact` parses it: modes, `read` only on
  a query or export, tables of `src/db/tables.ts` and no `fabrika_*`, `connect` and `issues` only on an RPC endpoint,
  `issues` only with the mount's `issuedBy` on its dimension. WU7 compares it.
- **WU4, the seam to WU3.** `serve` builds today's handler tree; each entry is the handler, callable, with the site's
  `declared` beside it (`ServedHandler`, `implement/serve.ts`). The contract's sites carry `declared` too
  (`procedure.declared`, the webhook mount's, `jobs.<name>.declared`), so `boot` can read it where it already holds
  the declaration. `boot` itself is unchanged.
- **WU4, the `GroupBuild` gap is closed in `serve`, not in `c.rpc`.** `serve` refuses every endpoint, job, webhook,
  link and export procedure without `.handle(…)`, naming each by its path. `c.rpc` cannot at runtime: the SPA's sliced
  bundle evaluates to the same contract with no handler at all (`colocated.test.ts` serves it and is refused).
  Open for the integrator or WU10: a job, webhook, link or export procedure without `.handle` is a tsc error that
  prints the builder's type (`CronBuilder<…> is missing … kind, schedule`); a one-line message needs a check on
  `app.contract`'s sections like `MountPrefix` (a WU0 signature change), so it is not in `colocated-mistakes/`.
- **WU4, one unchecked join.** `defineApp`'s frozen signature is the typed face of `RuntimeApp`, through an
  implementation signature that returns `object`: `.handle`'s `ExactReturn` and `contract`'s imports-by-kit are
  conditional types no implementation can return. It is the only place the compiler does not relate the runtime to its
  type; `kit-runtime.test.ts` holds each builder to it. No cast, no signature change.
- **WU4, the slice.** Every module the reader, the literal rule, `contractReaderInputs`, the checker's contract rules
  and the plugin read is its shell slice; it removes only what the handlers alone use, so a declaration nobody uses
  still meets the literal rule. Over 200 endpoints in 10 group modules Control fetches 58,791 bytes in 0.37 s and no
  handler module (`colocated-scale.test.ts`). The client-identity rule walks every module of the shell graph, and the
  crontab rule reads `jobs: { <name> }` consts of `app.cron`.
- **WU4, fixtures.** `kit-fixture` vendors its catalog snapshot (`kit-fixture/fabrika/connect/`): the reader reads only
  files under the application. `architecture-app` got `c.spa`'s `dir`/`access`, `serve` without the untyped `deps`,
  `ctx.target.value` (a `Ref` has no `id`) and its generated tests. It is a differential fixture now, evaluated by Bun,
  and its whole check is clean (`colocated.test.ts`).
- **WU4 review round 1 — SIGNATURE CHANGE: `defineApp`'s options require `imports`** (`options?: { readonly imports:
  Imp }`, was `imports?: Imp`). An options object whose imports may be absent inferred `Imp` from the property's type,
  so the contract's type promised an imports section the runtime did not build. The contract now has the section
  exactly when options are given, an empty one included, in the runtime and the reader alike
  (`colocated-mistakes/05-imports-that-may-be-absent.ts`, `kit-runtime.test.ts`).
- **WU4 review round 1, dependencies per boot.** `defineDeps` kept one built value, so a second `boot` of one
  implementation replaced what an earlier runtime served with. Each handler now runs with its boot's dependencies in an
  `AsyncLocalStorage`; two runtimes with interleaved requests each read their own.
- **WU4 review round 1, the SPA build.** The plugin now reads the shell graph under its `root` as Control does,
  fails the build when the reader refuses it, and slices every extension the reader reads (a `.js` shell module kept
  its handlers before). A `.handle(…)` that is not one inline function beside its builder is refused by the slice at
  its `handle` and removed, so its module is never requested; it fails the plugin build too. `defineTables` comes only
  from `@fabrika/db/tables`: the root of `@fabrika/db` also loads `bun`, which a browser bundle of the shell cannot.
  The SPA witnesses bundle every package.
- **WU4 integration with WU3.** `serve` builds `siteHandler(handler, declared)` leaves, each handler run with its
  boot's dependencies. `boot` and the job runner take each site's declaration from the approved artifact
  (`approvedDeclaration`, `invocation.ts`: by endpoint id or `job:<name>`) and refuse a leaf whose `declared` differs,
  reported once when the leaf's own parse already refused it; a leaf-only `unscoped` widening under the old digest no
  longer boots (`kit-runtime.test.ts`). The orm fixture's shell moved to the kit form so its `retitle` declares
  `unscoped` where the digest covers it; its handlers stay the tree `app.ts` writes. A kit site needs `scoped(tables)`
  on Postgres, so `kit-runtime.test.ts`'s boot cases run against `FABRIKA_TEST_POSTGRES_URL` and skip without it.
- **WU4 review round 2, reach by the artifact alone.** A plain-function leaf (`implement` on a kit contract) took the
  unfiltered `defineContract` reach and issued links its endpoint never declared. The artifact's `declared` section is
  now present for every contract with a kit site (empty included) and absent for a `defineContract` one, so `boot`
  reads the rule from the approved artifact: a kit contract's every endpoint, leaf of any form, runs with its approved
  declaration (`approvedReach`), and only a `siteHandler` leaf gets `ctx.db` (`kit-reach.test.ts`).
- **WU4 review round 2, every spelling of `handle`.** The slice matched only a plain `.handle(…)`, so `['handle'](fn)`
  and `.handle!(fn)` kept `fn` and Control fetched its module before refusing the shell. It now matches every call of a
  member statically named `handle` through `!`, `as`, `satisfies`, `<T>` and parentheses, refuses each spelling other
  than `.handle(<inline function>)` on a builder, and removes its arguments, type arguments and wrapping types; parentheses
  stay, so the slice still parses. A refused site's receiver is sliced in turn: the walk used to skip it
  (`colocated.test.ts`).
- **WU4 review round 2 — SIGNATURE CHANGE: `defineApp` is two overloads.** `defineApp(vocabulary, tables)` and
  `defineApp(vocabulary, tables, options: { readonly imports: Imp })`, was one with `options?: { readonly imports: Imp }`.
  Optional options inferred `Imp` from their type while the call might pass none, so `contract.surface.imports` typed
  as present and was `undefined` at runtime. The options of the imports overload are required; imports given only as a
  type argument no longer type either (`colocated-mistakes/06`, `07`, `kit-runtime.test.ts`).
- **WU4 rebase onto WU6.** `ctx.sql` binds the mode of the approved declaration (`servedSite`, the webhook's `site`, a
  job's `approvedDeclaration`), so `sql-dispatch.test.ts`'s leaf-only `{ sql }` no longer boots under the orm
  fixture's digest. The test now serves its own kit shell that declares each site's `sql`; its cases are unchanged, and
  the same tree under the orm fixture's shell is refused at boot.
- **WU7 — before WU7 a declaration-only change published at once on `prod`.** `classifyAccess` never read
  `ContractArtifact.declared`, so adding `sql: 'read'` changed the digest and classified as `unchanged`. It is compared
  now: a site by endpoint id or `job:<name>`, each effect on its own; `AccessChange.review?: 'closer'` marks the lines.
- **WU7 — database code is `AccessSnapshot.databaseCode`** (WU5's `MigrationDeviation[]`, absent when empty; the digest
  appends it only when present). Its identity is file + kind + object, not WU5's kind + object alone: `DO`'s object is
  `block <n>` per file, and a `CREATE OR REPLACE` in a new file is new code. An edited file that holds code widens with
  closer review again, since the diff cannot tell what changed in it.
- **WU7 — Control refuses as the runner does, not more.** A refused statement fails the read (`migrations-refused`, a
  count; the log points to `fabrika db migrate`), except in a file the environment's published snapshot holds with
  the same checksum: the runner skips applied files so a stricter classifier cannot lock an application out. The
  classifier needs the text of the whole set at once, so the read caps it at 16 Mi characters (`migrations-too-large`).
- **WU7 — `applicationDatabaseSchema` moved to `@fabrika/platform-node/sql`** (`application-schema.ts`), so Control
  classifies against the runner's schema name in a Worker; `@fabrika/db`'s `applicationSchema` still duplicates it.
- **WU7 — the transitions the diff cannot classify site by site:** a kit contract that becomes a `defineContract` one
  (its reach is no longer in the artifact) widens with closer review; the reverse narrows. `AppEnvDto.deviations` lists
  the published snapshot's; `get_deployment` answers `deviations` (the run's closer-review lines, parked or not); the
  builder daemon defaults the field to `[]` for an older Control. Browser check skipped: the dashboard dev server needs
  a running Control; the components are witnessed by `packages/dashboard/src/__tests__/deviations.test.ts`.
- **WU8 — the application surface.** `@fabrika/app/implement` no longer exports `implement`; the mirrored tree stays
  in `implement/implement.ts` as the framework tests' entry (relative imports). `scoped(tables)` answers
  `ScopedDatabase<DB, P>` = the policies and a type-only brand; `defineStore(layer, table, build)` /
  `defineChildStore` are free functions exported from `@fabrika/db/testing` only, and `DimensionTable`/`ChildTable`
  left the root. Runtime messages name `serve(contract, { database })` and `defineApp(…, { imports })`.
- **WU8 — SIGNATURE ADDITION: a kit without tables.** `examples/app` (Cloudflare, no data layer) could not leave
  `implement`, so `defineApp(vocabulary)` is a third overload (`NoTablesIndex`: `ctx.db` is an `Unavailable`), served
  with `serve(contract, { database: null })` (and only then null, `isTableless`); `boot` serves its procedures without
  `ctx.db` and refuses a site that declares `sql`. The reader accepts the one-argument call. A tableless kit with
  imports is not built (no overload); `connect-shop` stays a framework fixture and its checker test reads its shell.
- **WU8 — the generated tests (with the ergonomics probe's F1, F10, F11, F12).** `endpoint-access.fixtures.ts` takes
  `export const seeds = { '<endpoint id>': { <column>: <value> } }` beside `fixtures`: the state `seedWorlds(tables,
  table, values)` writes into both rows of the table that owns the endpoint's dimension (a placing column is
  refused). `leaked` answers `{ answered: true, leaked }` for a 2xx or a 4xx other than 401/403/404 (a precondition's
  409), `denied` stays exact. New cases: `own` (a caller with only a write action, or a link holder bound with
  `testCaller(grants, { kind: 'link', link: { mount, chain } })`, reaches its own object, 200) and a leak case for an
  `in` site that declares `sql` (every table that lies in the dimension, seeded per scope). `unscoped` drops the leak
  case and keeps the denial. `testKit(…).runJob(name)` runs a cron job; `testDatabase` now applies the framework's
  tables first, as `fabrika db migrate` does (jobs and webhooks need them). The root `dprint.json` excludes the
  generated tests of `examples/*` and `packages/cli`'s fixtures (F12: the simpler of the two).
- **WU8 — the Zerops example.** In WU1's layout: `src/app-kit.ts`, `src/schemas.ts`, `src/notes/endpoints.ts` (six
  endpoints, `restore` with `getForUpdate` and a seed, the `purge` job in its fenced transaction), `src/app.ts` =
  `serve(…)`, an SPA (`web/`, `build-web.ts` through the plugin, `c.spa('/')`, `zerops.yaml` `buildCommands`), `kysely`
  and `@fabrika/check` in `package.json` (F10a). `remove` takes `expectVersion` and mutations answer `Saved`. Counts
  (hand-written server files: contract, configs, `src/` without tests and generated files): before 8 files, 230 lines
  (136 in 6 files without the two provider configs); after 9 files, 220 lines (126 in 7 files), with one endpoint and
  the SPA mount more. `fabrika-check`: 0 refusals, 0 hints. The mirror's `bun.lock` is not refreshed (needs a release).
- **WU8 — outside the listed touch points.** `examples/app` (above), `packages/local-stack/src/local-source-fixtures/generate.ts`
  (`dist` is not committed), `packages/platform-artifacts`' example endpoint list, `packages/builder` docs that named
  `implement`, `packages/cli/src/connect.ts`'s hint. The agent change patch is regenerated in the new form (rename +
  `note_labels`, codegen from a real migrate) and the fixtures re-pinned.
- **WU8 → WU10.** `packages/app/skill/SKILL.md` (and so `AGENTS.md`) still describe `implement`, `src/db/database.ts`,
  `defineStore` and `connect` on `implement` (lines 13, 68–69, 93, 112): prose, no code block, so left for WU10.
- **WU8 review round 1.** A seed now only adds a seeded leak case: the unseeded one always runs (a handler that leaks
  only in the state a seed sets aside is caught), and a seed of a text column is refused (its marker is what a leak
  shows). A leak scans every value of the other row's chain (an outer dimension's value leaks too). `serve` refuses a
  contract no kit built, a copy included (`kitOriginOf`), and a tableless kit's `sql` is a type error
  (`kit-mistakes/24`). `architecture-app`'s `stage` is an enum, so its `{ stage: 'won' }` seed stays valid.
- **WU13a — column write actions.** `columns: { <c>: { read?, write? } }`: a column with `write` is updated only by that
  action (`updatableBy`), never by the table's update action, so the parse refuses it in `update`, a `write` equal to
  the update action, one on a stamped column, and a column policy with neither field. The action counts as one the table
  names (own-target read). The artifact's column entry is `{ read?, write? }` (`ColumnPolicyArtifact`, auth-core),
  each field absent when undeclared, so every existing digest is unchanged; `classifyAccess` widens on a new write
  action and on a changed one, narrows on a removed one, and a column moved from `update` under one gives a removal line
  plus a widening line. Outside the listed touch points: one line of `packages/app/src/contract/artifact-schema.ts`
  (WU13b's directory) accepts `write`. Not done: the generated isolation tests (WU8's scaffold) have no column-write case.
- **WU13a — update subset.** The handle types already took any subset (Kysely's `Updateable` is all optional); what
  changed is the runtime: an update that sets no column (`{}`, only `undefined`) is refused (`updateValues`) instead of
  bumping the version. A type-level non-empty check was tried (a union of one-required-key members) and dropped: it
  printed the union in every excess-property error.
- **WU13a — transitive `over`.** `DbIndex.within` (dimension → every table whose chain holds it, and a top-level table
  its own) replaces `listedChildren`; `reachPredicate` takes the chain link's column. The stores keep the nearest
  container. A chain above a dimension no table owns is followed at runtime but not in the types (the types reach less).
  `kit-scale`: 364,886 instantiations (362,509 before).
- **WU13a — dates.** Codegen: `date` → `string` (`YYYY-MM-DD`), `timestamp(tz)` → `ColumnType<Date, Date | string, …>`;
  the column list gains `dates: [...]` only for a table with a `date` column, so other generated files are byte-identical
  (only the db fixture's `created_at` line changed). Bun decodes a `date` to UTC midnight in every time zone, and
  decodes BC, infinity and years past 9999 wrongly, so those are refused at read. `ctx.sql` and `fromRow` cannot see
  column types: they read a `Date` as its day for a `z.iso.date()` field only.
- **WU13a — `RowOf<typeof tables, T, A = read action>`** is new in `@fabrika/db/tables` (and the root); the old
  three-argument `RowOf<DB, P, T>` of the root is renamed `PolicyRow` (store-internal). The probe app is
  `packages/app/src/__tests__/probe-tasks/` (`assign`, `close`, `update`, `mine` over org, `markOverdue` on the
  handles), run on Postgres by `probe-tasks.test.ts`; its vocabulary is named `notes` because the harness signs for it.
- **WU13a review round 1.** (1) Transitive reach trusted an inherited chain column the database did not tie to the
  owner (a task of an `o2` project carrying `org_id = o1` listed under `o1`). The parse now requires the containment
  column and the inherited chain in one composite foreign key to the owner (`requireCoveringKey`), naming the key to add;
  every committed fixture and example already had it, so no migration changed. (2) A `date` is selected as the
  database's text (`cast(… as text)`, which the guard already admits as a selected own column); a `Date` that still
  arrives (an aggregate's `min`/`max`, a store's joined column) must be an exact UTC midnight in 0001–9999, witnessed in
  `Europe/Prague`, where Bun decodes `10000-01-01` as `9999-12-31T23:00Z`. `days.ts` is `temporal.ts` now. (3) The
  column list gains `timestamps: [...]` (only where there are some): a write's text is strict ISO 8601 with `Z` or an
  offset and a day's a real `YYYY-MM-DD`, checked in `readValues` before anything is sent. (4) `DbIndex<DB, P, V>` takes
  the vocabulary (`defineApp` passes it, one edit in `contract/kit.ts`), so the types follow the chain past an unowned
  dimension (`sparse-types.ts`). After the rebase onto WU8, `NoTablesIndex` (`contract/context.ts`) names `within`.
- **WU13a, from WU10's integration.** The scaffold wrote a hidden-column case for a column with only a write action;
  it now writes one only for a column with its own read action (`scaffold-cases.test.ts`). Not done: a generated
  column-write case, which needs a probe mutation of the column's action in `@fabrika/app/testing/isolation`.
- **WU13b — the cascade was the compiler's error type, not `any`.** A handler whose body reads a missing property
  returns the error type, and every unwrapped conditional over it answers the error type too, so `PendingIn` called
  the endpoint pending. `IsPending` now checks inside tuples only (`kit-mistakes/25`). A table the access form does not
  reach is an `Unavailable` property naming the table, the form and the form that reaches it (`Reaching` in
  `context.ts`), so `keyof ctx.db.target` now lists every table; `matrix.ts` asserts reach with `Reached<…>`. WU13a:
  your `over` reach change edits the same `matrix.ts` lines (106, 108).
- **WU13b — `fromRow` hint.** `.handle`'s return constraint is F-bounded (`HandlerReturn<F, O>`): it admits a
  snake_case row only when the handler returns one, so `ExactReturn` names `fromRow`; any other wrong return keeps
  the compiler's own message. `kit-scale`: 395,185 instantiations (362,617 at HEAD before the unit).
- **WU13b — reserved roles** are `RoleDefs` (`RoleDef & ReservedRoleMessage` on a key of `BuiltinRoleKey`, a literal
  type now exported by `@fabrika/auth-core`) in `defineVocabulary` and `defineContract`: two lines, at the role.
- **WU13b — member directory, the rule.** `ctx.members` is the read-only `MemberDirectory` exactly where the action is
  the target dimension's `members.list` (access `on`/`in`), decided by `endpointMembers` (`@fabrika/auth-core`) in
  the types, `facilitiesOf` and Control alike: the proxy admitted the caller for that action on that value and IAM
  re-checks the same action live, so the type promises what IAM answers. Another read action would type a list IAM
  refuses. **Labels (review round 1):** a user's label spells its address, so a list-only caller gets
  `label: null` unless the dimension declares `directory: 'labels'` in the vocabulary (artifact
  `dimensions.<d>.directory`, absent otherwise so digests stay; IAM `app_scopes.members_directory`, migration 0007;
  `classifyAccess` widens adding it with closer review). A directory does not make `boot` require a transport (every read endpoint of that action has
  one); without it only `list()` answers 503. **Outside the touch points:** Control's `needsMembershipTransport`
  issues the Zerops key for a list endpoint too, and IAM's schema reconcile keeps it while a dimension declares
  members (IAM's schema has no per-endpoint list fact). WU10: the skill's "Members" line and `AGENTS.md` still say
  `manage` only.
- **WU13b — checker.** A schema method on a literal const (`Status.optional()`) is read by applying it to the
  const's schema; a const whose initializer is refused is reported there only, not again at each import (three
  `direct-forms` expectations dropped their import-site lines). `raw-sql` refuses a call, tag or helper by the
  module's `sql` binding (`rawSqlBindings`: an import of `sql` under any alias, a destructured load), so an aliased
  driver tag is refused now and a `queries.ts` parameter named `sql` is not.
- **WU13b review round 1 — the Bun escape is closed:** `Bun` reached through `globalThis`/`window`/`self` (any key
  spelling) as a value, a global object destructured for `Bun` (nested too) or bound to a name is `forbidden-global`;
  the documented escape keeps only `process`. The directory witness is `packages/local-stack/__tests__/
  member-directory.test.ts`: proxy-core's verify service with a token cache, the real IAM RPC on its SQLite harness,
  `boot`. The proxy admits a holder of the action in another workspace (it reads no body); the access form refuses it.
- **WU13b review round 2 (integrator decision).** A server module (under `src/`, not a test) refuses every value use
  of `globalThis`, `global`, `self`, `window` and `Bun` (`typeof` tests and types stay), instead of enumerating
  spellings; round 1's destructuring and global-path special cases are deleted. `globalPath` stays: `web/` modules
  still reach `window`, and `checkFetch`, `eval` and `innerHTML` read through it. No example or fixture used a global
  object in `src/`. A schema const and the methods applied to it are one chain for the string order rule
  (`stringStepProblem`), refused by the reader at the call that adds the check.
