# Design draft: reading the application's own tables without listing actions

**TLDR.**

- An endpoint reads an application table only when its action is listed in that table's read list. So every table
  restates which endpoints' handlers read it: a matrix of actions × tables. On the large consumer that is 8,647 action
  names in read lists across 422 application tables.
- Proposal: an application table may declare `actions: { read: 'any' }`. Every credentialed site of the application
  then reads it. Sensitive columns keep their own read action, and writes keep their action lists.
- It is explicit per table, not a default, so nothing becomes readable by omission. It touches only the policy parse,
  the data layer and the approval diff; the proxy and IAM do not change.
- Cost: about 4–6 h of agent time plus one review round.

## Problem

An application table (`scope: { app: '<why>' }`) belongs to no dimension. A site reaches it through `ctx.db.app`,
and only for an operation whose action list names the site's action (ADR-0012 §7; `checkAppReach` in
`@fabrika/db`'s `store.ts`). An `app` endpoint whose handler reads five tables therefore needs its action in five read
lists. A new endpoint with a new action edits every table its handler touches. The handler's code already says which
tables those are.

Measured on a large consumer application's generated `src/db/tables.ts`, 2026-11-20:

| Fact                                         | Value                                                          |
| -------------------------------------------- | -------------------------------------------------------------- |
| Tables                                       | 427: 422 application tables, 5 reference tables                |
| Lines of `tables.ts`                         | 20,983                                                         |
| Action names in read lists                   | 8,647                                                          |
| Action names in insert, update, delete lists | 1,796                                                          |
| Read list length                             | median 15, 75th percentile 24, max 297 (every action)          |
| Distinct read lists                          | 262                                                            |
| Tables with a `when` condition               | 34                                                             |
| Columns with their own read action           | 3                                                              |
| Source the file is generated from            | 9,298 lines of policy modules, by the consumer's own generator |

The analysis counted 10,044 of the 20,983 lines as action names; the measurement above counts names, not lines. The
consumer also keeps about 1,100 lines of its own model checks for these lists (reported, not re-measured). Its
generator has an `'@all'` shorthand of its own that cannot be combined with other actions, so it expands it into lists.

Why it hurts: 1,119 of the consumer's 1,121 endpoints are `app: true`. Every one of them reaches data only through
these lists, so the matrix grows with endpoints × tables read.

## Design

### The declaration

```ts src/db/tables.ts
export const tables = defineTables(vocabulary, columns)({
	cash_desks: {
		scope: { app: 'cash desks of every site' },
		actions: {
			read: 'any',
			insert: 'cash.manage',
			update: ['cash.manage', 'cash.close'],
		},
		insert: ['site_id', 'name'],
		update: ['name', 'closed_at'],
		columns: { float_limit: { read: 'cash.manage' } },
	},
})
```

### Who reads an `'any'` table

Every **credentialed** site of the application:

- an RPC procedure of a `human` or `machine` caller, in any access form: `app` (and `anyOf`, see
  [multi-action-endpoint.md](./multi-action-endpoint.md)), and the read-only `ctx.db.app` of an `on`, `in` or `over`
  endpoint;
- a job and a webhook, under any of their declared actions.

Not:

- **a public procedure**: its reach stays its declared workload `actions`, read by the approver as "anyone who calls
  it" (ADR-0063);
- **a link procedure**: its holder is anonymous and bound to one object;
- **an export procedure**: its caller is another application.

The rest of the policy is unchanged:

- **Columns.** A column with its own read action (`columns: { x: { read } }`) is read only with that action, on an
  `'any'` table too. A sensitive column stays explicit.
- **Writes** keep their action lists. A single write action per column (a limit the consumer reports) is a separate,
  small change: a column's `write` may name a list. It is optional here.
- **`when`.** A condition keyed by an action narrows that action's operations. On an `'any'` table reads are no longer
  per action, so a `when` there narrows only that action's writes. The consumer reports that a `when` narrowing its
  reads is an obstacle, so this matches what it needs.
- **Only application tables.** A dimension or child table keeps its read action: its rows are scoped, and `'any'`
  would turn scoped data into application-wide data. A reference table is already read by every site.

### Explicit, not a default

The analysis proposed that an application table be readable by every action **by default**. That saves one more line
per table (422 lines on the consumer), but a forgotten sensitive table becomes readable without anyone writing it.
ADR-0012 §1 says "Nothing is open by omission", and the approval would show nothing to read. So `'any'` is written out,
and a table without `actions.read` stays refused, as today.

### What the approval shows

- A new application table with `read: 'any'`: "readable by every signed-in member's endpoint, jobs and webhooks".
- A read list becoming `'any'` widens ("now readable by every endpoint"). `'any'` becoming a list narrows.
- Neither needs closer review: it is a plain widening, like a new table action today (ADR-0050 §3), and it publishes at
  once with its line recorded. A protected environment does not park on it.

### What it does not change

- **The proxy and IAM.** Table policies are in neither the proxy table nor the IAM schema.
- **Enforcement.** The data layer still decides every statement: `checkAppReach` admits any action of a credentialed
  site for an `'any'` read and checks the column read actions as today.
- **The contract artifact** gains one value of `TablePolicyArtifact`'s read field. It is additive, and only a contract
  that uses it changes its digest.

## ADR text changes

**ADR-0012 §7**, in the paved-road bullet, after "Each operation of a table policy names one action or a list, any one
of which allows it, so staff and a public procedure can read one table under their own actions.":

> An application table's read may be `'any'` instead: every credentialed site of the application reads it (an RPC
> procedure of a member, a job, a webhook), never a public procedure, a link procedure or an export. A column with its
> own read action stays readable only with it, writes keep their actions, and a `when` keyed by an action narrows only
> that action's writes there. `'any'` is written per table; a table without a read action is read by none.

**ADR-0050 §3**, the table bullet, after "an action the list gains widens, one it loses narrows":

> A read that becomes `'any'` widens to every credentialed site, and one that leaves it narrows to its list.

`packages/db/CLAUDE.md` and the skill's table reference describe the form; `packages/db`'s policy parse refuses
`'any'` on a dimension, child or reference table and on any operation other than `read`.

## Protocol and rollout

- **The contract artifact is platform protocol.** A new read value is additive: Control reads an application with its
  own release's reader (ADR-0062), so the platform release that bundles a reader of the new form ships before the
  framework release that emits it.
- **Rollout path of an existing installation.** No generated installation file, environment variable or provider
  state changes. No proxy or IAM change.

## Migration for existing applications

- Nothing changes until a table declares `'any'`. Lists keep working.
- The consumer's generator would emit `read: 'any'` for every table whose list is not meant to restrict. The upper
  bound is the 8,647 names of the read lists, a little under half of `tables.ts`. Tables that hold sensitive data keep
  their lists or put the sensitive columns under a column read action. Which tables those are is the consumer's
  decision, so the real saving is not measured.
- On a protected environment the change publishes without a park: it is a plain widening.

## Cost to build

| Part                                                                                                                            | Agent time |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `@fabrika/db`: the policy parse and types (`'any'` only on an application table's read), `checkAppReach`, `when` on writes only | 2–3 h      |
| `auth-core` artifact field and the artifact parser; the static reader, if it is still the reader                                | 1 h        |
| Control: the diff line                                                                                                          | 0.5–1 h    |
| Skill, `packages/db/CLAUDE.md`, the table reference                                                                             | 0.5–1 h    |
| **Total**                                                                                                                       | **4–6 h**  |

Add one review round. The optional list of write actions per column adds 1–2 h.

## Open questions

- **Scoped sites.** Should a scoped endpoint's `ctx.db.app` read `'any'` tables, as proposed, or only `app` sites and
  workloads? Excluding scoped sites protects a multi-tenant application that puts tenant data in an application table
  by mistake. Including them keeps one rule. The consumer has no scoped endpoints, so it does not decide this.
- **The name.** `'any'` reads as "any action". `'members'` would say who reads, but jobs and webhooks are not members.
