# references/jobs.md — cron jobs

Background work is a cron job: `app.cron(schedule, { actions, scope: 'app' })` with its `.handle(…)` in the
`endpoints.ts` of the slice whose data it works on, mounted under `jobs` in the contract. There are no timers, loops,
`setInterval` or self-scheduled work, and no `ctx.jobs.enqueue`: work for later is a row that the next run picks up.

```ts src/overdue/endpoints.ts
import { app } from '../app-kit'
import { isOverdue } from './logic'

/** Marks every open task past its due day, hourly; each is re-read under its lock, so a concurrent change is skipped. */
export const markOverdue = app.cron('15 * * * *', {
	actions: ['tasks.read', 'tasks.write'],
	scope: 'app',
	timeout: '10m',
	retries: 2,
})
	.handle(async ({ ctx }) => {
		const today = new Date().toISOString().slice(0, 10)
		const tasks = ctx.db.over(ctx.within('tasks.read', 'project')).tasks
		let after: string | undefined
		do {
			const page = await tasks.list({
				where: [
					['overdue', '=', false],
					['status', '<>', 'done'],
					['due_on', '<', today],
				],
				limit: 100,
				after,
			})
			for (const task of page.items) {
				const ref = await ctx.ref('tasks.write', 'task', task.id)
				await ctx.transaction(async (tx) => {
					const locked = await tx.db.on(ref).getForUpdate()
					if (isOverdue(locked, today)) {
						await tx.db.on(ref).update({ overdue: true }, {
							expectVersion: locked.version,
						})
					}
				})
			}
			after = page.next ?? undefined
		} while (after !== undefined)
	})
```

The list's filter and the decision under the lock are one rule, a pure function of `logic.ts`. A task someone closed,
postponed or cleared the due day of between the list and the lock is left alone:

```ts src/overdue/logic.ts
/** An open task not yet marked, whose due day (`YYYY-MM-DD`) is before `today`. */
export const isOverdue = (
	task: {
		readonly status: 'open' | 'doing' | 'done'
		readonly overdue: boolean
		readonly due_on: string | null
	},
	today: string,
): boolean =>
	task.status !== 'done' && !task.overdue && task.due_on !== null
	&& task.due_on < today
```

```ts src/overdue/__tests__/logic.test.ts
import { expect, test } from 'bun:test'
import { isOverdue } from '../logic'

test('a task is overdue only while open, unmarked and due before today', () => {
	const task = { status: 'open', overdue: false, due_on: '2026-10-01' } as const
	expect(isOverdue(task, '2026-10-12')).toBe(true)
	expect(isOverdue({ ...task, due_on: '2026-10-12' }, '2026-10-12')).toBe(false)
	expect(isOverdue({ ...task, due_on: '2099-01-01' }, '2026-10-12')).toBe(false)
	expect(isOverdue({ ...task, due_on: null }, '2026-10-12')).toBe(false)
	expect(isOverdue({ ...task, status: 'done' }, '2026-10-12')).toBe(false)
	expect(isOverdue({ ...task, overdue: true }, '2026-10-12')).toBe(false)
})
```

```ts fabrika.contract.ts
import { app } from './src/app-kit'
import { comments } from './src/comments/endpoints'
import { members } from './src/members/endpoints'
import { markOverdue } from './src/overdue/endpoints'
import { priorities } from './src/priorities/endpoints'
import { projects } from './src/projects/endpoints'
import { reports } from './src/reports/endpoints'
import { tasks } from './src/tasks/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', {
		projects,
		tasks,
		comments,
		reports,
		members,
		priorities,
	}),
	jobs: { markOverdue },
	health: c.health('/healthz'),
}))
```

- The schedule is five cron fields, UTC. `scope: 'app'` is the only scope: a job reaches every value.
- A job holds exactly its `actions`. `ctx.within(action, dimension)` is a `Within` of every value;
  `ctx.ref(action, dimension, id)` locates one object (404 when it is gone). Bind them with `ctx.db.over(within)`,
  `ctx.db.in(ref)` and `ctx.db.on(ref)`.
- `ctx.within` names the dimension an endpoint's `over` would: the nearest of the rows' chain (tasks lie in a
  project: `'project'`; `references/endpoint.md`). A job holds every value, so a farther one reaches the same rows;
  the rule keeps a job's capability the same as the list endpoint's. `ctx.ref` names the row's own dimension (`'task'`).
- "Today" is the UTC day (`new Date().toISOString().slice(0, 10)`), so a task turns overdue at the first run after its
  due day ends in UTC, hours off an org's own midnight. When the product needs the org's day, ask the human: the
  zone is a new column (an IANA name). The decision under the lock then takes the org's day, computed in `logic.ts`
  with `new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(now)`, and the list filters with the UTC day plus
  one, since no zone is a day further ahead.
- **Reads run outside the transaction; every write runs inside `ctx.transaction((tx) => …)`**, through `tx.db`, fenced
  by the attempt's lease. A write outside it is a type error that names `tx.db`.
- An attempt that fails or outlives `timeout` (default 15 minutes) is retried up to `retries` times, so every write is
  idempotent. **Re-read each row under its lock before you write it:** `tx.db.on(ref).getForUpdate()` inside the
  transaction, decide again on what it answers with the list's whole filter (`isOverdue`), and write with its
  `version`. The listed row is already old: someone
  may have closed the task since, and writing with the listed version fails the whole attempt with a 409.
- Paging over a filter the job's own writes change is safe: `after` is a keyset cursor on the key, so a row that
  leaves the filter (`overdue` is now true) moves no other row to an earlier page.
- A bulk write declares `sql: 'write'` on the job and runs `tx.sql` inside the transaction:

  ``ctx.transaction((tx) => tx.sql(Marked)`update tasks set overdue = true, version = version + 1 where (…) returning id`)``

  The version bump is yours to write. **A job writes no scope fragment**: it is app-wide (`scope: 'app'` is the only
  scope), so `tx.sql.scope` of its `Within` would be every row.
- `bun test --isolate` runs a job with `kit.runJob('markOverdue')` (`references/tests.md`). The platform runs
  `fabrika job run <name>` from the crontab it generates; never write a crontab or read `FABRIKA_JOB_*`.
- A job cannot create scopes or manage members, and has no `ctx.members`: a job holds no object chain. It issues share
  links only when it declares `issues: '<link mount>'` and its actions hold the mount's `issuedBy` and every grant:
  `ctx.links.issue(await ctx.ref('<issuedBy>', '<dimension>', id), { mount, days })`, and `ctx.links.revoke(id)` for
  a link it issued. It is a widening for closer review. `references/public-intake.md` is the whole recipe: a form's
  inbox, the record, the link and its e-mail, each step recorded before the next.
- `ctx.signal` aborts when the attempt ends (its timeout, a lost lease). Call `ctx.signal.throwIfAborted()` before
  each external effect and pass the signal to `fetch`, so a stale attempt starts nothing after its replacement.
- A failed attempt names its failure in `kit.runJob`'s answer and the log: `handler_failed`, or a framework refusal
  with its reason (`query_refused: undeclared_reach`, `capability_refused: undeclared_action`; `references/errors.md`).

## An outbox: what a request asks a job to do

A request handler calls no outside service (`references/endpoint.md`). It records what to do in a row, in its own
transaction: a form's inbox row, or a state of its record (`link_state = 'due'`). A job does the work and calls the
service. `references/public-intake.md` is the whole recipe; its rules:

- **Bounded batches.** Each run takes at most a fixed number of records (`order by received_at, id limit 50`), oldest
  first; the next run takes the rest. The job's lease runs one attempt at a time, so no `for update skip locked`.
- **Each record is its own work.** Run it in its own transactions, inside a `try`: a failure adds one to the record's
  `attempts`, keeps a fixed step code in `last_failure` (never the error's message, which can quote a value), and the
  run goes on with the next record. Rethrow when `ctx.signal` aborted: that failure is the attempt's, and the next
  run meets the record as it is.
- **A dead state.** A record that failed `MAX_ATTEMPTS` times is dead: the batch skips it, the job logs it once by its
  id (never an address), and an operator fixes or deletes it. Give the record a way back when the cause can go away
  (a resend revives a dead delivery).
- **A key on every external call**, derived from the record: the e-mail's `Idempotency-Key`, a provider's request id.
  The provider then acts once per key, however often the job hands the call over.
- **Each step recorded before the next effect**, so the next run finishes a stopped one.
- An inbox needs a row key for this: `id UUID NOT NULL DEFAULT gen_random_uuid()`, since a form writes only its input
  fields.
