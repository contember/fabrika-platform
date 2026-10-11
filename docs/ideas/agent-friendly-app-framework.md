# Agent-friendly application framework: declared operations

A proposal for the next shape of `@fabrika/app`, `@fabrika/db` and `@fabrika/check`. Applications are written mostly
by coding agents and reviewed by people, so the framework must make the common mistakes fail early, make every access
reviewable, and let each fact be written once. Nothing here is built. The falsification spike at the end decides
whether it graduates.

In one sentence: **an endpoint is a named operation declared as data in the contract; CRUD is the obvious set of
operations; a handler is optional and reaches data only through the operations it declares.**

## 1. Problem

**A dogfood CRM, written by an agent on today's framework, writes each fact three or four times.** Six facts repeat:
the actions (contract, roles, a hand union in `tables.ts`, store `Ref` types), the scope hierarchy (dimensions, table
scope, SQL foreign keys), the entity shape (zod, SQL, generated types, a hand row→view mapping), the writable columns
(zod `New`/`Edit` and the table's insert/update lists), the endpoint tree (contract and the `implement` mirror), and
endpoint access against table actions. The agent got every copy right because it wrote them in one session. The
second change ("add a column", about a dozen touch points) is where a copy is missed.

**Four spikes on that CRM measured alternatives** (local branches `spike/{derive,colocated,filebased,entity}`, each with
`examples/crm/SPIKE.md`):

| Spike         | Model                                                                      | Hand-written lines | Verdict                                                              |
| ------------- | -------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------- |
| A `derive`    | derive table actions and scope from the contract; `TableInsert`, `fromRow` | −21 %              | keep the derivations; deriving zod schemas from DB rows loses bounds |
| B `colocated` | `.handle()` beside each procedure; a syntactic slice for Control           | −7 %               | removes only the mirror tree                                         |
| C `filebased` | one file per endpoint, a generated committed contract                      | +42 %              | removes only the mirror tree                                         |
| D `entity`    | `c.entity` expands to CRUD procedures, policies, handlers                  | −27 %              | 60 % of procedures were CRUD; two authoring styles                   |

**All four hit the same wall:** a write capability cannot read its row, and `@fabrika/db` has no conditional update.
"Reopen a deal only from won or lost" cannot be enforced on the server. The check lives in handler code, races, and
is invisible to the approval diff.

**A second paper application (a helpdesk) found the model's edges.** Customers see only their own tickets, comments
are public or internal, a ticket reopens only within 7 days of resolution, a job counts SLA breaches, `merge` closes
one ticket into another, an export exceeds one page. One read action per table blocks the first two without a table
split; the predicate grammars lack relative time and increments; one capability per endpoint blocks `merge` (the same
cause as [backlog 97](../backlog/97-the-generated-tests-have-no-move-case.md)).

**A red-team pass against `main` reproduced four holes** in today's claims. They are filed as backlog
[105](../backlog/105-database-postgres-is-writable-by-application-code.md),
[106](../backlog/106-application-code-can-reach-the-capability-mint.md),
107 (fixed: [ADR-0050](../decisions/0050-approved-access.md) §3 now compares input domains) and
[108](../backlog/108-application-migrations-can-install-triggers-and-functions.md), independent of this proposal.

## 2. Principles

1. **The named operation is the unit; CRUD is its obvious set.** Evidence: Ash actions; spike D's 60 % CRUD share
   with a second style for the rest.
2. **Authority is per operation, for reads and writes.** Evidence: helpdesk visibility rules; the union-of-columns
   class (Directus CVE-2025-27089).
3. **Every write path is in the artifact Control reads.** Evidence: today a `c.mutation`'s write lives in a handler
   nobody reviews.
4. **Preconditions compile into the one guarded statement.** Evidence: all four spikes; Ash 3 atomic updates.
5. **The policy grammar is closed, positive and conjunctive.** Evidence: policy-as-data is diffable; `notIn` admits a
   future enum label without a predicate edit.
6. **Input domains are written; output shapes derive.** Evidence: spike A lost bounds when it derived inputs from rows.
7. **Each fact is written once; a repeated name is a separate grant, not a copy.** Evidence: the six CRM facts.
8. **Generators cross only boundaries types cannot; no invariant depends on one having run.** Evidence: generator
   research (scaffolds drift; regenerate-and-verify detects).
9. **Closed by default.** No default view, no default `accept`, no write escape hatch. Evidence: every incident in the
   survey was a default or a bypass flag (e.g. CVE-2025-48757).
10. **A type error is product surface:** at its own line, at most two lines, naming the fix. Evidence: measured
    mapped-type dumps and `never` collapses (§9).
11. **Approval compares effective authority, conservatively.** Evidence: an input-domain widening classified as
    unchanged until ADR-0050 §3 compared input domains.
12. **State the trust claim honestly, harden cheaply, defer the isolated host.** Evidence: the reproduced static-method
    and mint holes; ADR-0012's deferred data executor.

## 3. The model

The author writes `fabrika.contract.ts` (vocabulary, `tables` with field bindings and views, the endpoint tree, files,
jobs, SPA), `db/migrations/*.sql` (SQL stays the source of truth for columns, keys and foreign keys), `src/app.ts` for
hand procedures only, and business tests. `src/db/tables.ts`, the write stores, `src/db/database.ts` and every
row→view mapping go away.

**A leaf of the endpoint tree is one of two things:**

- A **declared operation**: `c.read`, `c.list`, `c.aggregate`, `c.create`, `c.update`, `c.delete`, and, in jobs only,
  `c.updateMany`. Input, output and access form derive from the operation and the table's field bindings. It has no
  handler: the framework executes it.
- A **hand procedure** (`c.query`, `c.mutation`) for real logic. It reaches data only through the operations it lists
  under `uses`. A job uses `uses` too.

**Operation fields:**

| Field                 | On                                          | Meaning                                                                             |
| --------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `action`              | every operation                             | the action this operation requires; the endpoint's requirement derives from it      |
| `view`                | `read`, `list`                              | the projection: a named view of the table or an inline list of fields               |
| `where`               | `list`, `aggregate`, `updateMany`           | a filter on the rows read                                                           |
| `when`                | `read`, `update`, `delete`, child ops       | a predicate on the row the capability names (for a child operation: the parent row) |
| `accept`              | `create`, `update`                          | the fields the caller supplies                                                      |
| `set`                 | writes                                      | values from the principal, the clock, a constant, `c.inc(n)`, another target's id   |
| `default`             | `create`                                    | principal or constant values used when the caller omits the whole group             |
| `orderBy`, `limit`    | `list`                                      | required `limit`; `page: '<field>'` adds keyset paging                              |
| `groupBy`, `measures` | `aggregate`                                 | `count` and `sum`, answered as decimal strings                                      |
| `target`              | ops under `uses` of a multi-target endpoint | which of the endpoint's targets the operation acts on                               |

**Predicate grammar** (`where`, `when`): a conjunction of terms on fields. A term is equality (`status: 'open'`),
positive membership (`{ in: [...] }`), `{ isNull: boolean }`, an ordered comparison (`lt/lte/gt/gte`) against a literal,
`c.now` or `c.today`, or a relative-time window on a time field (`{ within: '7d' }`, `{ olderThan: '30d' }`, measured
against the database clock). Operands are literals, `c.principal.id`, `c.principal.label`, `c.now` and `c.today`. There
is no `notIn`, no OR, no join and no input operand in v1.

**Wire names are explicit.** `tables.<t>.fields` binds each wire name to a column, once: `companyId: 'company_id'` for
a field the caller never supplies, `title: { column: 'title', input: Name }` for one it may. `accept`, `view`, `where`,
`when` and `set` use wire names only, so one file never mixes column and wire names. The field bound to the `in` (or
child) column names the parent in a create's or child list's input. `expectVersion` is a fixed protocol field.

**Domains.** An output field's schema derives from its column type (`date` → ISO date, `timestamptz` → ISO datetime,
`int8`/`numeric` → decimal string). An accepted `text`, `varchar` or numeric field without an `input` schema is
refused, and an `input` wider than its column (`max` above `varchar(n)`, an integer outside `int4`) is refused. An enum
field always names its API enum, which must be a subset of the database labels and is its domain both ways: a label a
migration adds reaches the API only when the contract's enum gains it. `uuid`, `bool`, `date` and `timestamptz` need
no schema.

**Responses.** A write answers `{ id, version }`, never row data. When a guarded write changes no row, one probe in the
same transaction answers 404 (out of scope, or a failed `when` term on a principal operand), 409 `stale` (version), or
409 `precondition` naming the rule (`api.deals.reopen requires stage in (won, lost)`). A read whose `when` fails
answers 404.

**Handlers and `uses`.** `ctx.ops.<name>(input)` is created per invocation, bound to that invocation's endpoint, its
operation and its target; the handler passes no capability. In a job, `ctx.ops.<name>(ref, input)` takes a `Ref` the
attempt minted and refuses one from another attempt. All writes of one handler invocation share one transaction; a
thrown error or an output the schema refuses rolls them back. A `ctx.connect` call is not part of that transaction.
Read-only stores remain only for reads the grammar cannot express, and the approval shows them as broad read authority
(the declared report kinds of [backlog 104](../backlog/104-the-query-builder-cannot-express-common-reports.md) are
their long-term replacement).

**Multi-target access.** An access form may name several targets with one action:
`targets: { source: { on: 'ticket', from: 'id' }, into: { on: 'ticket', from: 'intoId' } }`. The dispatcher locates and
mints one `Ref` per target and refuses two targets that resolve to the same row. The proxy's requirement is unchanged
(one action), so ADR-0022's single evaluator is untouched. Backlog 97's `move` needs the same mechanism with one
action per target.

**One expansion.** `expandContract` in `@fabrika/app/contract` turns the declarations into ordinary endpoint rows plus a
new artifact section, `operations`, keyed by endpoint id (or `jobs.<job>.<use>`). `boot` calls it; the static reader
reads the builders as data and calls the same function through `buildArtifact`. The reader learns syntax, not
semantics. The proxy table format does not change.

## 4. The CRM, concretely

The migration SQL is today's, unchanged. `fabrika db codegen` adds a literal catalogue to
`src/db/schema.generated.ts`: per table the key, each column's type tag (`uuid text varchar(n) int2 int4 int8 numeric
float8 bool date timestamptz enum`), nullability, whether it has a default, enum labels, unique keys and foreign keys
with their `ON UPDATE`. `DB` derives from it, so the Kysely types and the catalogue cannot disagree. The contract imports
it as `schema`; the slice below omits companies, attachments, the SPA and health, which keep their current form.

```ts
// fabrika.contract.ts, vocabulary and tables (an excerpt: defineContract's first argument)
const Name = z.string().min(1).max(200)
const Amount = z.int32().min(0)
const Stage = z.enum(['lead', 'qualified', 'proposal', 'won', 'lost'])
const Kind = z.enum(['note', 'call', 'email', 'meeting'])
const Body = z.string().min(1).max(5000)
const PrincipalId = z.string().min(1).max(200)

app: 'crm',
schema,
dimensions: { org: {}, company: { in: 'org' }, deal: { in: 'company' }, task: { in: 'deal' } },
actions: {
	'crm.read': 'Read deals, tasks and activities',
	'crm.delete': 'Delete deals and tasks',
	'deals.write': 'Create, edit, move and reopen deals',
	'tasks.write': 'Create tasks and mark them overdue',
	'activities.write': 'Log activities',
},
roles: {
	sales: { grants: ['crm.read', 'deals.write', 'tasks.write', 'activities.write'] },
	viewer: { grants: ['crm.read'] },
},
tables: {
	deals: {
		dimension: 'deal', in: 'company_id', version: 'version', createdBy: 'created_by',
		fields: {
			id: 'id', companyId: 'company_id', version: 'version',
			title: { column: 'title', input: Name },
			value: { column: 'value', input: Amount },
			stage: { column: 'stage', input: Stage },
		},
		views: { detail: ['id', 'companyId', 'title', 'value', 'stage', 'version'] },
	},
	tasks: {
		dimension: 'task', in: 'deal_id', version: 'version', createdBy: 'created_by',
		fields: {
			dealId: 'deal_id', dueOn: 'due_on', done: 'done', overdue: 'overdue',
			title: { column: 'title', input: Name },
			assignee: { column: 'assignee', input: PrincipalId },
			assigneeLabel: { column: 'assignee_label', input: Name },
		},
	},
	deal_activities: {
		child: 'deals', column: 'deal_id', createdBy: 'created_by',
		fields: {
			id: 'id', dealId: 'deal_id', author: 'author_label', createdAt: 'created_at',
			kind: { column: 'kind', input: Kind },
			body: { column: 'body', input: Body },
		},
		views: { feed: ['id', 'kind', 'body', 'author', 'createdAt'] },
	},
},
```

```ts
// fabrika.contract.ts, the surface (an excerpt: inside c.rpc('/api', { callers: ['human'] }, { … }) and jobs)
deals: {
	list: c.list('deals', { action: 'crm.read', over: 'company', view: 'detail', orderBy: ['title', 'id'], limit: 1000 }),
	get: c.read('deals', { action: 'crm.read', view: 'detail' }),
	pipeline: c.aggregate('deals', {
		action: 'crm.read', over: 'company', groupBy: ['stage'], measures: { count: { count: true }, value: { sum: 'value' } },
	}),
	create: c.create('deals', { action: 'deals.write', accept: ['title', 'value', 'stage'] }),
	edit: c.update('deals', { action: 'deals.write', accept: ['title', 'value'] }),
	move: c.update('deals', {
		action: 'deals.write', accept: ['stage'], when: { stage: { in: ['lead', 'qualified', 'proposal'] } },
	}),
	reopen: c.update('deals', { action: 'deals.write', set: { stage: 'qualified' }, when: { stage: { in: ['won', 'lost'] } } }),
	remove: c.delete('deals', { action: 'crm.delete' }),
},
tasks: {
	create: c.create('tasks', {
		action: 'tasks.write',
		accept: ['title', 'dueOn', 'assignee', 'assigneeLabel'],
		default: { assignee: c.principal.id, assigneeLabel: c.principal.label },
		set: { done: false, overdue: false },
	}),
},
activities: {
	ofDeal: c.list('deal_activities', { action: 'crm.read', on: 'deal', view: 'feed', orderBy: ['createdAt', 'id'], limit: 200 }),
	logDeal: c.create('deal_activities', {
		action: 'activities.write', accept: ['kind', 'body'], set: { author: c.principal.label, createdAt: c.now },
	}),
},
// jobs
overdue: c.cron('15 * * * *', {
	scope: 'app', timeout: '5m', retries: 2,
	run: c.updateMany('tasks', {
		action: 'tasks.write', set: { overdue: true }, where: { done: false, overdue: false, dueOn: { lt: c.today } }, batch: 500,
	}),
}),
```

- **`deals`**: eight leaves, no handler, store or mapping. `move` refuses a terminal deal and `edit` cannot write
  `stage`, so `reopen` is the only way out of won/lost. A rule that spans operations holds only when every writer of
  the field is restricted; the generated tests probe each writer (§6).
- **`tasks.create`**: the input is `{ dealId, title, dueOn, assignee?, assigneeLabel? }`. A `default` group is
  all-or-nothing, so the assignee and its label cannot come from two people. The assignee is not verified as an org
  member, as today.
- **`activities.logDeal`** is a child create; its access derives as `{ action: 'activities.write', on: 'deal', from:
  'dealId' }`. Author and timestamp are server values. Attachments keep `c.files`, already a declared resource.
- **`overdue`** has no handler. Each batch selects at most 500 candidates, re-checks scope and `where` in the update,
  bumps each version and is fenced by the job's lease; it repeats until no row changes or the deadline passes. A retry
  is a no-op for marked rows. The job's IAM actions derive from its operations.
- **`src/app.ts`** is `export default implement(contract, { handlers: () => ({}) })`.

`reopen` compiles to one statement. The caller's conditions stay in the left parenthesis and the scope predicate stays
the top-level right conjunct, the shape the guard requires today. Its artifact entry is
`{ "op": "update", "table": "deals", "action": "deals.write", "target": { "form": "on", "dimension": "deal" },
"accept": {}, "set": { "stage": { "literal": "qualified" } }, "when": { "stage": { "in": ["lost", "won"] } },
"expectVersion": true }`.

```sql
UPDATE deals SET stage = 'qualified', version = version + 1
WHERE (stage IN ('won', 'lost') AND version = $3)
  AND (id = $1 AND company_id = $2 AND org_id = $4)
RETURNING id, version
```

## 5. The helpdesk's hard cases

Vocabulary: `workspace → ticket`; actions `tickets.work` (agents: every ticket and comment of the workspace),
`tickets.own` (customers: open tickets, and read, comment on and reopen their own) and `tickets.export`. Field
bindings are omitted; `status` is bound to the API enum `open | pending | resolved | closed`.

```ts
tickets: {
	mine: c.list('tickets', {
		action: 'tickets.own', over: 'workspace', where: { requester: c.principal.id },
		view: 'customer', orderBy: ['id'], limit: 200,
	}),
	getMine: c.read('tickets', { action: 'tickets.own', when: { requester: c.principal.id }, view: 'customer' }),
	open: c.create('tickets', {
		action: 'tickets.own', accept: ['subject'], set: { requester: c.principal.id, status: 'open', slaBreaches: 0 },
	}),
	resolve: c.update('tickets', {
		action: 'tickets.work', set: { status: 'resolved', resolvedAt: c.now }, when: { status: { in: ['open', 'pending'] } },
	}),
	reopen: c.update('tickets', {
		action: 'tickets.own', set: { status: 'open', resolvedAt: null },
		when: { requester: c.principal.id, status: 'resolved', resolvedAt: { within: '7d' } },
	}),
	export: c.list('tickets', {
		action: 'tickets.export', over: 'workspace', view: 'agent', orderBy: ['id'], limit: 1000, page: 'id',
	}),
	merge: c.mutation({
		input: z.strictObject({ id: z.uuid(), intoId: z.uuid(), expectVersion: z.int().positive() }),
		output: z.strictObject({ id: z.uuid() }),
		access: { action: 'tickets.work', targets: { source: { on: 'ticket', from: 'id' }, into: { on: 'ticket', from: 'intoId' } } },
		uses: {
			close: c.update('tickets', {
				target: 'source', set: { status: 'closed', mergedInto: c.target('into') },
				when: { status: { in: ['open', 'pending', 'resolved'] } },
			}),
			note: c.create('ticket_comments', {
				target: 'into', accept: ['body'], set: { internal: true, author: c.principal.label, createdAt: c.now },
			}),
		},
	}),
},
comments: {
	visible: c.list('ticket_comments', {
		action: 'tickets.own', on: 'ticket', when: { requester: c.principal.id }, where: { internal: false },
		view: 'public', orderBy: ['createdAt', 'id'], limit: 500,
	}),
	reply: c.create('ticket_comments', {
		action: 'tickets.work', accept: ['body', 'internal'], set: { author: c.principal.label, createdAt: c.now },
	}),
},
// jobs
sla: c.cron('*/10 * * * *', {
	scope: 'app', timeout: '5m', retries: 2,
	run: c.updateMany('tickets', {
		action: 'tickets.work', set: { slaBreaches: c.inc(1), slaCountedAt: c.now },
		where: { status: { in: ['open', 'pending'] }, slaDueAt: { lt: c.now }, slaCountedAt: { isNull: true } },
		batch: 500,
	}),
}),

// src/app.ts: the one handler
merge: async ({ input, ctx }) => {
	await ctx.ops.close({ expectVersion: input.expectVersion })
	await ctx.ops.note({ body: `Ticket ${input.id} was merged into this one.` })
	return { id: input.intoId }
},
```

Not shown, same forms: `list`, `get` and `comments.thread` with `tickets.work`; `pend`, `resume` and `close` like
`resolve`; `assign` accepts `assignee` and `slaDueAt` and sets `slaCountedAt: null`; `comments.ask` is `visible`'s write
side (`set: { internal: false }`, the same `when`).

| Case                           | Form                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| status workflow                | one `c.update` per transition with `set` and a positive `when`; `resolve` stamps `resolvedAt`        |
| reopen within 7 days           | `resolvedAt: { within: '7d' }` plus `requester = principal`, in the one guarded UPDATE               |
| customer sees only own tickets | per-operation action `tickets.own` with `where`/`when` on `requester`                                |
| internal comments              | one table; `visible` filters `internal: false`; only `reply` accepts `internal`                      |
| SLA counter                    | `updateMany` with `c.inc(1)`; `slaCountedAt` counts one breach once; `assign` sets the next deadline |
| merge (two rows)               | multi-target access, two `uses`, one transaction; `mergedInto` comes from the `into` capability      |
| export beyond one page         | `page: 'id'` adds `after` to the input and `next` to the output; the SPA pages and builds the CSV    |

Count: 17 of 18 entries are declared operations, `merge` is the one handler, nothing is blocked.

## 6. What is generated, and who owns it

| File                                                     | Owner                                                      | Drift check                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| `src/db/schema.generated.ts` (types + literal catalogue) | `fabrika db codegen` locally; a Control codegen job on MCP | `codegen --verify` at platform start; a stale file fails start |
| policy-isolation and endpoint-access tests               | `fabrika db test-scaffold`                                 | checker `isolation` rule regenerates and compares (existing)   |
| `src/__tests__/operations.test.ts` (new)                 | `fabrika db test-scaffold`                                 | the same rule                                                  |
| `fabrika/entry.generated.ts`                             | `fabrika app build` (existing)                             | existing                                                       |
| a migration plus declarations from `fabrika gen table`   | the author, after one run                                  | ADR-0017 identity; checker `scope-matches-schema`              |

- **The catalogue on the MCP path.** An MCP workspace cannot run `db codegen`. Instead of predicting its output, a
  Control job applies the workspace's migrations to a disposable database, runs codegen and commits the real file. A
  missing result is a pending verification, never a hand-written catalogue.
- **`operations.test.ts`**: for each `when` term a failing and a passing row; each `set`/`default` read back; each
  principal operand refused for a second principal; each field written by several operations probed through every
  writer. It proves the declaration, not the intent.
- **`fabrika gen table <t> --dimension <d> [--crud]`** is optional and one-shot: it writes the migration with the full
  scope chain (`UNIQUE (id, <chain>)`, the composite FK with `ON UPDATE CASCADE`, `int4 version`, `created_by`) and
  prints the `tables` entry and CRUD leaves (JSON for MCP) for the author to place. It edits no TypeScript file,
  writes no role grant, and refuses when the table exists.
- **No TypeScript codemods in v1.** A column added by hand is five lines in two files, and tsc names a missed place.

## 7. Duplication: each fact written once?

| Fact                            | Written once, where                                                 | How the other places get it                                                            |
| ------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| actions                         | `actions`; grants in `roles` (a different fact)                     | each operation names its action; no table action map, hand union or store `Ref` types  |
| scope hierarchy                 | `dimensions`, plus `dimension`/`in` (or `child`) per table          | the chain from `dimensions` and the catalogue's FKs; `scope-matches-schema` checks SQL |
| entity shape                    | SQL columns; one field binding per wire field, with its input bound | output schemas from column types; `DB` from the catalogue; projection replaces mapping |
| writable columns                | `accept` per operation                                              | input schemas from `accept` plus the field bindings; no table write lists              |
| endpoint tree                   | the contract                                                        | handlers exist only for hand procedures; `ExactHandlers` types that remainder          |
| endpoint access vs table action | the operation                                                       | the endpoint requirement and the data-layer operation derive from one declaration      |

Deliberate repetition remains: `accept: ['title', 'value']` in `create` and `edit` is two grants, and the FK in SQL and
`in` in the contract are a persisted copy with a check. No measured line count is claimed; the spike measures it.

## 8. Security

### 8.1 Trust model, stated explicitly

**v1 keeps today's claim.** Application code and its dependencies are trusted and run in the same process as the data
layer. The framework prevents agent _mistakes_ and makes every access reviewable: the approved contract describes each
endpoint's and job's declared authority (fields, presets, predicates, version rule); the data layer enforces it on
every declared operation in one guarded statement; the checker and generated tests catch common mistakes; a human
approves every widening on a protected environment (ADR-0050). Approval does not prove that handler code has only the
effects its declarations describe. A deliberately hostile author is out of scope, as in ADR-0012 and
`packages/db/CLAUDE.md`. In scope is **cheap hardening** of the reproduced holes (backlog 105–108).

**The isolated handler compartment is a later, separate option**: a platform-owned host holding the credentials,
executing approved operations and running handlers with no ambient database, network or environment. It is considered
only after a feasibility spike on the Zerops substrate, and only if the owner wants the stronger claim. It is not part
of v1.

### 8.2 Extraction

Control reads today's inputs plus `src/db/schema.generated.ts`, a literal module the contract imports; a repository
with both `src/db/tables.ts` and `tables` is refused. The reader learns the builders, `uses`, `targets`, the tokens
(`c.principal.*`, `c.now`, `c.today`, `c.inc`, `c.target`) and `z.int32()`, each into a declaration with
`unknownOptions`, and refuses any other form with the allowed one. Expansion is `expandContract`, shared with `boot`;
`differential.test.ts` requires the static read to equal `compileContract` byte for byte. `boot` refuses a compiled
digest other than `FABRIKA_CONTRACT_DIGEST`, which now covers `operations`.

### 8.3 Approval classification compares effective authority

`classifyAccess` gains one keyed comparison over `operations` and compares input shapes everywhere, as it already
does for procedures. What cannot be shown to narrow, widens. Compared per operation: kind, table, action,
target form, accepted fields and their effective input domains, `set` and `default` values, every `when` and `where`
term, projections and read dependencies (`orderBy`, `groupBy`, measures), `limit` and `page`, the version rule, job
batch bounds, and `uses`. A removed operation narrows; a removed constraint widens. No logical implication is attempted.

**(a) A column added to `edit`** (with its field binding and view entry):

```
widening  Endpoint `api.deals.edit` accepts `source`: nullable string, at most 500 characters, writes `deals.source`
widening  Endpoint `api.deals.get` output gains field `source`
widening  Endpoint `api.deals.list` output `items[]` gains field `source`
widening  New migration `20261010120000_deals_source.sql`
```

**(b) A predicate loosened** (`reopen`'s `in` gains `proposal`, or `within: '7d'` becomes `'30d'`):

```
widening  Endpoint `api.deals.reopen` precondition on `stage` admits `proposal` (was: lost, won)
widening  Endpoint `api.tickets.reopen` window on `resolvedAt` grows from 7d to 30d
```

**(c) An endpoint added:**

```
widening  New endpoint `api.deals.reopen` (POST /api/deals.reopen) for human callers with `deals.write` (on `deal`)
widening  Endpoint `api.deals.reopen` updates `deals`: sets `stage` = `qualified` when `stage` in (lost, won);
          a caller learns whether that holds
```

The approver reads what is written and when, not a schema diff. `shapeChanges` descends into arrays and nullable
objects so lines name the nested field.

### 8.4 Closed by default

- Every table of the catalogue needs a `tables` entry, or the reader refuses it.
- A write names its `action`; there is no default `accept`; a `create`/`update` with neither `accept` nor `set` is
  refused. `view` is explicit; a migration never exposes a column.
- The key, every chain column, `version` and `createdBy` are never accepted, set or defaulted.
- No public caller, no anonymous operation, no store write API, no raw SQL, no driver: the checker refuses each, as
  today. `updateMany` exists only in jobs.

### 8.5 What an agent can get wrong, and what catches it

| Mistake                                              | Caught by                                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| a sensitive field in a view                          | approval output line; a column with its own read action refused in another view                    |
| an owner id taken from input                         | `client-identity` rule names `set: { requester: c.principal.id }`; approval says "from the caller" |
| a precondition loosened to pass a failing test       | widening line, human gate; the skill says to ask instead                                           |
| a guarded field written by a sibling without a guard | `operations.test.ts` probes every writer; the approval lists each writer                           |
| a wrong business rule                                | human review and the author's tests only                                                           |

## 9. Type safety

Errors are product surface. Measured in the critique round with TypeScript 5.9.3 on a minimal kit: message types on
array elements and enum values land on the element in one line (`'"titel" is not a field of tickets'`, `Did you mean
'"resolved"'?`), but an excess key in a mapped object type (`set: { version: 3 }`) printed a ~350-character schema dump,
and an `Exact` intersection reduced the parameter to `never`. The fix is key remapping to a message type, or a named
interface per table emitted by codegen. Every row below becomes a fixture in `src/__tests__/contract-mistakes/` and
must fail at its own line, in at most two lines, naming the fix, with no `never` and no type dump:

| #  | Mistake                                                           | Fails at                                                               |
| -- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1  | `accept: ['titel']`                                               | tsc: `titel is not a field of deals (title, value, stage)`             |
| 2  | `accept: ['companyId']` / `set: { version: 3 }`                   | tsc: `companyId is stamped from the capability: remove it`             |
| 3  | `when: { stage: { in: ['wonn'] } }`, `set: { stage: 'archived' }` | tsc: the API enum is the expected type                                 |
| 4  | `when: { resolvedAt: { gt: 7 } }` / `within` on a text field      | tsc: `expected an ISO datetime, c.now or a window`                     |
| 5  | `{ notIn: [...] }`                                                | tsc: `positive membership only: list the admitted values with in`      |
| 6  | an accepted text field without `input`                            | tsc: `deals.source is text: give its field an input schema`            |
| 7  | `input` wider than its column (`max(500)` on `varchar(200)`)      | checker + boot (`input-within-column`); zod types carry no bounds      |
| 8  | a NOT NULL column without default left uncovered by a create      | tsc: `tasks.done is NOT NULL: accept it, set it or default it`         |
| 9  | a handler for a declared operation                                | tsc: `api.deals.reopen is a declared operation and has no handler`     |
| 10 | a hand procedure without a handler                                | tsc (existing `ExactHandlers`)                                         |
| 11 | `ctx.ops.x` not under `uses`, or a wrong input field              | tsc at the call; the runtime refuses an op of another invocation       |
| 12 | an unknown field in `view`, `orderBy`, `groupBy`                  | tsc; the reader as well                                                |
| 13 | `c.updateMany` in an RPC mount; `c.list` without `limit`          | tsc                                                                    |
| 14 | an action typo anywhere                                           | tsc (existing)                                                         |
| 15 | a stale `schema.generated.ts`                                     | platform start (`codegen --verify`); tsc passes against the stale file |
| —  | the wrong action, the wrong precondition, a view too wide         | never by a tool: human approval                                        |

**Type cost budget.** The same minimal kit measured 56,620 instantiations for 200 operations over 20 tables, against
today's `contract-scale` 151,651 for 200 procedures. `contract-scale.test.ts` grows to 200 declared plus 50 hand
procedures with real zod output types and must stay within 2× today's figure (303,302). The per-leaf checks map over
one table's fields, never over the whole tree; `HandlersOf` filters declared leaves out.

## 10. Agent workflow

**Add column `deals.source`** (nullable text, at most 500 characters, accepted by create and edit, shown in reads):

1. `fabrika db new deals_source`, then write `ALTER TABLE deals ADD COLUMN source TEXT;`.
2. `fabrika db migrate && fabrika db codegen` locally; on MCP, commit and let Control's codegen job commit the catalogue.
3. In the contract: `source: { column: 'source', input: OptionalText }` in `fields`, `'source'` in `views.detail`, and
   `'source'` in `accept` of `create` and `edit`.
4. `fabrika db test-scaffold`, then `bun run typecheck && bunx fabrika-check .`.

By hand: 2 files, 5 lines. By tools: 1 file (the catalogue). Today: 5–7 files. A missed `fields` entry is a tsc error
at the `accept` element; a missed `input` is mistake 6; a missed `accept` is a business decision no tool can infer.

**Add endpoint `deals.reopen`:**

1. One leaf in the contract (§4.2).
2. `fabrika db test-scaffold`: access cases (sales 200, viewer 403, other org 404, stale 409) and precondition cases (a
   won deal succeeds and reads back `qualified`; a lead deal answers 409 naming the rule; `move` and `edit` cannot
   leave won/lost).
3. `bun run typecheck && bunx fabrika-check .`.

By hand: 1 file, 1 line. By tools: 2 generated test files. There is no `gen endpoint`: the leaf is shorter than its
command line.

## 11. What we rejected, and why

| Rejected                                           | Why                                                                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| B: colocated `.handle()` with a syntactic slice    | with declared operations the mirror tree is a few entries; the slice adds a reader mode and a bundler plugin                              |
| C: file-based routing, generated contract          | +42 % hand lines, URLs move with files (ADR-0012 already rejects it), a generated security artifact to keep in sync                       |
| D: entity sugar as a second style                  | two styles and overloaded field flags; here CRUD and transitions are the same construct                                                   |
| deriving zod input schemas from DB rows            | bounds are lost silently and a migration becomes an API change (spike A); only outputs derive                                             |
| TypeScript codemods (`gen column`, `gen endpoint`) | they edit code tsc already checks, double the maintenance surface, decay on mature code; checks carry the invariants                      |
| the trusted host for v1                            | a new execution service, several engineer-months, Cloudflare data apps refused; nothing in the CRM or helpdesk needs it to be expressible |
| a generated contract (`fabrika app generate`)      | four tool-owned files regenerated after every edit; it exists only to serve the host                                                      |
| a JSON expression language for presets             | unfamiliar to agents, costly to type; `default` groups and a handler cover the cases                                                      |
| one read action per table                          | blocks own-rows visibility and internal comments without table splits                                                                     |
| a resource-wide `ctx.write.<table>.<op>`           | lets any handler reach any write; `uses` names the writer in every approval line                                                          |
| store writes as an escape hatch                    | the second, unreviewed write path                                                                                                         |
| `when` evaluated by the proxy                      | the proxy has no rows and stays the only gate evaluator; `when` is a data-layer invariant                                                 |
| silent filtering on a failed `when`                | an agent cannot tell a policy from a bug; a 409 names the rule                                                                            |

## 12. Platform changes and rough size

| Package                  | Change                                                                                                                                                                  | Size (src + tests) |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `@fabrika/db`            | codegen emits the literal catalogue (keys, FKs, unique, defaults, enums) and `RowsOf`                                                                                   | ~250               |
| `@fabrika/db`            | the operation executor: `accept/set/default/when/where`, `inc`, the `now`/`today` tokens in the guard, the probe, projection, keyset paging, aggregates, `updateMany`   | ~1,100             |
| `@fabrika/db`            | `scoped(contract)`: table models from `tables` plus the catalogue; read-only stores                                                                                     | ~300               |
| `@fabrika/app/contract`  | kit builders, tokens, message types; `expandContract`; the `operations` artifact; version bump                                                                          | ~1,300             |
| `@fabrika/app/implement` | serve declared leaves; invocation-bound `ctx.ops`; one transaction per invocation; multi-target dispatch                                                                | ~450               |
| `@fabrika/auth-core`     | operation artifact types; the multi-target access form                                                                                                                  | ~200               |
| `@fabrika/check`         | reader builders and tokens; rules `scope-matches-schema`, `input-within-column`, `two-policy-sources`, `legacy-store-write`; `operations.test.ts` scaffold; `gen table` | ~1,300             |
| `@fabrika/control`       | `classifyAccess` over operations and inputs; nested shape lines; the MCP codegen job                                                                                    | ~700               |
| proxy, IAM               | none                                                                                                                                                                    | 0                  |
| docs                     | ADR-0012 (literal subset, operations, trust claim), ADR-0050 §3, `packages/app/skill/SKILL.md`                                                                          | —                  |

About 5,600 lines with tests: 5–7 weeks for one person, or 3 with parallel units. Seams to land first: the artifact
types, `expandContract`'s signature, the executor's statement shape.

## 13. Migration path for existing contract apps

1. **Cheap hardening** (backlog 105–108). Independent of everything else.
2. **The `when` executor** in `@fabrika/db`, also as `t.update(ref, values, { expectVersion, when })` for today's
   stores. It fixes the CRM's reopen correctness at once; review coverage arrives with step 4.
3. **The falsification spike** (§14).
4. **Declared operations, the reader and the classifier**, with a dual reader for one minor version: an application has
   `src/db/tables.ts` or `tables` in the contract, never both. Today's procedures keep working; the checker reports
   `legacy-store-write` with the declared form as the fix.
5. **Grammar additions** with their classification rules: `inc`, relative time, `updateMany`, multi-target access.
6. **Tools**: `test-scaffold` for operations, Control's codegen job, `gen table`.
7. **Convert by hand**, with a parity check over the old and new artifacts and every old endpoint. In
   `examples/zerops-app`, `notes.list/get/create/remove` become leaves, `trash` becomes `c.update` with
   `set: { trashed: true }`, `purge` keeps a short handler; `tables.ts`, the store and `database.ts` go. The CRM
   follows; its deliberate changes (guarded `move`, `{ id, version }` acknowledgements, decimal-string aggregates, flat
   task assignee) are listed apart from the mechanical conversion.
8. **Approval**: the first deploy after conversion is one widening approval per app on a protected environment, because
   coarse table write lists cannot be mapped onto per-operation authority without guessing. Then the legacy format is
   deprecated with a stated window.

## 14. Falsification spike (5 days)

One branch, a disposable database, no generators. It merges the two critiques' spikes: the helpdesk on types and
expansion, and the real conditional-UPDATE executor with two same-action endpoints.

- **Days 1–2, types and expansion:** the kit types for every operation kind, field bindings, the predicate and preset
  grammar, `page` and multi-target access; `expandContract`; the reader builders. Write the helpdesk and CRM `deals`.
- **Day 3, errors and cost:** the 15 fixtures of §9; the scale fixture at 200 declared plus 50 hand procedures with
  real zod output types, under `cpu-lease`.
- **Day 4, the executor on PostgreSQL:** `deals.edit` and `deals.reopen`, both `deals.write`. Through supported APIs,
  try: `reopen`'s op from `edit`'s handler (and a cached closure from an earlier invocation), `edit`'s capability for
  `reopen`, scope, version or preset fields injected through input, a stale version, two concurrent reopens,
  reparenting between check and write, and a `merge` whose second write conflicts or whose output fails validation.
  Inspect stored rows and versions. Tests fail when the database is absent.
- **Day 5, approval and an agent:** input enum growth, a removed `when`, a wider window, a fixed preset turned into an
  accepted field, a changed measure with an equal output shape and a lost version rule must each classify as widening;
  the static read must equal the evaluated compile. A fresh agent with only the skill text then writes the helpdesk;
  record every tsc and checker iteration.

**Pass (all must hold):**

- at least 15 of the 18 helpdesk entries are declared operations; `merge` works with multi-target access and one
  handler; no entry is blocked;
- 15 of 15 fixtures fail at the offending line, in at most two lines, naming the fix, with no `never` and no expanded
  mapped type;
- at most 303,302 instantiations for 200 + 50;
- no supported API substitutes an operation or target, skips a predicate, overrides a preset or commits a failed
  composed write;
- every tested widening classifies as a widening; the static read equals the evaluated compile;
- the fresh agent reaches a clean tsc and checker in at most 3 iterations per endpoint group and never edits a
  generated file or adds a hand write to work around a leaf.

**Fail, and what it points to:** illegible excess-key or uncovered-column errors point to an explicit store style with
a corrected `Exact`; more than 3 helpdesk entries needing handlers point to keeping today's handlers with the `when`
primitive and spike A's `TableInsert`/`TableUpdate`; an expansion the reader must re-implement, a cross-operation
write, or a widening classified otherwise stops the design until the owning module is fixed.

## 15. Open risks

- **Expressiveness ceiling.** A cross-table invariant, a value read from another row, an OR precondition and an input
  operand need a handler. If more than about a third of a real app's writes land there, the model degrades into "CRUD
  plus actions" and the second style returns.
- **Message quality** is the least proven part (§9); type cost is not.
- **Precondition disclosure.** A conditional write reveals whether its predicate holds, one bit per call; the approval
  line states it, and a column with its own read action is refused in `when`.
- **Catalogue trust.** Control trusts `schema.generated.ts` as it trusts the column list today; `codegen --verify` at
  start confirms it, and backlog 108 keeps executable schema objects out of what the catalogue cannot see.
- **Read-only stores** keep broad read authority until declared report kinds exist.

## Sources

- Ash Framework: [update actions](https://ash.hexdocs.pm/update-actions.html) and
  [policies](https://ash.hexdocs.pm/policies.html) — actions as the unit, atomic preconditions, policy breakdowns.
- [ZenStack post-update policies](https://zenstack.dev/docs/orm/access-control/post-update) — old/new-row checks and
  their default-allow pitfall.
- [CVE-2025-48757](https://nvd.nist.gov/vuln/detail/CVE-2025-48757) — AI-generated apps exposed by a default (RLS off).
- [CVE-2025-27089](https://nvd.nist.gov/vuln/detail/CVE-2025-27089) — a union of fields across overlapping policies.
- [ADR-0012](../decisions/0012-fabrika-app-runtime.md), [ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md),
  [ADR-0050](../decisions/0050-approved-access.md), [`packages/db/CLAUDE.md`](../../packages/db/CLAUDE.md).
