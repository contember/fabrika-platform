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

  ``ctx.transaction((tx) => tx.sql(Marked)`update tasks set overdue = true, version = version + 1 where (…) and ${tx.sql.scope(within, 'tasks')} returning id`)``

  `within` is the `Within` the job minted (`ctx.within('tasks.write', 'org')`). The version bump is yours to write.
- `bun test --isolate` runs a job with `kit.runJob('markOverdue')` (`references/tests.md`). The platform runs
  `fabrika job run <name>` from the crontab it generates; never write a crontab or read `FABRIKA_JOB_*`.
- A job cannot create scopes or manage members, and has no `ctx.members`: a job holds no object chain. It issues share
  links only when it declares `issues: '<link mount>'` and its actions hold the mount's `issuedBy` and every grant:
  `ctx.links.issue(await ctx.ref('<issuedBy>', '<dimension>', id), { mount, days })`, and `ctx.links.revoke(id)` for
  a link it issued. It is a widening for closer review. `references/public-intake.md` is the whole recipe: a form's
  inbox, the record, the link and its e-mail, each step recorded before the next.
- `ctx.signal` aborts when the attempt ends (its timeout, a lost lease). Call `ctx.signal.throwIfAborted()` before
  each external effect and pass the signal to `fetch`, so a stale attempt starts nothing after its replacement.
