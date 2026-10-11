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
| 5    | WU9, WU10           | the ADRs and the skill describe what is built                                                                                                              |
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
