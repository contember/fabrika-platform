// The public intake recipe on a REAL Postgres (WU15): a form row becomes a candidate, the intake job issues and e-mails
// a link bound to it, the holder verifies once, and a resend supersedes the sent link within a daily budget. The job
// records each delivery step before the next effect; a run stopped between any two effects is finished by the next
// run with exactly one live, e-mailed link. IAM is an in-memory ledger of links here (its own rules are IAM's tests,
// and `packages/iam`'s visitor-link test runs this fixture against the real IAM through the proxy).

import type { ContractApp, JobClock } from '@fabrika/app/implement'
import type {
	IamMembershipRpc,
	IssueLinkInput,
	IssueLinkResult,
	LinkTokenClaims,
	MembershipFailure,
	RevokeLinkInput,
	RevokeLinkResult,
	Scope,
} from '@fabrika/auth-core'
import { applicationSchema, Database } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { bootApp, environment, frameworkEnvFor, grant, ISSUER, linkToken, resultOf, send, workloadTokensFor } from './fixtures/implement/harness'
import { migration } from './fixtures/visitor-intake/migration'
import { intakeApp } from './fixtures/visitor-intake/src/app'
import { SENDS_PER_DAY } from './fixtures/visitor-intake/src/intake/endpoints'
import type { DeliveryStep, IntakeWorld } from './fixtures/visitor-intake/src/world'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) {
	console.warn(`intake.test.ts skipped: set ${URL_VAR} to run it (the intake job's lease and the inboxes live in @fabrika/db)`)
}

const APP = 'intake@prod'
const ORIGIN = 'https://intake.test'
const schema = applicationSchema(`intake-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
const opened: Database[] = []

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

beforeAll(async () => {
	if (!hasPostgres) return
	const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
	await admin((sql) => sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${framework} ${migration}`))
})

beforeEach(async () => {
	if (!hasPostgres) return
	await admin((sql) =>
		sql.unsafe(
			`truncate ${schema}.fabrika_files_attachments, ${schema}.candidates, ${schema}.registrations, ${schema}.resend_requests; delete from ${schema}.fabrika_job_leases; delete from ${schema}.fabrika_form_admissions`,
		)
	)
})

afterAll(async () => {
	if (!hasPostgres) return
	for (const connection of opened) await connection.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

interface Link {
	readonly id: string
	readonly key: string
	readonly chain: readonly Scope[]
	revoked: boolean
}

/** IAM's link operations as an in-memory ledger: every issued link, and whether it was revoked. */
class LinkLedger implements IamMembershipRpc {
	readonly links: Link[] = []
	/** Throw instead of answering the next issuance, as an unreachable IAM does. */
	unreachable = false

	issueLink(input: IssueLinkInput): Promise<IssueLinkResult> {
		if (this.unreachable) {
			this.unreachable = false
			return Promise.reject(new Error('IAM is down'))
		}
		const link: Link = { id: `link-${this.links.length + 1}`, key: `px_key${this.links.length + 1}`, chain: input.chain, revoked: false }
		this.links.push(link)
		return Promise.resolve({ ok: true, key: link.key, id: link.id, expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400 })
	}

	revokeLink(input: RevokeLinkInput): Promise<RevokeLinkResult> {
		const link = this.links.find((candidate) => candidate.id === input.id)
		if (link === undefined) return Promise.resolve({ ok: false, reason: 'not_found' })
		link.revoked = true
		return Promise.resolve({ ok: true })
	}

	live(): Link[] {
		return this.links.filter((link) => !link.revoked)
	}

	requestDelegation = refused
	createScope = refused
	assignMember = refused
	revokeMember = refused
	listMembers = refused
	findMember = refused
}

function refused(): Promise<MembershipFailure> {
	return Promise.resolve({ ok: false, reason: 'not_allowed' })
}

/** A point a test holds an attempt at, and the signal that the attempt got there. */
interface Gate {
	readonly reached: Promise<void>
	open(): void
	wait(): Promise<void>
}

function gate(): Gate {
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

/**
 * The e-mail provider and the faults a test arms: a stop or a pause after an effect of a delivery, a refused message,
 * and a message held in flight, which the provider abandons once the attempt's signal aborts.
 */
class World implements IntakeWorld {
	readonly origin = ORIGIN
	readonly mails: { readonly to: string; readonly url: string }[] = []
	stopAfter: DeliveryStep | null = null
	pauseAfter: { readonly step: DeliveryStep; readonly gate: Gate } | null = null
	holdSend: Gate | null = null
	failSend = false
	abandoned = 0

	async send(message: { readonly to: string; readonly url: string }, signal: AbortSignal): Promise<void> {
		if (this.failSend) {
			this.failSend = false
			throw new Error('the provider refused the message')
		}
		const hold = this.holdSend
		if (hold !== null) {
			this.holdSend = null
			const aborted = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
			await Promise.race([hold.wait(), aborted])
			// The request was in flight: the provider abandons it on the abort, as a fetch with the signal would.
			if (signal.aborted) {
				this.abandoned++
				throw new Error('the message was abandoned')
			}
		}
		// A message the job hands over is sent, whatever its signal says: the job checks before it sends.
		this.mails.push(message)
	}

	async after(step: DeliveryStep): Promise<void> {
		if (this.stopAfter === step) {
			this.stopAfter = null
			throw new Error(`stopped after ${step}`)
		}
		const pause = this.pauseAfter
		if (pause?.step === step) {
			this.pauseAfter = null
			await pause.gate.wait()
		}
	}

	/** The key of the last e-mail to `to`, read from its link's fragment. */
	lastKey(to: string): string {
		const mail = this.mails.filter((message) => message.to === to).at(-1)
		const key = mail === undefined ? null : new URL(mail.url).hash.slice(1)
		if (key === null || key === '') throw new Error(`no link was e-mailed to ${to}`)
		return key
	}
}

interface Running {
	readonly app: ContractApp
	readonly iam: LinkLedger
	readonly world: World
	run(clock?: JobClock): Promise<unknown>
}

function start(): Running {
	const world = new World()
	const iam = new LinkLedger()
	const { implementation, variables } = intakeApp(world)
	const connection = Database.postgres({ url, schema, max: 2 })
	opened.push(connection)
	const app = bootApp(implementation, {
		environment: environment({ ...frameworkEnvFor(implementation), ...variables, FABRIKA_IAM_APP_ID: APP }),
		workloadTokens: workloadTokensFor(implementation, undefined, ISSUER, APP),
		database: connection,
		membership: iam,
		files: new MemoryFileObjects(),
	})
	const reporter = { report: () => Promise.resolve() }
	return { app, iam, world, run: (clock) => quietly(() => app.jobs.run('intake', { reporter, ...(clock === undefined ? {} : { clock }) })) }
}

function quietly<T>(work: () => Promise<T>): Promise<T> {
	const log = spyOn(console, 'error').mockImplementation(() => {})
	return work().finally(() => log.mockRestore())
}

const ANONYMOUS = { 'Content-Type': 'application/json' }

async function submit(app: ContractApp, path: '/register' | '/resend', body: unknown): Promise<unknown> {
	return resultOf(await send(app, path, { body, headers: ANONYMOUS }))
}

interface CandidateRow {
	readonly id: string
	readonly link_state: string
	readonly link_id: string | null
	readonly sends: number
	readonly verified_at: Date | null
}

async function candidate(email: string): Promise<CandidateRow> {
	const [row] = await admin((sql) =>
		sql.unsafe(`select id, link_state, link_id, sends, verified_at from ${schema}.candidates where email = $1`, [email])
	)
	if (row === undefined) throw new Error(`no candidate ${email}`)
	return row
}

/** The token the proxy would mint from a link key the ledger issued, as IAM binds it. */
async function holderToken(iam: LinkLedger, key: string): Promise<string> {
	const link = iam.links.find((candidate) => candidate.key === key)
	const [object] = link?.chain ?? []
	if (link === undefined || object === undefined) throw new Error(`no link has the key ${key}`)
	const claims: LinkTokenClaims = { mount: 'portal', chain: [...link.chain] }
	return linkToken([grant('candidates.read', object), grant('candidates.verify', object)], claims, APP)
}

/** Exactly one link is live; it is the one recorded on the candidate and the one its last e-mail carries. */
async function deliveredOnce(running: Running, email: string): Promise<void> {
	const row = await candidate(email)
	const live = running.iam.live().filter((link) => link.chain[0]?.value === row.id && running.world.mails.some((mail) => mail.url.endsWith(link.key)))
	expect(live.map((link) => link.id)).toEqual([row.link_id ?? ''])
	expect(row.link_state).toBe('sent')
	expect(running.world.lastKey(email)).toBe(live[0]?.key ?? '')
	// Every other link the job e-mailed is revoked.
	const mailed = running.iam.links.filter((link) => running.world.mails.some((mail) => mail.url.endsWith(`#${link.key}`)))
	expect(mailed.filter((link) => !link.revoked).map((link) => link.id)).toEqual([row.link_id ?? ''])
}

describe.skipIf(!hasPostgres)('a visitor registers and verifies', () => {
	test('a form row becomes one candidate with one e-mailed link of the portal, bound to it', async () => {
		const running = start()
		expect(await submit(running.app, '/register', { email: 'ada@example.test', name: 'Ada' })).toEqual({ received: true })
		// A second registration of the same address answers the same and makes nothing new.
		expect(await submit(running.app, '/register', { email: 'ada@example.test', name: 'Ada L.' })).toEqual({ received: true })
		expect(await running.run()).toEqual({ status: 'succeeded', attempts: 1 })
		const row = await candidate('ada@example.test')
		expect(running.iam.links.map((link) => link.chain)).toEqual([[{ type: 'candidate', value: row.id }]])
		expect(running.world.mails).toEqual([{ to: 'ada@example.test', url: `${ORIGIN}/p/#px_key1` }])
		await deliveredOnce(running, 'ada@example.test')
		expect(await running.run()).toEqual({ status: 'succeeded', attempts: 1 })
		expect(running.world.mails).toHaveLength(1)
	})

	test('the holder verifies twice and verified_at is set once; the credential still reads', async () => {
		const running = start()
		await submit(running.app, '/register', { email: 'bo@example.test', name: 'Bo' })
		await running.run()
		const holder = await holderToken(running.iam, running.world.lastKey('bo@example.test'))
		const first = resultOf(await send(running.app, '/p/api/verify', { token: holder, body: {} }))
		const second = resultOf(await send(running.app, '/p/api/verify', { token: holder, body: {} }))
		expect(second).toEqual(first)
		const row = await candidate('bo@example.test')
		expect(first).toEqual({ verifiedAt: row.verified_at?.toISOString() })
		expect(resultOf(await send(running.app, '/p/api/me', { token: holder, body: {} }))).toEqual({
			name: 'Bo',
			email: 'bo@example.test',
			verified: true,
		})
	})
})

describe.skipIf(!hasPostgres)('a run stopped between two effects is finished by the next', () => {
	for (const step of ['issued', 'recorded', 'mailed'] satisfies DeliveryStep[]) {
		test(`after the link was ${step}`, async () => {
			const running = start()
			await submit(running.app, '/register', { email: `${step}@example.test`, name: step })
			running.world.stopAfter = step
			expect(await running.run()).toMatchObject({ status: 'failed', code: 'handler_failed' })
			expect(await running.run()).toEqual({ status: 'succeeded', attempts: 1 })
			await deliveredOnce(running, `${step}@example.test`)
			// Only a stop after the e-mail left sends a second one; the first link it carried is revoked.
			expect(running.world.mails).toHaveLength(step === 'mailed' ? 2 : 1)
			// A link issued and never recorded was never e-mailed: its key never left the job.
			const orphans = running.iam.live().filter((link) => !running.world.mails.some((mail) => mail.url.endsWith(`#${link.key}`)))
			expect(orphans.map((link) => link.id)).toEqual(step === 'issued' ? ['link-1'] : [])
		})
	}

	test('after the e-mail provider refused the message', async () => {
		const running = start()
		await submit(running.app, '/register', { email: 'refused@example.test', name: 'R' })
		running.world.failSend = true
		expect(await running.run()).toMatchObject({ status: 'failed' })
		expect(await running.run()).toEqual({ status: 'succeeded', attempts: 1 })
		await deliveredOnce(running, 'refused@example.test')
		expect(running.iam.links.map((link) => link.revoked)).toEqual([true, false])
	})

	test('after IAM could not be asked to issue', async () => {
		const running = start()
		await submit(running.app, '/register', { email: 'down@example.test', name: 'D' })
		running.iam.unreachable = true
		expect(await running.run()).toMatchObject({ status: 'failed' })
		expect(running.world.mails).toEqual([])
		expect(await running.run()).toEqual({ status: 'succeeded', attempts: 1 })
		await deliveredOnce(running, 'down@example.test')
	})

	test('after a resend revoked the superseded link', async () => {
		const running = start()
		await submit(running.app, '/register', { email: 'again@example.test', name: 'A' })
		await running.run()
		await submit(running.app, '/resend', { email: 'again@example.test' })
		running.world.stopAfter = 'revoked'
		expect(await running.run()).toMatchObject({ status: 'failed' })
		expect(await running.run()).toEqual({ status: 'succeeded', attempts: 1 })
		await deliveredOnce(running, 'again@example.test')
		expect(running.iam.links.map((link) => link.revoked)).toEqual([true, false])
	})
})

/** Real time, instant backoff; an attempt's deadline (a minute or more) passes only when the test calls `timeOut`. */
function testClock(): { readonly clock: JobClock; timeOut(): void } {
	const deadlines: (() => void)[] = []
	const clock: JobClock = {
		wait: (ms, signal) =>
			new Promise<void>((resolve) => {
				if (ms < 60_000 || signal.aborted) {
					resolve()
					return
				}
				deadlines.push(resolve)
				signal.addEventListener('abort', () => resolve(), { once: true })
			}),
		random: () => 0,
	}
	return { clock, timeOut: () => deadlines.splice(0).forEach((pass) => pass()) }
}

describe.skipIf(!hasPostgres)('an attempt replaced after its deadline', () => {
	test('that resumes after its replacement delivered sends nothing, and the latest e-mail carries the live link', async () => {
		const running = start()
		await submit(running.app, '/register', { email: 'late@example.test', name: 'L' })
		const pause = gate()
		running.world.pauseAfter = { step: 'recorded', gate: pause }
		const { clock, timeOut } = testClock()
		const stale = running.run(clock)
		await pause.reached
		timeOut()
		expect(await stale).toMatchObject({ status: 'failed', code: 'timeout' })
		expect(await running.run()).toEqual({ status: 'succeeded', attempts: 1 })
		pause.open()
		await Bun.sleep(50)
		expect(running.world.mails).toHaveLength(1)
		await deliveredOnce(running, 'late@example.test')
	})

	test('whose e-mail is in flight abandons it before its replacement starts', async () => {
		const running = start()
		await submit(running.app, '/register', { email: 'flight@example.test', name: 'F' })
		const hold = gate()
		running.world.holdSend = hold
		const { clock, timeOut } = testClock()
		const stale = running.run(clock)
		await hold.reached
		timeOut()
		expect(await stale).toMatchObject({ status: 'failed', code: 'timeout' })
		expect(running.world.abandoned).toBe(1)
		expect(await running.run()).toEqual({ status: 'succeeded', attempts: 1 })
		hold.open()
		await Bun.sleep(50)
		expect(running.world.mails).toHaveLength(1)
		await deliveredOnce(running, 'flight@example.test')
	})
})

describe.skipIf(!hasPostgres)('the daily budget', () => {
	test('counts every e-mail a delivery may have sent, and an exhausted one waits for the next window', async () => {
		const running = start()
		await submit(running.app, '/register', { email: 'often@example.test', name: 'O' })
		for (let run = 0; run < SENDS_PER_DAY; run++) {
			running.world.stopAfter = 'mailed'
			expect(await running.run()).toMatchObject({ status: 'failed' })
		}
		expect(running.world.mails).toHaveLength(SENDS_PER_DAY)
		expect(await candidate('often@example.test')).toMatchObject({ link_state: 'issued', sends: SENDS_PER_DAY })
		// The budget is spent: the run sends nothing and leaves the delivery as it was.
		running.world.stopAfter = 'mailed'
		expect(await running.run()).toEqual({ status: 'succeeded', attempts: 1 })
		running.world.stopAfter = null
		expect(running.world.mails).toHaveLength(SENDS_PER_DAY)
		expect(await candidate('often@example.test')).toMatchObject({ link_state: 'issued', sends: SENDS_PER_DAY })

		await admin((sql) => sql.unsafe(`update ${schema}.candidates set window_started_at = now() - interval '2 days' where email = 'often@example.test'`))
		expect(await running.run()).toEqual({ status: 'succeeded', attempts: 1 })
		expect(running.world.mails).toHaveLength(SENDS_PER_DAY + 1)
		expect((await candidate('often@example.test')).sends).toBe(1)
		await deliveredOnce(running, 'often@example.test')
	})
})

describe.skipIf(!hasPostgres)('a resend', () => {
	test('supersedes the sent link of an unverified candidate, within the daily budget, and answers a constant', async () => {
		const running = start()
		await submit(running.app, '/register', { email: 'cy@example.test', name: 'Cy' })
		await running.run()
		for (let resend = 1; resend <= SENDS_PER_DAY; resend++) {
			expect(await submit(running.app, '/resend', { email: 'cy@example.test' })).toEqual({ received: true })
			await running.run()
		}
		// The first e-mail and two resends fill the budget of three; the third resend sends nothing.
		expect(running.world.mails).toHaveLength(SENDS_PER_DAY)
		expect((await candidate('cy@example.test')).sends).toBe(SENDS_PER_DAY)
		await deliveredOnce(running, 'cy@example.test')
	})

	test('of a verified candidate, or of an address nobody registered, sends nothing', async () => {
		const running = start()
		await submit(running.app, '/register', { email: 'di@example.test', name: 'Di' })
		await running.run()
		const holder = await holderToken(running.iam, running.world.lastKey('di@example.test'))
		resultOf(await send(running.app, '/p/api/verify', { token: holder, body: {} }))
		expect(await submit(running.app, '/resend', { email: 'di@example.test' })).toEqual({ received: true })
		expect(await submit(running.app, '/resend', { email: 'nobody@example.test' })).toEqual({ received: true })
		await running.run()
		expect(running.world.mails).toHaveLength(1)
		expect(running.iam.live()).toHaveLength(1)
	})
})
