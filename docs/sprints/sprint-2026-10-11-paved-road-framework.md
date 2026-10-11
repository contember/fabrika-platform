<!--
On close, prepend an OUTCOME block here, then `git mv` this file to ../archive/:

> **OUTCOME — shipped YYYY-MM-DD.** <one-paragraph result.> Commit map: WU1 → <sha>,
> WU2 → <sha>, … Verification: <the gate command + numbers>. Backlog closed:
> <ids deleted/rescoped>. Deferred: <honest notes>.
-->

# Sprint — the paved-road application framework (2026-10-11)

**Goal.** An agent writes a Fabrika application on a paved road: a declarative shell, handlers colocated with their
endpoints, a mini-ORM scoped by the endpoint's capability, and raw SQL when it needs it, with every step off the road
detected and shown to the human who approves the deploy.

**Theme.** The platform guarantees two things at the high level: nobody reaches an endpoint outside authorization
(the proxy, [ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md)), and a widening waits for a human
on a protected environment ([ADR-0050](../decisions/0050-approved-access.md)). What a handler does with data is the
code's and the review's job. The framework makes the straightforward way the sound way, and turns a step off the road
into a review signal instead of a refusal. Success is the CRM rewritten in the new form, shorter than the dogfood
baseline, written by fresh agents from the skill alone, with an off-road request flagged all the way to the approval.

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

## Refs re-verified at HEAD (2026-10-11, `5b81b901`)

`✔` = confirmed live · `⚠` = drift, or HEAD contradicts an owner decision (the unit that resolves it is named).

- ✔ The mirrored tree: `implement(contract, { database, deps, handlers })` takes a handler tree typed equal to the
  contract — `packages/app/src/implement/implement.ts:50-57`, `ExactHandlers` at `packages/app/src/implement/types.ts:193`.
- ✔ The hand-written action union: `defineTables<DB, A extends string>(columns)` — `packages/db/src/policy.ts:193`.
- ✔ The read gap: `DimensionTable.get` takes only a `Ref` of the table's read action; `update` takes the update
  action — `packages/db/src/store.ts:630`, `:642`. `expectVersion` already exists — `store.ts:363`.
- ✔ No locking read: the guard admits one lock, `FOR SHARE` on a mutation's destination —
  `packages/db/src/guard.ts:22-23`, `:313-314`.
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
  `codegen --verify` runs the same query — `packages/db/CLAUDE.md:223-229`.
- ✔ The generated schema file declares interfaces and `columns` — `packages/db/src/codegen.ts:218`. Kept (Out of scope).
- ✔ The skill is one file read from the package — `packages/app/src/agent-skill.ts:9-24`; Control answers its own
  copy through `get_app_rules` — `packages/control/src/mcp/handler.ts:154`.
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
  `packages/db/CLAUDE.md:162-163`. WU3.
- ⚠ Decision 3 (handlers colocated) contradicts "the contract is a literal … no call of the application's own
  functions" — `docs/decisions/0012-fabrika-app-runtime.md:66-69`, the `implement`-only rule at `:79-84`, and the
  literal subset's one allowed function — `packages/check/CLAUDE.md:130-132`. WU4, WU9.
- ⚠ Decision 6 contradicts "An application's schema holds no database code" — `docs/decisions/0017-service-owned-postgres-migrations.md:144-198`,
  the codegen refusal — `packages/db/CLAUDE.md:223-229`, and the skill's migration rules —
  `packages/app/skill/SKILL.md:72-75`. WU5, WU10.
- ⚠ Decision 5 contradicts ADR-0050's "a code-only change deploys without a prompt" —
  `docs/decisions/0050-approved-access.md:217-219`: a code change that adds a deviation now waits. WU7, WU9.
- ⚠ The webhook rule "the handler's stores own their transactions" — `packages/app/CLAUDE.md:373-377` — meets WU3's
  one transaction per invocation. The delivery record stays outside the handler's transaction; WU3 keeps it so.

## Target shape (the default every unit builds to; WU1 and WU3 fix the exact names)

```text
fabrika.contract.ts                 the shell: vocabulary, mounts, sections; composes the slices' groups
src/schemas.ts                      shared zod schemas (literal), imported by the contract and the SPA
src/<slice>/endpoints.ts            the slice's endpoints with .handle(…) bodies (a contract module, sliced by the reader)
src/<slice>/logic.ts                business rules: plain TypeScript, no ctx, no data access
src/<slice>/queries.ts              reusable data access: mini-ORM calls and ctx.sql, given the endpoint's db handle
src/db/tables.ts                    table scopes, typed against the contract's vocabulary (no action union)
src/db/schema.generated.ts          codegen
db/migrations/*.sql                 plain SQL; database code allowed as a deviation
web/                                the SPA: imports the contract's types, src/schemas.ts and @fabrika/app/client only
src/**/__tests__/                   generated tests (committed, never edited) and authored tests
```

```ts
// src/deals/endpoints.ts — one endpoint as the agent writes it
reopen: r.mutation({ input: ReopenDeal, output: Done, access: { action: 'deals.write', on: 'deal', from: 'id' } })
	.handle(async ({ input, ctx }) => {
		const deal = await ctx.db.target.getForUpdate()
		if (!canReopen(deal.stage)) throw new ConflictError('only a won or lost deal reopens')
		return ctx.db.target.update({ stage: 'proposal' }, { expectVersion: input.expectVersion })
	}),
```

- `ctx.db.target` is the endpoint's own object (`on`) or scope (`in`): `get`, `getForUpdate`, `update`, `remove`, and
  its child tables. `ctx.db.within` serves `over`: `list`, `count`, `aggregate`. Jobs and webhooks get `ctx.db.ref` and
  `ctx.db.within` from their key. A query runs in one read-only transaction; a mutation in one read-write transaction.
- `ctx.db.unscoped.<table>` is the typed form off the road: guarded, in the endpoint's transaction, no scope
  predicate. `ctx.sql` is the raw form. Both are allowed and both are deviations.
- `fromRow(Schema, row)` maps a row to an output schema (snake_case → camelCase, `Date` → ISO text).

## Work units

### WU1 — The application architecture (M)

- **Problem.** No document says where an application's code goes. The dogfood CRM and the spikes each invented a
  layout. The checker has only refusals, so it cannot say "this left the structure" without blocking the build.
- **Verify first.** The checker's layout constants — `packages/check/src/layout.ts` — and that `Finding` has no severity —
  `packages/check/src/finding.ts`. The literal rule's contract graph — `packages/check/src/rules/literal.ts`.
- **Scope.**
  1. `docs/reference/application-architecture.md`: the layers and the slice (the target shape above), what lives in
     which directory and file, and what each layer may import or call: the shell, endpoint handlers, logic, data
     access (mini-ORM, `ctx.sql`), jobs, webhooks, files, the SPA and its typed client, shared schemas, generated and
     authored tests. A feature slice (`src/deals/`) holds its endpoints, logic and queries.
  2. The directions the checker enforces as **refusals** (platform integrity): the SPA imports no server module; logic
     and queries import no `@fabrika/app/implement`, test kit or framework internal; nothing imports a generated test.
  3. The directions that are **deviations** (a review signal): logic that reaches data (`ctx`, `@fabrika/db`, a
     queries module); a slice that imports another slice's queries; a handler outside a slice's `endpoints.ts`; data
     access outside `endpoints.ts`/`queries.ts`.
  4. The deviation seam in `@fabrika/check`: `Finding` gains `severity: 'refusal' | 'deviation'`; a deviation has a
     stable key `{ rule, site, tables }` (site = endpoint id, job name, or `<file>#<top-level declaration>`; never a
     line). `fabrika-check` prints deviations under their own heading and exits 0 when only deviations remain. Still no
     suppression syntax.
- **Acceptance / witness.** `packages/check/src/__tests__/structure.test.ts` over `fixtures/architecture-app/`: each
  deviation direction above is reported as a deviation with its key, each refusal direction as a refusal, the clean
  layout reports nothing, and the CLI exits 0 with deviations only and 1 with a refusal.
- **Touch points.** `docs/reference/application-architecture.md` (new), `docs/reference/README.md`,
  `packages/check/src/{finding.ts,layout.ts,check.ts,cli.ts}`, `packages/check/src/rules/structure.ts` (new),
  `packages/check/src/__tests__/`, `packages/check/CLAUDE.md`.

### WU2 — Tables derived from the contract (M)

- **Problem.** `src/db/tables.ts` restates the action names as a hand union and each table's containment
  (`policy.ts:193`). Spike A's `derive` removed both without changing the endpoint table.
- **Verify first.** Spike A's `defineTables(contract, columns)` overload and `reader/tables.ts` change (branch
  `spike/derive`, commit `d24b717c`); `packages/db/src/tables.ts` stays browser-safe.
- **Scope.** `defineTables<DB, typeof contract>(contract, columns)({ … })`: action and dimension names typed from the
  contract; a table's container column and a child's inherited chain derived from `dimensions`, with `in: { column }`
  only when the column breaks the `<container>_id` convention. The static reader reads the contract form
  (`readTablesSource` resolves the contract's `dimensions` literal). `TableInsert` / `TableUpdate` types. Refuse the
  old form; pre-1.0, no dual reader.
- **Acceptance / witness.** `packages/db/src/__tests__/derived-tables.test.ts` (typo in an action, a dimension, a child
  parent or a container column fails tsc at its line; a wrong derived column is refused by `defineTables`); a reader
  differential case in `packages/check/src/__tests__/differential.test.ts` (static read equals the evaluated policies).
- **Touch points.** `packages/db/src/{policy.ts,tables.ts}`, `packages/check/src/reader/tables.ts`, their tests,
  `packages/db/CLAUDE.md` (policy section).

### WU3 — The mini-ORM, scoped by the endpoint's capability (L)

- **Problem.** A handler reaches data through hand-written stores (109 lines in the CRM), a write capability cannot
  read its row (`store.ts:630`), and there is no locking read (`guard.ts:313`), so a precondition races.
- **Verify first.** How `boot` binds the layer and the `RequestFrame` (`packages/app/src/implement/boot.ts`,
  `dispatch.ts`); how a job's mutation is fenced (`fencedTransaction`, `packages/db/src/job-leases.ts`).
- **Scope.**
  1. `ctx.db` per invocation, built from the bound layer and the minted capability (the target shape above). No
     `defineStore` on the paved road.
  2. **The capability reads its own target**: a `Ref` of any action the table's policy names reads its own row,
     without the columns that carry their own read action the caller does not hold.
  3. `getForUpdate()`: `SELECT … FOR UPDATE` on the target's object predicate, in a mutation's transaction only; the
     guard admits that lock and no other new one.
  4. One transaction per request invocation (read-only for a query and an export); jobs and webhooks get
     `ctx.transaction(fn)`, fenced by the attempt's lease as today. A connector call never joins it. The webhook
     delivery record stays outside it.
  5. `expectVersion` on `update` and `remove`; `fromRow`.
  6. `ctx.db.unscoped.<table>`: guarded, in the invocation's transaction, scope predicate `true`; read-only in a query.
- **Acceptance / witness.** `packages/db/src/__tests__/orm.test.ts` and `packages/app/src/__tests__/orm-dispatch.test.ts`
  (Postgres required): a write `Ref` reads its row and no other; a hidden column stays hidden; two concurrent reopens —
  one wins, the other answers 409; a thrown handler commits nothing; a query cannot write, even through `unscoped`; a
  `ctx.db` kept past its request is refused. Type fixtures in `src/__tests__/implement-mistakes/` (a `getForUpdate`
  in a query, an unknown column in `update`) fail at their line in at most two lines. `implement-scale.test.ts` stays
  in budget.
- **Touch points.** `packages/db/src/{store.ts,guard.ts,orm.ts (new),database.ts}`,
  `packages/app/src/implement/{boot.ts,dispatch.ts,types.ts}`, `packages/app/src/jobs/runner.ts`, their tests,
  `packages/db/CLAUDE.md`, `packages/app/CLAUDE.md` (Serving a contract).

### WU4 — Handlers colocated with their endpoints (L)

- **Problem.** Every endpoint is written twice, in the contract and in the `implement` tree (`types.ts:193`). Spike B
  proved `.handle()` with a reader slice; it left links, webhooks, exports, `deps`, multi-file groups and the SPA build
  open.
- **Verify first.** Spike B's `slice.ts`, `colocated.ts` and `bun-plugin.ts` (branch `spike/colocated`, commit
  `f80f07c0`); that WU1's layout constants name the slice modules.
- **Scope.** `.handle(fn)` on `query`, `mutation`, `cron`, `webhook`, link procedures and export procedures; group
  modules (`src/<slice>/endpoints.ts`) composed by the contract; `serve(contract, { database, deps })` with a typed
  `deps` channel; the reader's slice applied to every contract module, so Control never fetches a handler-only module;
  `@fabrika/check/bun-plugin` for the SPA build; a differential corpus (slice vs evaluation). `implement` leaves the
  application surface in WU8.
- **Acceptance / witness.** `packages/check/src/__tests__/colocated.test.ts`: a handler module that throws at import
  is never requested by `contractReaderInputs` and never runs, and the static read equals `compileContract` of the
  evaluated modules; the differential corpus passes; a SPA build through the plugin holds no handler code. Type
  fixtures (`src/__tests__/colocated-mistakes/`): a missing `.handle`, `ctx.target` on `over`, the wrong principal, an
  undeclared job action — each at its line. `colocated-scale.test.ts`: 200 procedures within today's budget.
- **Touch points.** `packages/app/src/contract/{define.ts,colocated.ts (new)}`, `packages/app/src/implement/implement.ts`,
  `packages/check/src/{slice.ts (new),bun-plugin.ts (new),contract.ts,inputs.ts}`, `packages/check/src/reader/{value.ts,surface.ts}`,
  `packages/check/src/rules/literal.ts`, `packages/check/package.json` (export), their tests, `packages/check/CLAUDE.md`
  (literal subset).

### WU5 — Migration SQL: refuse only escapes, flag database code (M)

- **Problem.** Backlog 108 merged an allowlist that refuses every trigger, function, view and unusual expression
  (ADR-0017 `:144-198`). Decision 6 keeps a refusal only for what escapes the schema, the transaction or the platform.
- **Verify first.** Which allowlist rows are escapes and which are database code (`migration-allowlist.ts`); what the
  catalog check reads (`database-code.ts:131`).
- **Scope.**
  1. `@fabrika/platform-node/sql`, a runtime-neutral subpath (no Bun, no driver): the lexer and
     `classifyMigration(sql, schema) → { refused, deviations, objects }`.
  2. **Refused** (by file and line): transaction control and `SET`/`RESET`/`set_config`, `COPY` (any form), `GRANT`/
     `REVOKE`, `CREATE`/`ALTER ROLE`, `CREATE EXTENSION`, any schema but the application's own (`pg_catalog` relations
     included), `SECURITY DEFINER`, a function `SET` clause, a language other than `sql` and `plpgsql`, event triggers,
     and in a function or `DO` body: dynamic `EXECUTE` and any qualified name outside the schema.
  3. **Deviations** (with kind and object name): functions, triggers, views, rules, policies, domains, sequences,
     `DO`, and a default, `CHECK`, generated column or index expression that calls a function outside the reviewed list.
  4. The catalog check stays, as the runtime witness, not the approval's detector (Control cannot reach the database,
     ADR-0017 Alternatives): before the commit and at every start (`codegen --verify`) it refuses an integrity escape
     (a dependency outside the schema and `pg_catalog`, a definer function, a foreign language) and any database
     object that no migration file declares (`objects`), e.g. one created at runtime.
  5. Rewrite ADR-0017's "An application's schema holds no database code" section in place.
- **Acceptance / witness.** `packages/platform-node/src/__tests__/migration-classify.test.ts` (each refused form, each
  deviation kind, a plain file with none); `application-migrations.test.ts` on Postgres: a trigger declared in a
  migration applies and passes the start check, a trigger created outside a migration fails the start check, `COPY …
  PROGRAM` and `app_other.t` are refused before any SQL runs.
- **Touch points.** `packages/platform-node/src/{migration-sql.ts,migration-allowlist.ts,database-code.ts,application-postgres-migrations.ts}`,
  `packages/platform-node/package.json` (export), `packages/db/src/codegen.ts`, their tests,
  `docs/decisions/0017-service-owned-postgres-migrations.md`, `packages/db/CLAUDE.md` (codegen invariant).

### WU6 — Raw SQL as a legitimate tool (M)

- **Problem.** The checker refuses raw SQL (`rules/runtime.ts:259`), so an agent that needs a join report loads every
  row or invents a hack. Decision 4: `ctx.sql` is legitimate.
- **Verify first.** That WU3's invocation transaction is the one `ctx.sql` must join; that WU5's lexer subpath exists.
- **Scope.** `ctx.sql` as a tagged template: values bound as parameters only, run in the invocation's transaction,
  read-only in a query or an export, answering plain rows. Runtime refusals (platform integrity), from the static parts
  of the template with WU5's lexer: DDL, transaction control, `SET`/`set_config`, `COPY`, `LISTEN`/`NOTIFY`, a
  qualified name outside the schema, a `pg_*` relation, more than one statement. The `raw-sql` rule keeps refusing a
  driver's `sql` (Kysely, `bun`) and stops refusing `ctx.sql`, which WU7 reports as a deviation.
- **Acceptance / witness.** `packages/db/src/__tests__/raw-sql.test.ts` (Postgres required): a join report answers in
  the endpoint's transaction and rolls back with it; each refused form throws before anything is sent; an interpolated
  value is a parameter, never text; a query's `ctx.sql` cannot write. `rules.test.ts` holds the changed rule's pair.
- **Touch points.** `packages/db/src/sql.ts` (new), `packages/app/src/implement/{types.ts,dispatch.ts}`,
  `packages/check/src/rules/runtime.ts`, `packages/check/package.json` (dependency), their tests, `packages/db/CLAUDE.md`
  ("No raw handle" invariant rewritten).

### WU7 — Deviations in the reviewed snapshot (L)

- **Problem.** Control's snapshot holds the contract and migration checksums (`snapshot.ts:16`); nothing records code
  that leaves the paved road, so the approver cannot see it.
- **Verify first.** `contractReaderInputs` rounds and `SNAPSHOT_LIMITS` (`read.ts:20`); how the approval page renders
  `AccessChange` lines (`packages/dashboard/src/routes/approvals/detail.tsx`).
- **Scope.**
  1. `readDeviations(files)` in `@fabrika/check/contract` (Worker-safe): WU1's structure deviations, `ctx.sql` sites
     with the tables their static text names and whether they write, `ctx.db.unscoped` sites, and writes to a table
     outside the endpoint's target and its children. A reference to `ctx.sql` or `ctx.db.unscoped` in any position
     counts, so an alias is still a deviation. The checker prints the same list.
  2. The snapshot gains `deviations` (code, keyed as WU1 says) and per-migration deviations (WU5's `classifyMigration`).
     The digest covers them only when non-empty, so every stored approval stays valid.
  3. `classifyAccess`: a new deviation key widens, with `review: 'closer'` on its line ("Endpoint `api.deals.pipeline`
     runs raw SQL reading `deals`, `companies` — needs closer review"); a removed one is a removal.
  4. The approval page and the environment page show deviation lines as "needs closer review", and the environment
     page lists the published snapshot's deviations, protected or not. MCP `get_deployment` names them.
- **Acceptance / witness.** `packages/control/src/__tests__/approval-deviations.test.ts`: a commit pair that adds a
  `ctx.sql` site parks on a protected environment and publishes at once on an unprotected one, with the closer-review
  line in both; the same deviation on the next deploy is unchanged; an old snapshot's digest is unchanged.
  `packages/check/src/__tests__/deviations.test.ts`: every kind, the alias case, line moves keep the key.
- **Touch points.** `packages/check/src/{contract.ts,deviations/ (new)}`, `packages/control/src/approval/{snapshot.ts,read.ts,diff.ts}`,
  `packages/control-contract/src/` (DTO), `packages/dashboard/src/routes/{approvals/detail.tsx,apps/detail.tsx}`,
  `packages/control/src/mcp/handler.ts` (`get_deployment` only), their tests, `packages/control/CLAUDE.md`.

### WU8 — The Zerops example and the generated tests in the new form (M)

- **Problem.** `examples/zerops-app` (128 hand-written server lines without `fabrika.config.ts`, `implement`, a store) and the generated tests
  (`endpointAccessKit` boots `implement`'s result) show the old form, and the template is what agents copy.
- **Verify first.** `fabrika db test-scaffold`'s inputs (`scaffoldInputs`, `packages/check/src/scaffold.ts:277`) and
  the fixture app in `packages/cli/src/__tests__/fixtures/isolation-app/`.
- **Scope.** Rewrite `examples/zerops-app` to WU1's structure on WU2–WU4 and WU6 (`notes/endpoints.ts`, no store, no
  `src/app.ts` tree). `test-scaffold` and `@fabrika/app/testing/isolation` boot `serve`; the endpoint access cases
  cover own-target reads. Remove `implement`, `defineStore` and `defineChildStore` from the application surface
  (framework tests keep an internal entry). Regenerate `packages/cli`'s fixture tests and the local stack's Notes
  fixture. Count lines before and after.
- **Acceptance / witness.** `bun run test:examples` and `FABRIKA_TEST_POSTGRES_URL=… bun test --isolate examples/zerops-app`
  pass; `fabrika-check examples/zerops-app` reports no refusal and no deviation; the regenerated `packages/cli` fixtures
  pass; `bun run local:smoke` deploys Notes.
- **Touch points.** `examples/zerops-app/`, `packages/check/src/{scaffold.ts,scaffold-sample.ts}`,
  `packages/app/src/testing/{isolation.ts,endpoint-access.ts,policy-isolation.ts}`, `packages/app/src/index.ts` and
  `packages/db/src/index.ts` (exports), `packages/cli/src/__tests__/fixtures/`, `packages/local-stack/src/` (fixture only).

### WU9 — ADR-0012 and ADR-0050 rewritten (S)

- **Problem.** ADR-0012 states the literal contract and `implement` as the only way (`:66-84`); ADR-0050 says a
  code-only change never prompts (`:217-219`).
- **Verify first.** The sprint's Decisions section; ADR-0017 is WU5's.
- **Scope.** Rewrite ADR-0012 in place: the declarative shell, colocated handlers and the slice, the paved road
  (mini-ORM, own-target read, `getForUpdate`), raw SQL as legitimate, deviations as a review signal, and the rejected
  declared operations, RLS and isolated host in Alternatives. Rewrite ADR-0050 §1 and §3 for deviations in the
  snapshot and their classification. Update `docs/reference/application-runtime.md`. Delete backlog 104 (raw SQL
  replaces declared report kinds) and repoint its references.
- **Acceptance / witness.** `grep -rn` finds no statement that `implement` is the only way, that raw SQL is refused,
  or that a code-only change never prompts, across `docs/` and every `CLAUDE.md`; `bunx dprint check` passes.
- **Touch points.** `docs/decisions/{0012-fabrika-app-runtime.md,0050-approved-access.md,README.md}`,
  `docs/reference/application-runtime.md`, `docs/backlog/{104-…md,README.md}`.

### WU10 — Agent skills (M)

- **Problem.** The skill is one 162-line file of rules in refusal order, with no version
  (`packages/app/skill/SKILL.md:1-9`), and dogfood findings 14–16 are gaps in it.
- **Verify first.** Who reads it: the builder install, `get_app_rules`, `renderAgentsFile` and their tests
  (`agent-skill.test.ts`).
- **Scope.** **One skill, `fabrika-app`, with focused reference files**, not several skills: one trigger and one
  version to match, the MCP tool and `AGENTS.md` need one body anyway, and the always-loaded part stays short while the
  rest loads on demand. `skill/SKILL.md` (at most ~120 lines): the paved road first, the architecture, the loop
  (edit → `fabrika db codegen` → `test-scaffold` → typecheck → `fabrika-check`), what a deviation is and when raw SQL is
  fine, and when to ask the human. `skill/references/`: `endpoint.md`, `table-and-migration.md`, `jobs.md`, `files.md`,
  `webhooks-links-connectors.md`, `errors.md` (reading checker findings and type errors). Frontmatter `version` equals
  `@fabrika/app`'s version; the builder installs the skill from the application's installed `@fabrika/app`;
  `get_app_rules` takes an optional topic, states its version and warns when the workspace pins another.
  `renderAgentsFile` renders all of it. Fix dogfood findings 14 (`admin` is reserved), 15 (`fileTableSql` key and
  chain shape) and 16 (the test seed's limits).
- **Acceptance / witness.** `agent-skill.test.ts`: version equals `package.json`, every reference file is rendered,
  `examples/zerops-app/AGENTS.md` is the rendered file; every code block in the skill type-checks against the workspace
  (a test compiles them). WU11's fresh-agent trial uses only these files.
- **Touch points.** `packages/app/skill/`, `packages/app/src/agent-skill.ts`, `packages/app/src/__tests__/agent-skill.test.ts`,
  `packages/control/src/mcp/handler.ts` (`get_app_rules` only), the builder's skill install (`packages/builder/cli/src/inject-skills.ts`),
  `examples/zerops-app/AGENTS.md`, `packages/app/CLAUDE.md` (the skill invariant).

### WU11 — Acceptance: the CRM in the new form (L)

- **Problem.** No unit alone proves the road is shorter, learnable from the skill, and honest about deviations.
- **Verify first.** The dogfood baseline counts (Evidence); the dogfood CRM's 30 endpoints, job, files and SPA.
- **Scope.**
  1. `examples/crm`: the dogfood CRM rewritten to WU1's structure with the same surface, plus spike exercises
     `deals.reopen` (precondition enforced with `getForUpdate`) and `deals.source`, and a pipeline report on `ctx.sql`.
     Add it to `test:examples`.
  2. **Counts** against the baseline, the same file classes: hand-written server lines and files. Pass: at most
     400 lines (−25 %) and no file that only mirrors another; report migrations and tests apart.
  3. **Fresh-agent trial**: agents that see only WU10's skill files write the CRM's endpoint groups from a feature
     brief. Record every tsc and checker run. Pass: at most 3 runs per endpoint group, no edited generated file, no
     loosened access to make a test pass.
  4. **Deviation trial**: an agent asked for something off the road (an audit trigger on `deals`; a cross-scope admin
     report) produces code the checker flags as a deviation and does not refuse. On Notes through the local stack
     (`local:smoke` path, protected `prod`), the run parks and the approval page shows the line as "needs closer
     review"; on the CRM, Control's reader and `classifyAccess` over the commit pair show the same line.
- **Acceptance / witness.** `bun run test:examples` green with `examples/crm` (Postgres required); the counts, the trial
  table and the parked run recorded in the Run log; the deviation trial's parked run seen in the dashboard
  (agent-browser screenshot named in the log).
- **Touch points.** `examples/crm/` (new), root `package.json` (`test:examples`), `docs/sprints/` (this Run log).

## Out of scope (explicit)

- **Declared operations** (`c.read`/`c.update` with `when`/`set`/`inc`): rejected by the owner as too declarative,
  although its spike passed. Business logic is TypeScript.
- **Row-level security** and any attempt to make data security statically provable: decision 1.
- **An isolated handler host or a platform data executor**: decision 1; it stays the long-term hard boundary in
  ADR-0012's Alternatives.
- **One literal column catalogue in `schema.generated.ts`**: the file is generated and `codegen --verify` guards it,
  so its two declarations (interfaces and `columns`) are not a fact an agent repeats.
- **Deriving zod inputs from rows**: spike A lost bounds silently and made a migration an API change. Inputs stay
  written; `fromRow` covers outputs.
- **File-based routing** (spike C) and **entity sugar** (spike D).
- **A least-privileged database role** ([backlog 110](../backlog/110-give-each-application-a-least-privileged-database-role.md)).
  WU5's and WU6's refusals are name rules, not privileges. Raising raw SQL to a legitimate tool raises 110's priority;
  it is still large and provider-wide.
- **Two-capability access** for `move` and merges ([backlog 97](../backlog/97-the-generated-tests-have-no-move-case.md)).
- **Destructive-migration rules** ([backlog 98](../backlog/98-application-migrations-have-no-destructive-change-rules.md)).
- **A data layer on Cloudflare**: still Bun and Postgres only.
- **Dogfood findings not addressed:** 1 (unpublished packages: the release path), 2 (a second app on the local
  stack: WU11 uses Notes instead), 6 (a membership stand-in for the endpoint test), 7 (the seed and `CHECK`
  columns), 8 (a deploy failing before the build gives no reason), 9 (own rows only), 10 (listing attachments), 11
  (listing members without `members.manage`), 12 (author tests for jobs), 13 (`fabrika dev`), 17 (builder and MCP
  locally), 18 (the template's `bun.lock`), 19 (refusal texts), 20 (the checker reads dev scripts: reading less is a
  place to hide code and needs its own decision), 21 (smaller items). WU10 fixes 14–16.
- The 105/106/109 hardening (frozen `Database`, the per-`boot` mint, the checker's load rules) and 107 (input domains
  in the approval diff) stay as they are; no unit relaxes them.

## Decisions

Owner decisions, binding (condensed):

1. **Declarative shell, arbitrary code.** The shell is the vocabulary (dimensions, actions, roles), endpoints (kind,
   callers, access form, input/output), jobs, files and webhooks. Business logic is TypeScript. No operation grammar,
   no RLS, no isolated host, no static proof of data security.
2. **The platform protects at the high level:** the proxy admits only authorized calls (ADR-0022); a human approves
   every widening on a protected environment (ADR-0050). What a handler does with data is the code's and the review's.
3. **A paved road with strong guarantees:** the mini-ORM scoped by the endpoint's capability, which reads its own
   target; `expectVersion` and `getForUpdate`; `fromRow`; table scope and action names derived from the contract;
   `.handle()` colocated with the endpoint and sliced off by the reader; no mirrored `implement` tree.
4. **Raw SQL is legitimate**: `ctx.sql`, parametrized, in the endpoint's transaction.
5. **Deviation is a review signal, not a refusal.** Static analysis detects raw SQL, unscoped queries, writes outside
   the endpoint's target and leaving the architecture. Deviations are part of the reviewed snapshot; a new one waits
   for a human on a protected environment and the console marks it "needs closer review". Hard refusals stay only for
   platform integrity: secrets, framework internals, escaping the schema or the transaction.
6. **Migration SQL**: refuse only what escapes the schema, the transaction or the platform; database code and unusual
   expressions become deviations.
7. The 105/106/109 hardening and 107 stay.
8. **The application architecture** is prescribed in a reference document (WU1); examples and the CRM follow it.
9. **Agent skills** ship in `@fabrika/app` and are the only text the fresh-agent trial sees (WU10).

Resolved in this sprint:

- **The catalog check is the runtime witness, not the detector.** Control decides approval from the commit and
  cannot reach the database, so the static classifier (WU5) feeds the snapshot. The catalog check refuses integrity
  escapes and database objects no migration declares, before the commit and at every start.
- **Function bodies are opaque**, so a body may hold no dynamic `EXECUTE` and no name outside the schema; a function
  is never `SECURITY DEFINER`. These are refusals because they can escape the schema.
- **`ctx.db.unscoped`** exists so that a cross-scope need has a typed, guarded form; agents otherwise reach for raw
  SQL. It is a deviation like `ctx.sql`.
- **A deviation's key has no line number**, so moving code does not re-prompt; the site is the endpoint, the job or the
  top-level declaration.
- **The snapshot digest covers deviations only when there are some**, so approvals stored before this sprint stay valid.
- **One skill with reference files** (WU10), not several skills.
- **The ADR text follows the code**: ADR-0012 and ADR-0050 are rewritten once (WU9); ADR-0017 with WU5. Until then this
  sprint outranks them (`docs/CLAUDE.md` precedence).
- The idea document is deleted and its still-valid evidence is above.

## Sequencing

Each unit runs in its own worktree. Units in one step share no source file. Each unit edits only its own packages'
`CLAUDE.md` sections; the integrator merges those.

| Step | Units         | Parallel | Why this order                                                                                                   |
| ---- | ------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| 1    | WU1, WU5      | yes      | the architecture and the deviation seam; WU5 is `platform-node` only                                             |
| 2    | WU2, WU3, WU4 | yes      | `policy.ts`/`reader/tables.ts` · `store.ts`/`implement/{boot,dispatch,types}` · `contract/`/`implement.ts`/slice |
| 3    | WU6, WU9      | yes      | `ctx.sql` needs WU3's transaction and WU5's lexer; WU9 is docs only                                              |
| 4    | WU7, WU8      | yes      | WU7 needs WU1, WU4–WU6; WU8 needs WU2–WU4 and WU6; disjoint territories                                          |
| 5    | WU10          | —        | the skill describes what is built; it regenerates WU8's `AGENTS.md`                                              |
| 6    | WU11          | —        | the CRM, the counts and both trials                                                                              |

Seams fixed before step 2: WU1's `Finding`/deviation key; the `ctx.db` names (target shape above, final in WU3's first
commit, which WU4 imports and does not edit); WU5's `classifyMigration` signature. WU4 rebases on WU3's `types.ts`
before it lands. WU7 and WU10 both touch `packages/control/src/mcp/handler.ts` in different tools, in different steps.
The active [MCP authoring sprint](sprint-2026-10-07-mcp-authoring.md) also edits that file; coordinate there.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. Graduate each entry:
     changed the *why* → ../decisions/NNNN ; new future work → ../backlog/NN ;
     transient → leave it (dies with the sprint on archive). After graduating,
     trim to a one-line pointer ("→ ADR-0022"). -->
