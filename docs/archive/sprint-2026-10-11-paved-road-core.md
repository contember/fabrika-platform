> **OUTCOME — shipped 2026-10-12.** The first part of the paved-road sprint. The goal, the decisions and the units
> that followed are in [the second part](sprint-2026-10-11-paved-road-framework.md).
>
> **Shipped.** An application is written on the paved road:
>
> - the staged kit fixes the file order and colocates `.handle()` with each endpoint, sliced off by the reader (WU0, WU4);
> - tables derive their scope and actions from the vocabulary (WU2);
> - the mini-ORM runs in the invocation's transaction, reads its own target, and has `getForUpdate` and `expectVersion` (WU3);
> - raw SQL is a declared `ctx.sql` (WU6); migration SQL refuses only escapes and flags database code (WU5);
> - declared reach and database code reach the approval as "needs closer review" lines (WU7);
> - each application has a least-privileged role family (WU12);
> - the Zerops example and the generated tests follow the road (WU8); ADR-0012 and ADR-0050 describe it (WU9);
> - one versioned skill with reference files teaches it (WU10); the probes' ergonomics (WU13a, WU13b);
> - a public static SPA (WU14) and durable IAM audit (WU18).
>
> **Commits** (first…last on main):
>
> - WU1 `f152d1f3`…`41ef4317` · WU5 `ad7a1f63`…`af5eebe2` · WU0 `23ed33c2`…`2e401687` · WU12 `91821218`…`8954408c`
> - WU2 `e3b1a5e4`…`9ca4b766` · WU3 `50ff8078`…`166b4e32` · WU6 `c57e9c47`…`e56e164b` · WU4 `6309e425`…`b38df7fb`
> - WU7 `47d161a9`…`2a4363b2` · WU8 `1bd62a49`…`4cb9228b` · WU9 `ae469fff` · WU13a `9a923e40`…`f9723c91`
> - WU13b `016c76e0`…`191af008` · WU14 `8c9110c4`…`5f861124` · WU10 `9c112304`…`aa71d2f2` · WU18 `71e57108`…`75ace877`
>
> **Verification.** No full-suite count was recorded for this half; the second part's close at `440affe9` ran every
> unit (7299 pass, 0 fail). `kit-scale`: 200 endpoints in 10 groups at 395,185 type instantiations (budget 1,000,000).
>
> **Backlog.** Closed: 104 (WU9), 110 (WU12). Rescoped: 71 to Control and Operations delivery (WU18). Deferred: the
> Zerops role facts (116); the generated column-write case (162); a one-line error for a job without `.handle` (164).
> Since shipped: share links, `creates` and member management in the generated endpoint test (113, `b45f8cf6`); the
> Postgres batch hang (115, `1aa01f78`).

# Sprint — the paved-road application framework, core (2026-10-11)

The goal, theme, target shape and decisions are in the [second part](sprint-2026-10-11-paved-road-framework.md).

## What the evidence decided

The declared-operations proposal (`docs/ideas/agent-friendly-app-framework.md`, deleted; git holds it) was rejected by
the owner as too declarative. What its evidence still decides:

- **Baseline.** The dogfood CRM has 538 hand-written server lines and writes each fact 3–4 times. Target: under 400 (WU11).
- **Spike A** (tables derived from the vocabulary) is adopted (WU2). Deriving zod inputs from rows is rejected: it
  lost bounds silently and made a migration an API change.
- **Spike B** (`.handle()` beside each procedure, a syntactic contract slice in the reader) is adopted (WU0, WU4): the
  endpoint tree is written once, at fewer type instantiations than `implement`.
- **Spikes C** (file-based routing) and **D** (entity sugar) are rejected.
- **The shared wall:** a write capability could not read its row and there was no locking read (WU3).
- **Type errors are product surface:** an error lands on its own line, names the fix, and prints no mapped-type dump
  or `never` (WU0).
- **Two plan reviews** found a type cycle in the first file order (TS7022), answered by the vocabulary-first order
  (WU0), and that a syntactic deviation detector is evaded, answered by declared off-road fields.
- **A public intake application** fits the paved road on its staff side and breaks on seven gaps on its public side:
  WU14–WU20 close them, WU21 builds the module privately.

## What HEAD contradicted (resolved)

At `5b81b901` the owner decisions contradicted the docs and the checker. Each is rewritten:

- Raw SQL is legitimate (decision 4) against the `raw-sql` rule, `packages/db/CLAUDE.md`, the skill and backlog 104 → WU6, WU9, WU10.
- A capability reads its own target (decision 3) against "a write action does not include the read action" → WU3, WU9.
- Colocated handlers (decision 3) against ADR-0012's literal contract and `implement`-only rule → WU0, WU4, WU9.
- Database code as a deviation (decision 6) against ADR-0017's "no database code" → WU5, WU10.
- A declared deviation waits for approval (decision 5) against ADR-0050's "a code-only change never prompts" → WU7, WU9.
- Two `ConflictError` classes → one on the application surface (WU3). The skill had no version → WU10.

## Work units (shipped)

### WU0 — The staged kit, landed first (M/L)

- **Problem.** Tables typed by `typeof contract` and handlers in its slice modules give TS7022; parallel units cannot
  each invent the fix.
- **Scope.** The public signatures of `defineVocabulary` → `defineTables(vocabulary, columns)` → `defineApp` →
  `app.group` → `app.contract` → `serve(contract, { database, deps })`, with type tests and throwing stubs; multi-file
  groups, exact output, the declared off-road fields; method gating by string-literal error tuples, at most two lines.
- **Witness.** `kit-types.test.ts` over `kit-mistakes/` (each diagnostic at its line, no `never`, no dump);
  `kit-scale.test.ts` within the `implement-scale` budget.

### WU1 — The application architecture (M)

- **Problem.** No document said where an application's code goes, and the checker had only refusals.
- **Scope.** `docs/reference/application-architecture.md` (layers, slices, what each may import). Refusals for
  platform integrity (the SPA imports no server module; nothing imports a generated test). Structure findings as
  hints: `Finding.severity: 'refusal' | 'hint'`, and `fabrika-check` exits 0 with hints only.
- **Witness.** `structure.test.ts` over `fixtures/architecture-app/`.

### WU2 — Tables derived from the vocabulary (M)

- **Problem.** `src/db/tables.ts` restated the action names and each table's containment.
- **Scope.** Action and dimension names from the vocabulary; container and chain columns derived from the
  `<container>_id` convention; `TableInsert` / `TableUpdate`. The old form is refused, with no dual reader.
- **Witness.** `derived-tables.test.ts`; the table cases of `differential.test.ts`.

### WU3 — The mini-ORM and the invocation's transaction (L)

- **Problem.** Hand-written stores, no own-row read for a write capability, no locking read, and a transaction per
  store call, so a precondition raced.
- **Decisions.**
  1. The API matrix by access form (`on`, `in`, `over`, `creates`, `member`), now in
     [`application-runtime.md`](../reference/application-runtime.md) and the skill.
  2. A `Ref` of any action the table names reads its own row; a column of another read action is hidden in data and type.
  3. `getForUpdate()` is the only new lock, in a mutation only.
  4. The invocation owns one transaction: committed after the handler and output validation pass, rolled back on
     throw. Queries and exports run read-only; a job writes only inside its fenced `ctx.transaction`; a webhook
     delivery is one transaction with its record outside it. Data work first, external calls after.
  5. No `ctx.jobs.enqueue`: jobs are cron only, so the outbox is a row the next run picks up.
  6. `ctx.db.unscoped.<table>` per declaration, never a `fabrika_*` table; `fromRow`; one `ConflictError` from `@fabrika/app`.
- **Witness.** `orm.test.ts`, `orm-dispatch.test.ts` on Postgres: own-row read, two concurrent reopens (200 and 409),
  a thrown handler commits nothing, a captured handle is refused elsewhere.

### WU4 — Colocated handlers and the reader slice (L)

- **Problem.** Every endpoint was written twice, in the contract and in the mirrored `implement` tree.
- **Scope.** `.handle()` on every procedure kind; groups across files; `serve` binds handlers by endpoint id; the
  declared fields (`sql`, `unscoped`, `connect`, `issues`) in the kit, the artifact and the reader; the reader's
  slice on every shell module, so Control reads only the shell; `@fabrika/check/bun-plugin` for the SPA build.
- **Witness.** `colocated.test.ts`: a handler module that throws at import is never requested; the static read equals
  the evaluated contract; a plugin build holds no handler code.

### WU5 — Migration SQL: refuse escapes, declare database code (L)

- **Problem.** Backlog 108's allowlist refused every trigger, function and view; decision 6 refuses only escapes.
- **Decisions.** `@fabrika/platform-node/sql` classifies each migration: **refused** (transaction control, `SET`,
  `COPY`, grants and roles, extensions, another schema, `fabrika_*`, `SECURITY DEFINER`, languages other than `sql` and
  `plpgsql`, dynamic `EXECUTE`, an unparsable body), **deviations** (functions, triggers, views, rules, policies,
  sequences, `DO`), and a **function allowlist** instead of name rules. The object manifest the files declare is the
  authority; the catalog check before commit and at start is its runtime witness. Domains stay refused. The rules are
  coarse and fail closed; the role (WU12) is the boundary → [ADR-0017](../decisions/0017-service-owned-postgres-migrations.md).
- **Witness.** `migration-classify.test.ts`; on Postgres a declared trigger passes the start check and an undeclared one fails it.

### WU6 — Raw SQL, declared (M)

- **Problem.** The checker refused raw SQL, so a join report loaded every row or a hack.
- **Scope.** `ctx.sql(Schema)` as a tagged template, only on a site that declares `sql`: values are parameters, it runs
  in the invocation's session (read-only for `'read'`), rows are parsed. It refuses DDL, transaction control, another
  schema, `fabrika_*` and `pg_*` relations, functions outside WU5's allowlist and more than one statement. `ctx.sql` on
  an undeclared site is a checker hint.
- **Witness.** `raw-sql.test.ts` on Postgres, run as the runtime role.

### WU7 — Deviations in the reviewed snapshot (L)

- **Problem.** The approver saw no data reach beyond the paved road.
- **Decisions.** Only data-reach deviations reach the snapshot (the declared fields and WU5's database code); structure
  hints stay checker output. A site's identity is compared apart from its effect; a new site, table, connector or
  `read` → `write` widens with `review: 'closer'`. The digest covers database code only when there is some, so stored
  approvals stay valid → [ADR-0050](../decisions/0050-approved-access.md).
- **Witness.** `approval-deviations.test.ts`: `sql: 'read'` parks on a protected environment and publishes at once on
  an unprotected one, with the closer-review line in both.

### WU8 — The Zerops example, the generated tests and the application surface (M)

- **Problem.** The example and the generated tests showed the old form, and agents copy the template.
- **Scope.** `examples/zerops-app` in WU1's layout on `serve`; the generated tests boot `serve`, gain own-target cases
  and authored seeds; `implement`, `defineStore` and `defineChildStore` leave the application surface; a kit without
  tables (`defineApp(vocabulary)`); a real SPA build test.
- **Witness.** `test:examples`; `fabrika-check examples/zerops-app` with no refusal and no hint; `local:smoke` deploys Notes.

### WU9 — ADR-0012 and ADR-0050 rewritten (S)

- **Scope.** ADR-0012 states the staged kit, colocated handlers, raw SQL and deviations as a review signal, with
  declared operations, RLS and an isolated host in Alternatives. ADR-0050 states the declared fields, the migration
  deviations and the own-target read. Backlog 104 deleted.
- **Witness.** No operative doc says `implement` is the only way, raw SQL is refused, or a code-only change never prompts.

### WU10 — Agent skills (M)

- **Decision.** One skill, `fabrika-app`, with focused reference files, not several skills: one trigger, one version,
  and one body for the MCP tool and `AGENTS.md`. Its `version` equals `@fabrika/app`'s; the builder installs it from
  the application's pinned package; `get_app_rules` takes a topic and warns on another pin.
- **Witness.** `agent-skill.test.ts`; every code block type-checks (`skill-code.test.ts`).

### WU12 — A least-privileged database role per application (L)

- **Problem.** Migrations and the runtime shared one credential. With raw SQL legitimate, only a role bounds a statement.
- **Decision.** `app_<id>` owns the schema and migrates; `run_<id>` has DML only and serves; neither holds a superuser
  or server-file privilege → [ADR-0017](../decisions/0017-service-owned-postgres-migrations.md). Backlog 110 closed.
- **Witness.** `application-postgres-roles.test.ts`; `ctx.sql` as the runtime role cannot write `fabrika_migrations` (42501).

### WU13a — Paved-road data ergonomics from the probes (M)

- **Problem.** Two fresh-agent probes left the road for ordinary needs.
- **Scope.** A column write action (`columns: { assignee: { write: 'tasks.assign' } }`); `update` of a subset;
  `over` reaching every table whose chain holds the dimension; `RowOf<typeof tables, T, A>`; `date` columns as
  `YYYY-MM-DD` strings and ISO strings for timestamp writes.

### WU13b — Shell and checker ergonomics from the probes (M)

- **Scope.** A reserved role name is a type error at `defineVocabulary`; a handler's type error stays in the handler;
  a raw row where the output is camelCase names `fromRow`; the reader accepts modifiers on an imported schema; `raw-sql`
  refuses by import origin; a read-only member directory `ctx.members.list()` under `members.list`.

### WU14 — A public static SPA (S)

- **Decision.** `c.spa(prefix, { dir, access: { public: true } })` adds a row of a new anonymous kind `public-spa`:
  `GET <prefix>/*`, no credential read, no token minted, no login bounce. The approval shows a new public SPA as a
  widening → [ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md), ADR-0050 §3.

### WU18 — Durable audit (M)

- **Decision.** Every IAM-owned change writes its `audit_events` row in the change's own batch, and a failed write
  fails the change; a login writes `auth_log` before the answer; every installation-admin `/admin/*` request is
  recorded; `auth_log` retention is a setting. Application audit stays in application tables on the paved road, with
  no framework API. Backlog 71 rescoped to delivery from Control and Operations → `packages/iam/CLAUDE.md`.

## Sequencing (steps 0–6a)

Each unit ran in its own worktree; the units of one step shared no source file. Step 0: WU0 (WU5 running). 1: WU1.
2: WU2, WU3, WU4. 3: WU6, WU12. 4: WU7, WU8. 5: WU13a, WU13b. 5b: WU9, WU10. 6a: WU14, WU17, WU18 (WU17 is in the
second part).

## Run log

- WU1's asks (handle types, `architecture-app` as a differential fixture) → shipped in WU3 (`DbHandle`, `baf40404`)
  and WU4 (`cc271e96`).
- WU5: the classifier's refused forms, the function allowlist, the manifest folded per file and the coarse
  fail-closed rules of review round 2 → [ADR-0017](../decisions/0017-service-owned-postgres-migrations.md).
- WU5's and WU8's stale skill text → shipped in WU10 (`9c112304`).
- WU0: the vocabulary-first order breaks TS7022 → [ADR-0012](../decisions/0012-fabrika-app-runtime.md).
- WU12: the role family, the launcher without the provisioning credential and the residuals →
  [ADR-0017](../decisions/0017-service-owned-postgres-migrations.md); `CREATEROLE` and `portTls` on Zerops → backlog 116.
- WU3: own-target read and its limit → [ADR-0050](../decisions/0050-approved-access.md), backlog 154; a webhook
  record outside its transaction → [`application-runtime.md`](../reference/application-runtime.md); Bun's unhandled
  release rejection → `packages/db/CLAUDE.md`.
- WU3's hook where `boot` takes the approved declaration → shipped in WU4 (`ac1600ca`, `e45055f1`).
- WU6: `ctx.sql` calls no function the migrations declare → [`application-runtime.md`](../reference/application-runtime.md).
- WU4: the declared reach in the artifact and `defineApp`'s one untyped join → `packages/app/CLAUDE.md`; a job,
  webhook, link or export without `.handle` prints the builder's type → backlog 164.
- WU7: database code's identity and the transitions the diff cannot classify → [ADR-0050](../decisions/0050-approved-access.md).
- WU8: the kit without tables → `packages/app/CLAUDE.md`.
- WU13a: no generated column-write case → backlog 162.
- WU13b: the member directory's rule and labels → [ADR-0012](../decisions/0012-fabrika-app-runtime.md); the global
  object refusal → `packages/check/CLAUDE.md` (`forbidden-global`).
