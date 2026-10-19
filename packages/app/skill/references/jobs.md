# references/jobs.md — cron jobs

Background work is a cron job: `app.cron(schedule, { actions, scope: 'app' })` with its `.handle(…)` in the
`endpoints.ts` of the slice whose data it works on, mounted under `jobs` in the contract. There are no timers, loops,
`setInterval` or self-scheduled work, and no `ctx.jobs.enqueue`: work for later is a row that a run picks up. A
mutation that declares `then: '<job>'` starts a run within seconds of its commit (the outbox below); the schedule
picks up whatever that run leaves.

```ts src/overdue/endpoints.ts
import { app } from '../app-kit'
import { isOverdue } from './logic'

/** Marks every open task past its due day, hourly; each is re-read under its lock, so a concurrent change is skipped. */
export const markOverdue = app.cron('15 * * * *', {
	actions: ['tasks.read', 'tasks.write'],
	scope: 'app',
	limits: { timeoutMs: 600000 },
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
- An attempt that fails or outlives `limits.timeoutMs` (default 15 minutes, at most a day) is retried up to `retries` times, so every write is
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
- A job reads a file collection through `ctx.files('<collection>')` with a `Ref` it minted (`list`, `open` to hand a
  file to another service), and removes an owner's files only inside its transaction, `tx.files('<collection>').removeAll(ref)`
  (`references/files.md`). The framework's own `fabrika-file-sweep` then deletes their objects; never write a sweep.
- `ctx.signal` aborts when the attempt ends (its timeout, a lost lease). Call `ctx.signal.throwIfAborted()` before
  each external effect and pass the signal to `fetch`, so a stale attempt starts nothing after its replacement.
- A failed attempt names its failure in `kit.runJob`'s answer and the log: `handler_failed`, a framework refusal
  with its reason (`query_refused: undeclared_reach`, `capability_refused: undeclared_action`; `references/errors.md`),
  or `mail_failed` with the transport's code (`mail_failed: provider_rejected`).

## E-mail: `mailer` and `ctx.mail`

Only a cron job that declares `mailer` sends e-mail, through `ctx.mail`. An endpoint has no `ctx.mail` (a type error
that says so): it records an outbox row and kicks the job (below). `references/public-intake.md` shows both jobs whole.

- `mailer: 'installation'` sends through the installation's transport: the operator configures one provider, and
  Control hands it to each application whose job declares it. The application holds no provider key and writes no
  transport code. An installation without a transport still deploys it, and `ctx.mail.available` is then false.
- `mailer: 'own'` sends through the application's own transport: `serve(contract, { database, mail: (env) => sender })`,
  where `sender` is an `EmailSender` (`@fabrika/app/implement`) built from the application's own variables, or `null`
  when they configure none. Never name a variable `FABRIKA_EMAIL_*`: those are the installation's.
- `mailer` is reach the approver sees (`installation` for closer review). Declare it only after the human said yes.
  Without it, `ctx.mail` is a type error that names the declaration. A boot without the declared transport fails and
  says which job needs it; the test kit and `fabrika app dev` stand one in (`kit.mail`, `references/tests.md`).
- `ctx.mail.send({ to, subject, text, html?, replyTo?, fromName?, idempotencyKey }, signal?)` hands one message to the
  transport and answers `{ status: 'accepted', provider, messageId }`. It always aborts with the attempt's
  `ctx.signal`; pass `AbortSignal.timeout(ms)` for a deadline of the message's own. The sending address is the
  transport's; `fromName` and `replyTo` are the application's, per message. There are no attachments.
- `idempotencyKey` is 1 to 200 visible ASCII characters, unique per message in the application environment, and
  derived from the outbox row (`intake-link-<link id>`), never random. `ctx.mail` puts a prefix of the installation
  and the environment in front of it, so no other application on the same provider account shares it.
- `ctx.mail.available` is false where the installation has no transport. Every send then fails `mail_not_configured`
  (`not_sent`). Check it before the batch: when it is false, return and leave every row as it is, so no attempt is
  spent. The rows leave on the first run after the operator adds a transport and redeploys the application.
- A refused send throws `EmailDeliveryError` (`@fabrika/app/implement`): a fixed `code` and an `outcome`, `not_sent`
  (the message did not leave) or `unknown` (it may have). `ctx.mail.mayRetry(error)` says whether the message may go
  again: false for a refused message or configuration, and for an `unknown` outcome over a transport that does not
  deduplicate a key (`ctx.mail.capabilities.idempotent` is false). Where it is false, never send again: the row is
  dead, for a person.
- A send error the handler does not catch fails the attempt as `mail_failed`, and the runner retries the attempt only
  where `mayRetry` holds. Catch it per row instead, as the outbox below does.
- Never log a message, its address or its key: log the row's id and the error's `code`.

## An outbox: what a request asks a job to do

A request handler calls no outside service and sends no e-mail (`references/endpoint.md`). It records what to do in a
row, in its own transaction: a form's inbox row, an outbox row (`test_mails`), or a state of its record
(`link_state = 'due'`). A job does the work and calls the service. `references/public-intake.md` is the whole recipe.

**The kick.** A mutation that records such a row declares `then: '<job>'`: once its transaction committed, the job
runs within seconds, under its own key, and the answer does not wait for it. A form's `then` does the same for its
inbox. A thrown handler, a refused answer and a failed commit kick nothing. Kicks coalesce: at most one run is active
and one pending, however many calls arrive. A kick carries nothing; the job reads its rows, and its schedule stays the
recovery. `then` names one cron job of the contract, as a literal (`r.mutation({ …, then: 'testMails' })`); a query,
an export, a webhook and a job declare none.

The rules of the job:

- **Bounded batches.** Each run takes at most a fixed number of records (`order by received_at, id limit 50`), oldest
  first; the next run takes the rest.
- **Claim a record where you consume it**: read it `for update skip locked` in the transaction that writes it, so a
  row another session holds waits for a later run and blocks nothing behind it.
- **Each record is its own work.** Run it in its own transactions, inside a `try`: a failure adds one to the record's
  `attempts`, keeps a fixed step code in `last_failure` (never the error's message, which can quote a value), and the
  run goes on with the next record. Rethrow when `ctx.signal` aborted: that failure is the attempt's, and the next
  run meets the record as it is. So give each external call a deadline of its own inside the attempt's
  (`AbortSignal.any([ctx.signal, AbortSignal.timeout(ms)])` for a `fetch`; `ctx.mail.send` adds `ctx.signal` itself,
  so it takes only `AbortSignal.timeout(ms)`): a call that hangs then fails its record, not the run.
- **A backoff per record.** A failure sets the record's `next_attempt_at` one minute ahead, doubled per attempt up to
  an hour (`now() + least(interval '1 minute' * power(2, attempts), interval '1 hour')`), and a run takes only records
  whose time has come (`where next_attempt_at <= now()`). Kicks start runs seconds apart: without the wait, a short
  provider outage spends every attempt of a record at once. Set it, with the attempt, in the transaction that claims
  the record before the call (the test e-mail), and a run that dies during the call waits too. A record a person
  revives (a resend) is due at once again.
- **A dead state.** A record that failed `MAX_ATTEMPTS` times is dead: the batch skips it, the job logs it once by its
  id (never an address), and an operator fixes or deletes it. Give the record a way back when the cause can go away
  (a resend revives a dead delivery).
- **A key on every external call**, derived from the record: the e-mail's `idempotencyKey`, a provider's request id.
  A provider that deduplicates then acts once per key, however often the job hands the call over. A retry sends the
  same request under the same key: keep what it needs in the row until the call is known done (sealed, when it holds a
  secret).
- **A retry only where the transport allows it.** Mark the record `sending` before the send. A run that finds it still
  `sending` (a crash, a lost answer) sends it again only when `ctx.mail.capabilities.idempotent` holds, and otherwise
  makes it dead: the e-mail may have arrived, and a second one cannot be taken back. A failed send goes again only
  where `ctx.mail.mayRetry(error)` holds, and is dead at once otherwise; one whose `outcome` is `not_sent` returns to
  the state it had before `sending`.
- **Each step recorded before the next effect**, so the next run finishes a stopped one.
- An inbox needs a row key for this: `id UUID NOT NULL DEFAULT gen_random_uuid()`, since a form writes only its input
  fields.
