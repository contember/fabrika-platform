// The job runner over `@fabrika/db` on a REAL Postgres: a run takes the job's lease or does not start, each attempt
// holds one generation of it, and no write of an attempt that timed out or lost the lease commits. Skips the
// Postgres half cleanly when FABRIKA_TEST_POSTGRES_URL is unset (see scoped-database.test.ts).

import { runContractJob, serveContract } from '@fabrika/app/bun'
import { BootError, type ContractApp, type JobClock, type OperationsReport } from '@fabrika/app/implement'
import { applicationSchema, Database, type Within } from '@fabrika/db'
import { FRAMEWORK_MIGRATION_BUNDLE, FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { applicationRuntimeUrl, definePostgresApplicationMigrations, dropApplicationDatabase } from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test'
import { defineContract } from '../contract/define'
import { implement } from '../implement/implement'
import { reportEnvelope } from '../jobs/report'
import { secretScrubber } from '../jobs/scrub'
import {
	bootApp,
	environment,
	frameworkEnvFor,
	keepingProcessEnvironment,
	keySource,
	PROXY_SECRET,
	serveStandInIam,
	workloadTokensFor,
} from './fixtures/implement/harness'
import { filesJobsApp, type JobHooks, jobsApp, startingJobsApp } from './fixtures/jobs-notes/app'
import { migration } from './fixtures/scoped-notes/migration'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`jobs.test.ts skipped its Postgres half: set ${URL_VAR} to run it`)
}

const appId = `jobs-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const schema = applicationSchema(appId)
let database: Database

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

async function seedNote(title: string, workspace = 'w1'): Promise<string> {
	const id = Bun.randomUUIDv7()
	await admin((sql) =>
		sql.unsafe(`insert into ${schema}.notes (id, workspace_id, title, created_by, version) values ($1, $2, $3, 'user-9', 1)`, [id, workspace, title])
	)
	return id
}

async function noteExists(id: string): Promise<boolean> {
	const rows = await admin((sql) => sql.unsafe(`select id from ${schema}.notes where id = $1`, [id]))
	return rows.length > 0
}

/** A gate a handler waits at, and the signal that it got there. */
function gate() {
	const reached = Promise.withResolvers<void>()
	const opened = Promise.withResolvers<void>()
	return {
		reached: reached.promise,
		open: () => opened.resolve(),
		wait: async () => {
			reached.resolve()
			await opened.promise
		},
	}
}

/** Real time, instant backoff; an attempt's timeout (a minute or more) fires only when the test calls `timeOut`. */
function testClock() {
	const timeouts: (() => void)[] = []
	const clock: JobClock = {
		wait: (ms, signal) =>
			new Promise<void>((resolve) => {
				if (ms < 60_000 || signal.aborted) {
					resolve()
					return
				}
				timeouts.push(resolve)
				signal.addEventListener('abort', () => resolve(), { once: true })
			}),
		random: () => 0,
	}
	return { clock, timeOut: () => timeouts.splice(0).forEach((fire) => fire()) }
}

function recorder() {
	const reports: OperationsReport[] = []
	return { reports, reporter: { report: (report: OperationsReport) => Promise.resolve(void reports.push(report)) } }
}

const passing: JobHooks = { beforeDelete: () => Promise.resolve(), flaky: () => Promise.resolve() }

function quietly<T>(work: () => Promise<T>): Promise<T> {
	const log = spyOn(console, 'error').mockImplementation(() => {})
	return work().finally(() => log.mockRestore())
}

/** `work`'s result and every line it logged. */
async function logged<T>(work: () => Promise<T>): Promise<{ readonly result: T; readonly lines: readonly string[] }> {
	const log = spyOn(console, 'error').mockImplementation(() => {})
	try {
		const result = await work()
		return { result, lines: log.mock.calls.map((call) => call.map(String).join(' ')) }
	} finally {
		log.mockRestore()
	}
}

const kinds = (reports: readonly OperationsReport[]) => reports.map((report) => [report.type, report.tags['code'] ?? null])

describe('boot binds every job or does not start', () => {
	const connection = Database.postgres({ url: 'postgres://user:secret@127.0.0.1:1/none', schema: 'app_notes' })
	afterAll(() => connection.close())

	function problemsOf(work: () => unknown): readonly string[] {
		try {
			work()
		} catch (error) {
			if (error instanceof BootError) {
				return error.problems
			}
			throw error
		}
		return []
	}

	test('a contract with jobs boots once each has a handler and the data layer is bound', () => {
		const app = jobsApp(passing)
		expect(bootApp(app, { database: connection }).jobs.names).toEqual(['purge', 'sweep', 'flaky'])
	})

	test('a job without the data layer, without a handler, or with an undeclared handler', () => {
		const contract = defineContract({
			app: 'notes',
			dimensions: { workspace: {} },
			actions: { 'notes.read': 'Read' },
			roles: { reader: { grants: ['notes.read'] } },
		}, (c) => ({
			health: c.health('/healthz'),
			jobs: {
				nightly: c.cron('0 3 * * *', { actions: ['notes.read'] }),
				hourly: c.cron('0 * * * *', { actions: ['notes.read'], limits: { timeoutMs: 300000 } }),
			},
		}))
		const loose = implement(contract, {
			database: null,
			deps: () => null,
			handlers: () => ({ jobs: { nightly: () => {}, hourly: () => {} } }),
		})
		const missing = { ...loose, handlers: () => ({ jobs: { nightly: () => {}, extra: () => {} } }) }
		const options = { environment: environment(frameworkEnvFor(loose)), iam: keySource }
		expect(problemsOf(() => bootApp(missing, options))).toEqual([
			"job 'nightly' needs @fabrika/db on Postgres, which holds its lease and fences its writes: serve(contract, { database: scoped(tables) })",
			"job 'hourly' needs @fabrika/db on Postgres, which holds its lease and fences its writes: serve(contract, { database: scoped(tables) })",
			"job 'hourly' has no handler; add it to handlers.jobs",
			"handler 'jobs.extra' is not in the contract; declare the endpoint in fabrika.contract.ts first",
		])
	})

	test('a job without its key, or without a token exchange for it, does not boot', () => {
		const { FABRIKA_JOB_PURGE_KEY: _purge, ...withoutPurge } = frameworkEnvFor(jobsApp(passing))
		const framework = { ...withoutPurge, FABRIKA_JOB_SWEEP_KEY: 'not-a-key' }
		expect(problemsOf(() => bootApp(jobsApp(passing), { database: connection, environment: environment(framework) }))).toEqual([
			"FABRIKA_JOB_PURGE_KEY is not set to a px_ key; Control writes the credential of the job 'purge' into every deploy",
			"FABRIKA_JOB_SWEEP_KEY is not set to a px_ key; Control writes the credential of the job 'sweep' into every deploy",
		])
		const noExchange = { database: connection, environment: environment(frameworkEnvFor(jobsApp(passing))), workloadTokens: undefined }
		expect(problemsOf(() => bootApp(jobsApp(passing), noExchange))).toEqual([
			'the contract declares jobs, webhooks or public procedures, and the runtime adapter supplies no IAM token exchange for their keys',
		])
	})

	test('an unknown job does not run', () => {
		const jobs = bootApp(jobsApp(passing), { database: connection }).jobs
		expect(() => jobs.run('missing')).toThrow("no job 'missing' in the contract (jobs: purge, sweep, flaky)")
	})

	test('an Operations DSN that is not an ingest DSN stops the boot', () => {
		const app = jobsApp(passing)
		const framework = { ...frameworkEnvFor(app), FABRIKA_OPERATIONS_DSN: 'https://operations.example' }
		expect(problemsOf(() => bootApp(app, { database: connection, environment: environment(framework) }))).toEqual([
			'FABRIKA_OPERATIONS_DSN is not an ingest DSN (https://<key>@<host>/<project>), so a failure would reach no one',
		])
	})
})

describe.skipIf(!hasPostgres)('the job runner on Postgres', () => {
	beforeAll(async () => {
		const framework = { bundle: FRAMEWORK_MIGRATION_BUNDLE, migrations: FRAMEWORK_MIGRATIONS }
		await definePostgresApplicationMigrations({ appId, directory: '/unused', framework }).migrate(url, [{
			name: '20261011120000_notes.sql',
			sql: migration,
		}])
		database = Database.postgres({ url: applicationRuntimeUrl(url, appId), schema, max: 4 })
	})

	afterAll(async () => {
		await database.close()
		await dropApplicationDatabase(url, appId)
	})

	beforeEach(async () => {
		await admin((sql) => sql.unsafe(`delete from ${schema}.notes; delete from ${schema}.fabrika_job_leases`))
	})

	const boot = (hooks: JobHooks): ContractApp => bootApp(jobsApp(hooks), { database })
	const leaseOf = async (job: string) =>
		(await admin((sql) =>
			sql.unsafe(`select generation, holder, last_status, last_duration_ms, last_started_at from ${schema}.fabrika_job_leases where job = $1`, [job])
		))[0]
	const setLease = (job: string, assignments: string) =>
		admin((sql) => sql.unsafe(`update ${schema}.fabrika_job_leases set ${assignments} where job = $1`, [job]))

	test('a run deletes through the capabilities its ctx mints, in every workspace, and records its outcome and duration', async () => {
		const expired = [await seedNote('expired', 'w1'), await seedNote('expired', 'w2')]
		const kept = await seedNote('current', 'w1')
		const { reports, reporter } = recorder()
		expect(await boot(passing).jobs.run('purge', { reporter })).toEqual({ status: 'succeeded', attempts: 1 })
		expect(await Promise.all([...expired, kept].map(noteExists))).toEqual([false, false, true])
		expect(reports).toEqual([])
		expect(await leaseOf('purge')).toEqual({
			generation: 1,
			holder: null,
			last_status: 'succeeded',
			last_duration_ms: expect.any(Number),
			last_started_at: expect.any(Date),
		})
	})

	test('a job mints only what IAM signs for its key: a declared action its token lacks is refused, and nothing is deleted', async () => {
		const expired = await seedNote('expired')
		const app = jobsApp(passing)
		const narrowed = workloadTokensFor(app, (workload) => workload.actions.filter((action) => action !== 'notes.delete'))
		const { reports, reporter } = recorder()
		const result = await quietly(() => bootApp(app, { database, workloadTokens: narrowed }).jobs.run('sweep', { reporter }))
		expect(result).toEqual({ status: 'failed', attempts: 1, code: 'capability_refused', reason: 'undeclared_action' })
		expect(await noteExists(expired)).toBe(true)
		expect(kinds(reports)).toEqual([['JobFailed', 'capability_refused']])
	})

	test('a key IAM refuses fails the run as unauthorized, and an IAM it cannot reach as iam_unavailable; no handler runs', async () => {
		const expired = await seedNote('expired')
		let ran = 0
		const hooks: JobHooks = { ...passing, beforeDelete: () => Promise.resolve(void ran++) }
		const refusing = { exchange: () => Promise.resolve({ ok: false as const, reason: 'invalid_key' as const }) }
		const unreachable = { exchange: () => Promise.reject(new Error('connect ECONNREFUSED')) }
		const refused = await logged(() => bootApp(jobsApp(hooks), { database, workloadTokens: refusing }).jobs.run('sweep'))
		expect(refused.result).toEqual({ status: 'failed', attempts: 1, code: 'unauthorized' })
		expect(refused.lines).toContain("fabrika: IAM refused the key of the job 'sweep': invalid_key")
		const down = await logged(() => bootApp(jobsApp(hooks), { database, workloadTokens: unreachable }).jobs.run('sweep'))
		expect(down.result).toEqual({ status: 'failed', attempts: 1, code: 'iam_unavailable' })
		expect(down.lines.join('\n')).not.toContain('ECONNREFUSED')
		expect(ran).toBe(0)
		expect(await noteExists(expired)).toBe(true)
	})

	test('an overlapping run does not start', async () => {
		await seedNote('expired')
		const held = gate()
		let deletes = 0
		const app = boot({ ...passing, beforeDelete: () => (deletes++ === 0 ? held.wait() : Promise.resolve()) })
		const first = app.jobs.run('purge')
		await held.reached
		expect(await quietly(() => app.jobs.run('purge'))).toEqual({ status: 'skipped' })
		expect(deletes).toBe(1)
		held.open()
		expect(await first).toEqual({ status: 'succeeded', attempts: 1 })
	})

	test('a runner whose clock is minutes ahead still waits for the lease to expire by the database clock', async () => {
		await seedNote('expired')
		const held = gate()
		const app = boot({ ...passing, beforeDelete: () => held.wait() })
		const first = app.jobs.run('sweep')
		await held.reached
		// `sweep` holds its lease for its 1m timeout plus the grace minute; this process now believes ten minutes passed.
		setSystemTime(new Date(Date.now() + 10 * 60_000))
		try {
			expect(await quietly(() => boot(passing).jobs.run('sweep'))).toEqual({ status: 'skipped' })
		} finally {
			setSystemTime()
		}
		held.open()
		expect(await first).toEqual({ status: 'succeeded', attempts: 1 })
	})

	test('a run that lost its lease cannot commit; the run that took it over can, and reports the crash', async () => {
		const note = await seedNote('expired')
		const stale = gate()
		const taker = gate()
		const { reports, reporter } = recorder()
		const order: string[] = []
		const app = boot({
			...passing,
			beforeDelete: (_job, ctx) => {
				if (!order.includes(ctx.runId)) order.push(ctx.runId)
				return order.indexOf(ctx.runId) === 0 ? stale.wait() : taker.wait()
			},
		})
		const first = quietly(() => app.jobs.run('purge', { reporter }))
		await stale.reached
		// The first run's lease expires (by the database's clock), so the next tick reaps it and takes the job over.
		await setLease('purge', `expires_at = now() - interval '1 second'`)
		const second = quietly(() => app.jobs.run('purge', { reporter }))
		await taker.reached
		stale.open()
		expect(await first).toEqual({ status: 'failed', attempts: 1, code: 'lease_lost' })
		expect(await noteExists(note)).toBe(true)
		taker.open()
		expect(await second).toEqual({ status: 'succeeded', attempts: 1 })
		expect(await noteExists(note)).toBe(false)
		expect(kinds(reports)).toEqual([['JobFailed', 'crashed'], ['JobFailed', 'lease_lost']])
	})

	test('an attempt that outlives its timeout fails, and what it still does afterwards commits nothing', async () => {
		const note = await seedNote('expired')
		const hung = gate()
		const { clock, timeOut } = testClock()
		const { reports, reporter } = recorder()
		const run = quietly(() => boot({ ...passing, beforeDelete: () => hung.wait() }).jobs.run('sweep', { clock, reporter }))
		await hung.reached
		timeOut()
		expect(await run).toEqual({ status: 'failed', attempts: 1, code: 'timeout' })
		// The handler wakes after its attempt ended: the delete it now sends is refused.
		hung.open()
		await Bun.sleep(50)
		expect(await noteExists(note)).toBe(true)
		expect(reports.map((report) => report.message)).toEqual(["job 'sweep' failed after 1 attempt: timeout"])
		expect(await leaseOf('sweep')).toMatchObject({ holder: null, last_status: 'failed' })
	})

	test('a delete that passed the fence and then waits on a row lock is cancelled when its attempt times out', async () => {
		const note = await seedNote('expired')
		const { clock, timeOut } = testClock()
		const deleting = Promise.withResolvers<void>()
		const app = boot({
			...passing,
			beforeDelete: async () => deleting.resolve(),
		})
		await admin(async (sql) => {
			await sql.unsafe('begin')
			await sql.unsafe(`select id from ${schema}.notes where id = $1 for update`, [note])
			const run = quietly(() => app.jobs.run('sweep', { clock }))
			await deleting.promise
			await Bun.sleep(200)
			timeOut()
			// Without the cancellation the runner's finish would wait for the blocked delete, a minute.
			expect(await run).toEqual({ status: 'failed', attempts: 1, code: 'timeout' })
			await sql.unsafe('rollback')
		})
		expect(await noteExists(note)).toBe(true)
		expect(await leaseOf('sweep')).toMatchObject({ holder: null, last_status: 'failed' })
	})

	test('a failed attempt is retried under a new generation; its capabilities are refused in the next', async () => {
		await seedNote('current')
		const kept: Within<'workspace', 'notes.read'>[] = []
		const seen: string[] = []
		const { clock } = testClock()
		const app = boot({
			...passing,
			flaky: async (ctx, notes) => {
				if (ctx.attempt === 1) {
					kept.push(ctx.within('notes.read', 'workspace'))
					throw new Error('the upstream answered 502')
				}
				for (const earlier of kept) {
					await notes.list(earlier).catch((error: unknown) => seen.push(String(error)))
				}
				seen.push(`attempt ${ctx.attempt}: ${(await notes.list(ctx.within('notes.read', 'workspace'))).length} note`)
			},
		})
		const { result, lines } = await logged(() => app.jobs.run('flaky', { clock }))
		expect(result).toEqual({ status: 'succeeded', attempts: 2 })
		expect(lines).toEqual(["fabrika: job 'flaky' attempt 1 of 2 failed: handler_failed"])
		expect(seen).toEqual([expect.stringContaining('which has ended; never keep a capability past its request'), 'attempt 2: 1 note'])
		expect(await leaseOf('flaky')).toMatchObject({ generation: 2, last_status: 'succeeded' })
	})

	test('a job asking for an action it does not declare fails as capability_refused, naming the reason', async () => {
		const { clock } = testClock()
		const { reports, reporter } = recorder()
		const app = boot({
			...passing,
			flaky: async (ctx) => {
				Reflect.apply(ctx.within, ctx, ['notes.delete', 'note'])
			},
		})
		const { result, lines } = await logged(() => app.jobs.run('flaky', { clock, reporter }))
		expect(result).toEqual({ status: 'failed', attempts: 2, code: 'capability_refused', reason: 'undeclared_action' })
		const why = "capability_refused: undeclared_action: the job's declaration or its token does not carry the action"
		expect(lines).toEqual([`fabrika: job 'flaky' attempt 1 of 2 failed: ${why}`, `fabrika: job 'flaky' failed after 2 attempts: ${why}`])
		expect(kinds(reports)).toEqual([['JobFailed', 'capability_refused']])
	})

	test('an application error dressed as a framework error reaches no log or result; the report sends it scrubbed', async () => {
		const secret = 'postgres://notes:hunter2@db/notes'
		for (const name of ['LeaseLostError', 'CapabilityRefusedError', 'CapabilityLimitError', 'JobError', 'BootError', 'NotFoundError']) {
			const { clock } = testClock()
			const { reports, reporter } = recorder()
			const error = new Error(secret)
			error.name = name
			const app = boot({
				...passing,
				flaky: async () => {
					throw error
				},
			})
			const { result, lines } = await logged(() => app.jobs.run('flaky', { clock, reporter }))
			expect(result).toEqual({ status: 'failed', attempts: 2, code: 'handler_failed' })
			const logs = JSON.stringify([result, lines])
			expect(logs).not.toContain('hunter2')
			expect(logs).not.toContain(name)
			expect(reports).toEqual([expect.objectContaining({ type: 'JobFailed', tags: { job: 'flaky', code: 'handler_failed' }, error })])
			const [report] = reports
			if (report === undefined) throw new Error('no report')
			const sent = reportEnvelope(report, { release: null, environment: null, source: 'fabrika.jobs', scrubber: secretScrubber([]) }, new Date())
			expect(sent).not.toContain('hunter2')
		}
	})

	test('a job that has not succeeded within twice its period is reported as missed, once per period', async () => {
		const { reports, reporter } = recorder()
		const app = boot(passing)
		expect(await app.jobs.run('purge', { reporter })).toEqual({ status: 'succeeded', attempts: 1 })
		await setLease('purge', `last_succeeded_at = now() - interval '3 days'`)
		expect(await app.jobs.run('purge', { reporter })).toEqual({ status: 'succeeded', attempts: 1 })
		await setLease('purge', `last_succeeded_at = now() - interval '3 days'`)
		expect(await app.jobs.run('purge', { reporter })).toEqual({ status: 'succeeded', attempts: 1 })
		expect(reports).toEqual([{
			fingerprint: ['fabrika-job-missed', 'purge'],
			type: 'JobMissed',
			message: expect.stringMatching(/^job 'purge' last succeeded at .+; it is due every 1440 min and has missed twice that$/),
			tags: { job: 'purge' },
		}])
	})

	test('concurrent invocations that all skip claim one missed-run report', async () => {
		await seedNote('expired')
		const held = gate()
		const { reports, reporter } = recorder()
		const app = boot({ ...passing, beforeDelete: () => held.wait() })
		const first = app.jobs.run('purge', { reporter })
		await held.reached
		await setLease('purge', `first_seen_at = now() - interval '3 days'`)
		const skipped = await quietly(() => Promise.all([1, 2, 3, 4, 5].map(() => app.jobs.run('purge', { reporter }))))
		expect(skipped).toEqual([1, 2, 3, 4, 5].map(() => ({ status: 'skipped' })))
		expect(kinds(reports)).toEqual([['JobMissed', null]])
		held.open()
		await first
	})

	test('the periodic check reports an overdue job that is never invoked, and a crashed run, once each', async () => {
		const { reports, reporter } = recorder()
		const app = boot(passing)
		await app.jobs.check({ reporter })
		expect(reports).toEqual([])
		expect(await leaseOf('purge')).toMatchObject({ generation: 0, holder: null, last_status: null })
		await setLease('purge', `first_seen_at = now() - interval '3 days'`)
		await setLease(
			'flaky',
			`holder = 'a-run-that-died', generation = 1, last_started_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'`,
		)
		await quietly(() => app.jobs.check({ reporter }))
		await quietly(() => app.jobs.check({ reporter }))
		expect(kinds(reports)).toEqual([['JobMissed', null], ['JobFailed', 'crashed']])
		expect(reports.map((report) => report.tags['job'])).toEqual(['purge', 'flaky'])
		expect(await leaseOf('flaky')).toMatchObject({ holder: null, last_status: 'failed', last_duration_ms: expect.any(Number) })
	})

	test('fabrika job run boots like the server: framework variables leave the process before the application loads', async () => {
		await seedNote('expired')
		const app = jobsApp(passing)
		const iam = serveStandInIam(app)
		const env = {
			...frameworkEnvFor(app),
			FABRIKA_IAM_ISSUER: iam.origin,
			FABRIKA_APP_ID: appId,
			FABRIKA_APP_RUNTIME_DATABASE_URL: applicationRuntimeUrl(url, appId),
			FABRIKA_PROXY_SECRET: PROXY_SECRET,
			FABRIKA_TEST_MARKER: 'x',
		}
		const seen: (string | undefined)[] = []
		const result = await keepingProcessEnvironment(async () => {
			process.env['FABRIKA_TEST_MARKER'] = 'x'
			return runContractJob(
				async () => {
					seen.push(process.env['FABRIKA_TEST_MARKER'])
					return { default: app }
				},
				env,
				'purge',
			)
		}).finally(() => iam.stop())
		// The job's token came from IAM's public token exchange, at the issuer the deploy names.
		expect(result).toEqual({ status: 'succeeded', attempts: 1 })
		expect(seen).toEqual([undefined])
	})

	test('fabrika job run boots a contract that creates scopes with the membership transport the platform wrote', async () => {
		const iam = serveStandInIam(startingJobsApp())
		const env = {
			...frameworkEnvFor(startingJobsApp()),
			FABRIKA_IAM_ISSUER: iam.origin,
			FABRIKA_APP_ID: appId,
			FABRIKA_APP_RUNTIME_DATABASE_URL: applicationRuntimeUrl(url, appId),
			FABRIKA_PROXY_SECRET: PROXY_SECRET,
		}
		// A fresh application per run: a data layer is bound once.
		const run = (variables: Readonly<Record<string, string>>) =>
			keepingProcessEnvironment(() => runContractJob(() => Promise.resolve({ default: startingJobsApp() }), variables, 'purge'))
		try {
			await expect(run(env)).rejects.toThrow('supplies no IAM membership transport')
			const withTransport = { ...env, FABRIKA_IAM_RPC_URL: iam.origin, FABRIKA_IAM_RPC_KEY: `px_${'m'.repeat(27)}` }
			expect(await run(withTransport)).toEqual({ status: 'succeeded', attempts: 1 })
		} finally {
			await iam.stop()
		}
	})

	test('fabrika job run boots a contract with a file kind on the object storage the platform wrote', async () => {
		const iam = serveStandInIam(filesJobsApp())
		const env = {
			...frameworkEnvFor(filesJobsApp()),
			FABRIKA_IAM_ISSUER: iam.origin,
			FABRIKA_APP_ID: appId,
			FABRIKA_APP_RUNTIME_DATABASE_URL: applicationRuntimeUrl(url, appId),
			FABRIKA_PROXY_SECRET: PROXY_SECRET,
		}
		const run = (variables: Readonly<Record<string, string>>) =>
			keepingProcessEnvironment(() => runContractJob(() => Promise.resolve({ default: filesJobsApp() }), variables, 'purge'))
		try {
			await expect(run(env)).rejects.toThrow('supplies no object storage')
			const withStorage = {
				...env,
				FABRIKA_APP_STORAGE_ENDPOINT: 'http://storage.invalid:9000',
				FABRIKA_APP_STORAGE_BUCKET: 'notes-files',
				FABRIKA_APP_STORAGE_ACCESS_KEY_ID: 'notes',
				FABRIKA_APP_STORAGE_SECRET_ACCESS_KEY: 's'.repeat(32),
			}
			expect(await run(withStorage)).toEqual({ status: 'succeeded', attempts: 1 })
		} finally {
			await iam.stop()
		}
	})

	test('the serving process registers every declared job when it starts', async () => {
		const app = jobsApp(passing)
		const env = {
			...frameworkEnvFor(app),
			FABRIKA_APP_ID: appId,
			FABRIKA_APP_RUNTIME_DATABASE_URL: applicationRuntimeUrl(url, appId),
			FABRIKA_PROXY_SECRET: PROXY_SECRET,
			PORT: '0',
		}
		await keepingProcessEnvironment(async () => {
			const server = await serveContract(() => Promise.resolve({ default: app }), env)
			try {
				for (let tries = 0; tries < 50 && (await leaseOf('flaky')) === undefined; tries++) {
					await Bun.sleep(20)
				}
				const rows = await admin((sql) => sql.unsafe(`select job from ${schema}.fabrika_job_leases order by job`))
				expect([...rows]).toEqual([{ job: 'flaky' }, { job: 'purge' }, { job: 'sweep' }])
				// The leases were written by the process's own pool, which connects as the runtime role.
				const [runtime] = await admin((sql) =>
					sql.unsafe('select count(*)::int as sessions from pg_stat_activity where usename = $1', [`run_${schema.slice('app_'.length)}`])
				)
				expect(runtime?.sessions).toBeGreaterThan(0)
			} finally {
				await server.stop()
			}
		})
	})
})
