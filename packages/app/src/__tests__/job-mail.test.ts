// A job that declares `mailer` sends through `ctx.mail`: the test kit's stand-in, the installation's transport
// (`FABRIKA_EMAIL_*`, or the platform's relay) or the application's own (`serve(contract, { mail })`), each key behind
// the application environment's prefix. An installation without a transport (`FABRIKA_EMAIL_PROVIDER=none`) boots, and
// its jobs see mail that is not available; a misconfigured transport does not boot.
// The job runs need FABRIKA_TEST_POSTGRES_URL, since a job's lease lives in @fabrika/db.

import { compileContract, ContractError, defineApp, type FileRef } from '@fabrika/app/contract'
import {
	type ApplicationEnvironment,
	type AppMail,
	BootError,
	type BootOptions,
	CapabilityRefusedError,
	type ContractImplementation,
	EmailDeliveryError,
	type EmailSender,
	type JobClock,
	type OperationsReporter,
	serve,
} from '@fabrika/app/implement'
import { devKit, mailKeyPrefix, MemoryEmailSender, testKit, transportMailKey } from '@fabrika/app/testing'
import { applicationSchema, Database, scoped } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import type { EmailProvider } from '@fabrika/email'
import { resendEmailProvider } from '@fabrika/email/resend'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { HttpError } from '../errors'
import type { OpenedFile } from '../files/handle'
import { jobMail, NO_MAIL, resolveMailTransports } from '../jobs/mail'
import { bootApp, environment, frameworkEnvFor, ISSUER, workloadTokensFor } from './fixtures/implement/harness'
import { tables } from './kit-fixture/src/db/tables'
import { vocabulary } from './kit-fixture/src/vocabulary'
import { migration } from './orm-fixture/migration'

const app = defineApp(vocabulary, tables)
const APP_ID = 'crm@prod'
const LOCAL_ISSUER = 'http://iam.fabrika.localhost:18080'
const SENDER = { FABRIKA_EMAIL_FROM: 'noreply@example.com' }
/** What Control hands a deploy whose installation mailer goes through the platform's relay. */
const PLATFORM = {
	FABRIKA_EMAIL_PROVIDER: 'platform',
	FABRIKA_PLATFORM_MAIL_URL: 'http://control:3000',
	FABRIKA_PLATFORM_MAIL_KEY: 'px_job_mail_secret_5e2d',
}
/** The prefix scope of a deploy of `crm@prod` behind the harness's IAM. */
const DEPLOYED = { issuer: ISSUER, appId: APP_ID }

/** What `notify` sends next. */
const plan: { key: string; signal: AbortSignal | undefined } = { key: 'n-1', signal: undefined }
/** What the jobs saw, for the test to read. */
const seen: { kept: AppMail | null; mayRetry: boolean | null; failure: unknown; quietHasMail: boolean | null } = {
	kept: null,
	mayRetry: null,
	failure: null,
	quietHasMail: null,
}

const notify = app.cron('* * * * *', { actions: ['crm.read'], mailer: 'installation' }).handle(async ({ ctx }) => {
	seen.kept = ctx.mail
	try {
		await ctx.mail.send({ to: 'ada@example.com', subject: 'Welcome aboard', text: 'Hello Ada', idempotencyKey: plan.key }, plan.signal)
	} catch (error) {
		seen.mayRetry = ctx.mail.mayRetry(error)
		seen.failure = error
		throw error
	}
})

const ownNotify = app.cron('* * * * *', { actions: ['crm.read'], mailer: 'own' }).handle(async ({ ctx }) => {
	await ctx.mail.send({ to: 'ada@example.com', subject: 'Your own', text: 'Hello again', idempotencyKey: 'o-1' })
})

const retried = app.cron('* * * * *', { actions: ['crm.read'], mailer: 'installation', retries: 2 }).handle(async ({ ctx }) => {
	await ctx.mail.send({ to: 'ada@example.com', subject: 'Welcome aboard', text: 'Hello Ada', idempotencyKey: 'r-1' })
})

const quiet = app.cron('0 3 * * *', { actions: ['crm.read'] }).handle(({ ctx }) => {
	seen.quietHasMail = 'mail' in ctx
})

/** The keys of the messages an outbox holds, in its order: the recipe leaves them while mail is not available. */
const outbox: string[] = []

const sendOutbox = app.cron('* * * * *', { actions: ['crm.read'], mailer: 'installation' }).handle(async ({ ctx }) => {
	if (!ctx.mail.available) return
	for (const key of [...outbox]) {
		await ctx.mail.send({ to: 'ada@example.com', subject: 'Queued', text: 'Hello Ada', idempotencyKey: key })
		outbox.shift()
	}
})

const contract = app.contract(() => ({ jobs: { notify, ownNotify, quiet } }))
const installationOnly = app.contract(() => ({ jobs: { notify } }))
const noMailer = app.contract(() => ({ jobs: { quiet } }))
const retrying = app.contract(() => ({ jobs: { retried } }))
const outboxContract = app.contract(() => ({ jobs: { sendOutbox } }))

type Own = (env: ApplicationEnvironment) => EmailSender | null

const noOwnTransport: Own = () => null

function served<C extends typeof contract | typeof installationOnly | typeof noMailer | typeof retrying | typeof outboxContract>(
	chosen: C,
	mail?: Own,
): ContractImplementation<C> {
	return serve(chosen, { database: scoped(tables), ...(mail === undefined ? {} : { mail }) })
}

/** A provider that hands out `sender` whatever its variables say. */
function stubProvider(sender: EmailSender): EmailProvider {
	return { variables: [], create: () => sender }
}

function refusals(work: () => unknown): readonly string[] {
	try {
		work()
	} catch (error) {
		if (error instanceof ContractError || error instanceof BootError) return error.problems
		throw error
	}
	return []
}

/** What `work` answered, and every line it wrote to `console[level]`, which it keeps off the test output. */
async function logged<T>(level: 'error' | 'warn', work: () => Promise<T> | T): Promise<{ readonly result: T; readonly lines: string }> {
	const log = spyOn(console, level).mockImplementation(() => {})
	try {
		const result = await work()
		return { result, lines: log.mock.calls.map((call) => call.map(String).join(' ')).join('\n') }
	} finally {
		log.mockRestore()
	}
}

/** Collects what a run reports to Operations. */
function recordingReporter(): { readonly reporter: OperationsReporter; readonly reports: string[] } {
	const reports: string[] = []
	return {
		reports,
		reporter: {
			report: (report) => {
				reports.push(JSON.stringify(report))
				return Promise.resolve()
			},
		},
	}
}

/** Instant backoff; the attempt's deadline passes only when the test calls `pass`. */
function deadlineClock(): { readonly clock: JobClock; pass(): void } {
	const deadlines: (() => void)[] = []
	const clock: JobClock = {
		wait: (_ms, signal) =>
			new Promise<void>((resolve) => {
				if (signal.aborted) {
					resolve()
					return
				}
				deadlines.push(resolve)
				signal.addEventListener('abort', () => resolve(), { once: true })
			}),
		random: () => 0,
	}
	return { clock, pass: () => deadlines.splice(0).forEach((resolve) => resolve()) }
}

/** A retry's backoff passes at once; an attempt's deadline never does. */
const instantBackoff: JobClock = {
	wait: (ms, signal) =>
		new Promise<void>((resolve) => {
			if (ms < 60_000 || signal.aborted) {
				resolve()
				return
			}
			signal.addEventListener('abort', () => resolve(), { once: true })
		}),
	random: () => 0,
}

/** A `during` hook that holds every send until its signal aborts, and says when one is held. */
function holdUntilAborted(): { readonly reached: Promise<void>; readonly hook: (message: unknown, signal: AbortSignal) => Promise<void> } {
	const reached = Promise.withResolvers<void>()
	return {
		reached: reached.promise,
		hook: (_message, signal) =>
			new Promise<void>((_resolve, reject) => {
				reached.resolve()
				signal.addEventListener('abort', () => reject(new Error('held send aborted')), { once: true })
			}),
	}
}

const message = { to: 'ada@example.com', subject: 'Welcome aboard', text: 'Hello Ada', idempotencyKey: 'n-1' }

describe('the key prefix', () => {
	test('is a digest of the installation and the application environment: 41 characters, another of either another prefix', () => {
		expect(mailKeyPrefix(DEPLOYED)).toMatch(/^fabrika:[0-9a-f]{32}:$/)
		expect(mailKeyPrefix({ ...DEPLOYED, appId: 'crm@stage' })).not.toBe(mailKeyPrefix(DEPLOYED))
		expect(mailKeyPrefix({ ...DEPLOYED, appId: 'notes@prod' })).not.toBe(mailKeyPrefix(DEPLOYED))
		expect(mailKeyPrefix({ ...DEPLOYED, issuer: 'https://iam.other.example' })).not.toBe(mailKeyPrefix(DEPLOYED))
		expect(mailKeyPrefix({ ...DEPLOYED, issuer: LOCAL_ISSUER })).not.toBe(mailKeyPrefix(DEPLOYED))
		expect(transportMailKey(DEPLOYED, 'n-1')).toBe(`${mailKeyPrefix(DEPLOYED)}n-1`)
	})
})

describe('attachments', () => {
	const bytes = (size: number): Uint8Array => new Uint8Array(size).fill(0x61)
	const stored: Readonly<Record<string, OpenedFile>> = {
		a: { id: 'a', name: 'report/2026 "final".pdf', type: 'application/pdf', size: 3, bytes: bytes(3) },
		b: { id: 'b', name: null, type: 'text/plain', size: 4, bytes: bytes(4) },
	}
	/** `ctx.files.open` over two stored files: a file over `maxBytes` is refused as open refuses it, any other id as not ready. */
	const open = async (file: unknown, options: { readonly maxBytes: number }): Promise<OpenedFile> => {
		const id: unknown = typeof file === 'object' && file !== null ? Reflect.get(file, 'id') : undefined
		const opened = typeof id === 'string' ? stored[id] : undefined
		if (opened === undefined) throw new HttpError(409, 'file_not_ready', 'The file is not ready yet')
		if (opened.size > options.maxBytes) throw new HttpError(413, 'too_large', 'too large')
		return opened
	}
	const mailOver = (sender: MemoryEmailSender) =>
		jobMail({ transport: { sender, available: true }, keyPrefix: 'p:', signal: new AbortController().signal, assertLive: () => {}, open })
	const refFor = (id: string): FileRef => ({ id, name: null, type: 'text/plain', size: 0, status: 'live' })

	test('reads each file, names it for a header and passes the bytes; no file is none', async () => {
		const sender = new MemoryEmailSender()
		await mailOver(sender).send({ ...message, attachments: ['a', 'b'].map(refFor) })
		expect(sender.accepted[0]?.message.attachments).toEqual([
			{ filename: 'report_2026 _final_.pdf', contentType: 'application/pdf', content: bytes(3) },
			{ filename: 'attachment', contentType: 'text/plain', content: bytes(4) },
		])
		await mailOver(sender).send({ ...message, idempotencyKey: 'n-2', attachments: [] })
		expect(sender.accepted[1]?.message).not.toHaveProperty('attachments')
	})

	test("bounds the bytes together by the transport's limit, and refuses them over a transport that sends none", async () => {
		const small = new MemoryEmailSender({ capabilities: { maxAttachmentBytes: 5 } })
		await expect(mailOver(small).send({ ...message, attachments: ['a', 'b'].map(refFor) })).rejects.toMatchObject({ code: 'invalid_message' })
		const none = new MemoryEmailSender({ capabilities: { maxAttachmentBytes: undefined } })
		await expect(mailOver(none).send({ ...message, attachments: ['a'].map(refFor) })).rejects.toMatchObject({ code: 'invalid_message' })
		expect([small.accepted, none.accepted]).toEqual([[], []])
	})

	test('a file that is not ready refuses the send, and an installation without a transport reads none', async () => {
		const sender = new MemoryEmailSender()
		await expect(mailOver(sender).send({ ...message, attachments: ['pending'].map(refFor) })).rejects.toBeInstanceOf(HttpError)
		const absent = jobMail({ transport: NO_MAIL, keyPrefix: 'p:', signal: new AbortController().signal, assertLive: () => {}, open })
		await expect(absent.send({ ...message, attachments: ['pending'].map(refFor) })).rejects.toMatchObject({ code: 'mail_not_configured' })
	})
})

describe('an installation without a transport', () => {
	test('a local composition gives each mailer job mail that is not available, and says so once per job', async () => {
		const problems: string[] = []
		const { result: transports, lines: warned } = await logged('warn', () =>
			resolveMailTransports({
				artifact: compileContract(contract, tables),
				framework: {},
				application: {},
				own: noOwnTransport,
				standIn: undefined,
				registry: {},
				keyScope: DEPLOYED,
				local: true,
			}, problems))
		expect(problems).toEqual([])
		expect(transports).toMatchObject({ installation: NO_MAIL, own: NO_MAIL })
		expect(warned).toBe([
			"fabrika: job 'notify' sends mail, and this installation has no installation mail transport: ctx.mail.available is false, and every send fails with mail_not_configured",
			"fabrika: job 'ownNotify' sends mail, and this installation has no own mail transport: ctx.mail.available is false, and every send fails with mail_not_configured",
		].join('\n'))
		await expect(NO_MAIL.sender.send(message, new AbortController().signal)).rejects.toMatchObject({
			code: 'mail_not_configured',
			outcome: 'not_sent',
		})
	})

	test("a deployed one states it with FABRIKA_EMAIL_PROVIDER=none, and a mailer job's transport is no mail", async () => {
		const problems: string[] = []
		const { result: transports } = await logged('warn', () =>
			resolveMailTransports({
				artifact: compileContract(installationOnly, tables),
				framework: { FABRIKA_EMAIL_PROVIDER: 'none' },
				application: {},
				own: undefined,
				standIn: undefined,
				registry: {},
				keyScope: DEPLOYED,
				local: false,
			}, problems))
		expect(problems).toEqual([])
		expect(transports.installation).toBe(NO_MAIL)
	})
})

const URL_VARIABLE = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VARIABLE] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) {
	console.warn(`job-mail.test.ts: the job runs skipped; set ${URL_VARIABLE} to run them (a job's lease lives in @fabrika/db)`)
}
const schema = applicationSchema(`jobmail-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
const connections: Database[] = []

async function admin(statement: string): Promise<void> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		await sql.unsafe(statement)
	} finally {
		await sql.close()
	}
}

beforeAll(async () => {
	if (!hasPostgres) return
	const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
	await admin(`create schema ${schema}; set search_path to ${schema}; ${framework} ${migration}`)
})

afterAll(async () => {
	if (!hasPostgres) return
	for (const connection of connections) await connection.close()
	await admin(`drop schema ${schema} cascade`)
})

beforeEach(() => {
	plan.key = 'n-1'
	plan.signal = undefined
	seen.kept = null
	seen.mayRetry = null
	seen.failure = null
	seen.quietHasMail = null
	outbox.length = 0
})

function connection(): Database {
	const opened = Database.postgres({ url, schema, max: 2 })
	connections.push(opened)
	return opened
}

/** Boots `implementation` as a deploy of `crm@prod` would, with `variables` beside the framework's own. */
function deployed(
	implementation: ContractImplementation,
	variables: Readonly<Record<string, string>>,
	options: Partial<BootOptions> = {},
	issuer = ISSUER,
) {
	return bootApp(implementation, {
		environment: environment({ ...frameworkEnvFor(implementation), FABRIKA_IAM_APP_ID: APP_ID, FABRIKA_IAM_ISSUER: issuer, ...variables }),
		workloadTokens: workloadTokensFor(implementation, undefined, issuer, APP_ID),
		database: connection(),
		...options,
	})
}

describe.skipIf(!hasPostgres)("the test kit's mail stand-in", () => {
	test("mail: 'none' models an installation without a transport, and a queued message leaves once one is added", async () => {
		outbox.push('q-1', 'q-2')
		const none = testKit(served(outboxContract), { database: connection(), mail: 'none' })
		const { result } = await logged('warn', () => none.runJob('sendOutbox'))
		expect(result).toEqual({ status: 'succeeded', attempts: 1 })
		expect(outbox).toEqual(['q-1', 'q-2'])
		expect(none.mail.handoffs).toEqual([])

		const added = testKit(served(outboxContract), { database: connection() })
		expect(await added.runJob('sendOutbox')).toEqual({ status: 'succeeded', attempts: 1 })
		expect(outbox).toEqual([])
		expect(added.mail.accepted.map((accepted) => accepted.message.idempotencyKey)).toEqual(
			['q-1', 'q-2'].map((key) => transportMailKey(added.mailKeyScope, key)),
		)
	})

	test('takes the message under the prefixed key; a job without mailer has no ctx.mail', async () => {
		const kit = testKit(served(contract, noOwnTransport), { database: connection() })
		expect(await kit.runJob('notify')).toEqual({ status: 'succeeded', attempts: 1 })
		expect(kit.mail.accepted.map((accepted) => accepted.message)).toEqual([{ ...message, idempotencyKey: transportMailKey(kit.mailKeyScope, 'n-1') }])
		expect(kit.mail.accepted[0]?.message.idempotencyKey.startsWith(mailKeyPrefix(kit.mailKeyScope))).toBe(true)
		expect(await kit.runJob('quiet')).toEqual({ status: 'succeeded', attempts: 1 })
		expect(seen.quietHasMail).toBe(false)
	})

	test.each([
		{ name: 'longer than 200 characters', key: 'k'.repeat(201) },
		{ name: 'with a space', key: 'n 1' },
	])('a key $name is refused before the transport sees it', async ({ key }) => {
		const kit = testKit(served(contract, noOwnTransport), { database: connection() })
		plan.key = key
		await logged('error', async () => {
			expect(await kit.runJob('notify')).toEqual({ status: 'failed', attempts: 1, code: 'mail_failed', reason: 'invalid_message' })
		})
		expect(kit.mail.handoffs).toEqual([])
	})

	test('a refusal fails the run with its code; no log line and no report holds the message or its key', async () => {
		const kit = testKit(served(contract, noOwnTransport), { database: connection() })
		const { reporter, reports } = recordingReporter()
		kit.mail.refuse('provider_unauthorized')
		plan.key = 'welcome-ada-7'
		const { lines } = await logged('error', async () => {
			expect(await kit.runJob('notify', { reporter })).toEqual({ status: 'failed', attempts: 1, code: 'mail_failed', reason: 'provider_unauthorized' })
		})
		expect(lines).toContain('mail_failed: provider_unauthorized: the transport did not send the message')
		expect(reports).toHaveLength(1)
		// ADR-0059 attaches what a handler threw; a delivery error stays a code and a fixed text.
		expect(reports[0]).not.toContain('"error":')
		for (const text of [lines, ...reports]) {
			for (const secret of ['Welcome aboard', 'Hello Ada', 'ada@example.com', 'welcome-ada-7', mailKeyPrefix(kit.mailKeyScope)]) {
				expect(text).not.toContain(secret)
			}
		}
	})

	test('mayRetry: a lost answer only over an idempotent transport, a rate limit over any', async () => {
		const verdict = async (mail: MemoryEmailSender, fault: (mail: MemoryEmailSender) => void): Promise<boolean | null> => {
			const kit = testKit(served(contract, noOwnTransport), { database: connection(), mail })
			fault(kit.mail)
			await logged('error', () => kit.runJob('notify'))
			return seen.mayRetry
		}
		const queued = () => new MemoryEmailSender({ capabilities: { idempotent: false, confirmation: 'queued' } })
		expect(await verdict(new MemoryEmailSender(), (mail) => mail.loseAnswers(1))).toBe(true)
		expect(await verdict(queued(), (mail) => mail.loseAnswers(1))).toBe(false)
		expect(await verdict(queued(), (mail) => mail.refuse('rate_limited'))).toBe(true)
	})

	test.each([
		{ fault: 'a lost answer', apply: (mail: MemoryEmailSender) => mail.loseAnswers(1), reason: 'network_error' },
		{ fault: 'a refusal', apply: (mail: MemoryEmailSender) => mail.refuse(), reason: 'provider_rejected' },
	])('$fault over a non-idempotent transport is not sent again by a retry', async ({ apply, reason }) => {
		const mail = new MemoryEmailSender({ capabilities: { idempotent: false, confirmation: 'queued' } })
		const kit = testKit(served(retrying), { database: connection(), mail })
		apply(kit.mail)
		const { result } = await logged('error', () => kit.runJob('retried', { clock: instantBackoff }))
		expect(result).toEqual({ status: 'failed', attempts: 1, code: 'mail_failed', reason })
		expect(kit.mail.handoffs).toHaveLength(1)
	})

	test('a lost answer over an idempotent transport is retried under the same key, and delivered once', async () => {
		const kit = testKit(served(retrying), { database: connection() })
		kit.mail.loseAnswers(1)
		const { result } = await logged('error', () => kit.runJob('retried', { clock: instantBackoff }))
		expect(result).toEqual({ status: 'succeeded', attempts: 2 })
		expect(kit.mail.handoffs.map((handoff) => [handoff.answer, handoff.taken])).toEqual([['network_error', true], ['accepted', false]])
		expect(kit.mail.accepted).toHaveLength(1)
	})

	test("the attempt's deadline aborts a send in flight", async () => {
		const kit = testKit(served(contract, noOwnTransport), { database: connection() })
		const held = holdUntilAborted()
		const deadline = deadlineClock()
		kit.mail.during(held.hook)
		await logged('error', async () => {
			const run = kit.runJob('notify', { clock: deadline.clock })
			await held.reached
			deadline.pass()
			expect(await run).toEqual({ status: 'failed', attempts: 1, code: 'timeout' })
		})
		expect(kit.mail.handoffs.map((handoff) => handoff.answer)).toEqual(['aborted'])
	})

	test("the job's own signal aborts a send before the deadline", async () => {
		const kit = testKit(served(contract, noOwnTransport), { database: connection() })
		const held = holdUntilAborted()
		const caller = new AbortController()
		plan.signal = caller.signal
		kit.mail.during(held.hook)
		await logged('error', async () => {
			const run = kit.runJob('notify')
			await held.reached
			caller.abort()
			expect(await run).toEqual({ status: 'failed', attempts: 1, code: 'mail_failed', reason: 'aborted' })
		})
		expect(kit.mail.handoffs.map((handoff) => handoff.answer)).toEqual(['aborted'])
	})

	test('ctx.mail kept past its attempt sends nothing', async () => {
		const kit = testKit(served(contract, noOwnTransport), { database: connection() })
		expect(await kit.runJob('notify')).toEqual({ status: 'succeeded', attempts: 1 })
		await expect(seen.kept?.send({ ...message, idempotencyKey: 'late-1' }) ?? Promise.resolve()).rejects.toBeInstanceOf(CapabilityRefusedError)
		expect(kit.mail.handoffs).toHaveLength(1)
	})

	test("devKit's mails: each handoff with its key as the job passed it, its answer and its outcome", async () => {
		const dev = devKit(served(contract, noOwnTransport), { database: connection() })
		expect(await dev.kit.runJob('notify')).toEqual({ status: 'succeeded', attempts: 1 })
		dev.kit.mail.refuse()
		plan.key = 'n-2'
		await logged('error', () => dev.kit.runJob('notify'))
		const [first, second, ...rest] = dev.mails()
		expect(rest).toEqual([])
		expect(first).toEqual({
			id: 1,
			at: expect.any(String),
			to: 'ada@example.com',
			subject: 'Welcome aboard',
			text: 'Hello Ada',
			html: null,
			replyTo: null,
			fromName: null,
			key: 'n-1',
			transportKey: transportMailKey(dev.kit.mailKeyScope, 'n-1'),
			answer: 'accepted',
			outcome: 'accepted',
			delivered: true,
		})
		expect(second).toMatchObject({ id: 2, key: 'n-2', answer: 'provider_rejected', outcome: 'not_sent', delivered: false })
	})
})

describe.skipIf(!hasPostgres)('the transports of a deployed application', () => {
	test("the application's own: built once from its own variables, and given the prefixed key", async () => {
		const own = new MemoryEmailSender()
		const installation = new MemoryEmailSender()
		const built: ApplicationEnvironment[] = []
		const deployment = deployed(
			served(contract, (env) => {
				built.push(env)
				return own
			}),
			{ ...SENDER, FABRIKA_EMAIL_PROVIDER: 'stub', MAIL_TOKEN: 'app-own' },
			{ emailProviders: { stub: stubProvider(installation) } },
		)
		expect(await deployment.jobs.run('ownNotify')).toEqual({ status: 'succeeded', attempts: 1 })
		expect(await deployment.jobs.run('notify')).toEqual({ status: 'succeeded', attempts: 1 })
		expect(built).toEqual([{ MAIL_TOKEN: 'app-own' }])
		expect(own.accepted.map((accepted) => accepted.message.idempotencyKey)).toEqual([transportMailKey(DEPLOYED, 'o-1')])
		expect(installation.accepted.map((accepted) => accepted.message.idempotencyKey)).toEqual([transportMailKey(DEPLOYED, 'n-1')])
	})

	test("an own transport's own error fails the run as provider_unavailable, and its message reaches no log and no report", async () => {
		const leaking: EmailSender = {
			capabilities: { idempotent: true, confirmation: 'sync', maxBatch: 1 },
			send: () => Promise.reject(new Error('sk_live_secret')),
		}
		const deployment = deployed(served(contract, () => leaking), { ...SENDER, FABRIKA_EMAIL_PROVIDER: 'stub' }, {
			emailProviders: { stub: stubProvider(new MemoryEmailSender()) },
		})
		const { reporter, reports } = recordingReporter()
		const { result, lines } = await logged('error', () => deployment.jobs.run('ownNotify', { reporter }))
		expect(result).toEqual({ status: 'failed', attempts: 1, code: 'mail_failed', reason: 'provider_unavailable' })
		expect(reports).toHaveLength(1)
		for (const text of [lines, ...reports]) expect(text).not.toContain('sk_live_secret')
	})

	test("the installation's Resend sends the prefixed key as its Idempotency-Key", async () => {
		const keys: (string | null)[] = []
		const resend: EmailProvider = {
			variables: resendEmailProvider.variables,
			create: (input) =>
				resendEmailProvider.create({
					...input,
					fetch: (_url, init) => {
						keys.push(new Headers(init?.headers).get('Idempotency-Key'))
						return Promise.resolve(Response.json({ id: 're_1' }))
					},
				}),
		}
		const deployment = deployed(
			served(installationOnly),
			{ ...SENDER, FABRIKA_EMAIL_PROVIDER: 'resend', FABRIKA_EMAIL_RESEND_API_KEY: 're_test_key' },
			{
				emailProviders: { resend },
			},
		)
		expect(await deployment.jobs.run('notify')).toEqual({ status: 'succeeded', attempts: 1 })
		expect(keys).toEqual([transportMailKey(DEPLOYED, 'n-1')])
	})

	test('a mailer without a usable transport does not boot', () => {
		const ownBuilt = (sender: EmailSender | null): Own => () => sender
		const failingOwn: Own = () => {
			throw new EmailDeliveryError('Own provider key is missing', { code: 'invalid_configuration' })
		}
		const noBatch: EmailSender = {
			capabilities: { idempotent: true, confirmation: 'sync', maxBatch: 0 },
			send: (sent, signal) => new MemoryEmailSender().send(sent, signal),
		}
		const installation = { ...SENDER, FABRIKA_EMAIL_PROVIDER: 'stub' }
		const stub = { emailProviders: { stub: stubProvider(new MemoryEmailSender()) } }
		expect(refusals(() => deployed(served(contract), installation, stub))).toEqual([
			"job 'ownNotify' declares mailer: 'own', and serve(contract, { … }) has no mail: pass mail: (env) => EmailSender",
		])
		expect(refusals(() => deployed(served(installationOnly, ownBuilt(new MemoryEmailSender())), installation, stub))).toEqual([
			"serve(contract, { mail }) builds a transport no job uses: declare mailer: 'own' on the job that sends, or remove mail",
		])
		expect(refusals(() => deployed(served(contract, ownBuilt(new MemoryEmailSender())), {}))).toEqual([
			"job 'notify' declares mailer: 'installation', and FABRIKA_EMAIL_PROVIDER is not set: Control writes it when it deploys the application (none for an installation without a transport)",
		])
		expect(refusals(() => deployed(served(contract, ownBuilt(null)), installation, stub))).toEqual([
			"job 'ownNotify' declares mailer: 'own', and serve's mail built no transport from the application's variables",
		])
		expect(refusals(() => deployed(served(contract, failingOwn), installation, stub))).toEqual([
			"serve's mail: Own provider key is missing",
		])
		expect(refusals(() => deployed(served(contract, ownBuilt(noBatch)), installation, stub))).toEqual([
			"serve's mail returned no EmailSender (capabilities and send(message, signal))",
		])
	})

	test("the installation's misconfigured transport names its variables and never a value, local or not", () => {
		const resend = { ...SENDER, FABRIKA_EMAIL_PROVIDER: 'resend' }
		for (const issuer of [ISSUER, LOCAL_ISSUER]) {
			const problems = refusals(() => deployed(served(installationOnly), resend, {}, issuer))
			expect(problems).toEqual(["the installation's mail transport: Email configuration is invalid: FABRIKA_EMAIL_RESEND_API_KEY is missing"])
		}
		const keyed = { ...resend, FABRIKA_EMAIL_RESEND_API_KEY: 're key with spaces' }
		const problems = refusals(() => deployed(served(installationOnly), keyed))
		expect(problems).toEqual(["the installation's mail transport: Email configuration is invalid: FABRIKA_EMAIL_RESEND_API_KEY is missing or invalid"])
		expect(problems.join('\n')).not.toContain('re key with spaces')
	})

	test('a local composition boots without a transport, and every send fails with mail_not_configured', async () => {
		const { result: deployment, lines: warned } = await logged('warn', () => deployed(served(contract, noOwnTransport), {}, {}, LOCAL_ISSUER))
		expect(warned).toContain(
			"fabrika: job 'notify' sends mail, and this installation has no installation mail transport: ctx.mail.available is false",
		)
		const { result } = await logged('error', () => deployment.jobs.run('notify'))
		expect(result).toEqual({ status: 'failed', attempts: 1, code: 'mail_failed', reason: 'mail_not_configured' })
	})

	test('an installation without a transport boots; its mail is not available, and a send fails not_sent with mail_not_configured', async () => {
		const { result: deployment } = await logged('warn', () => deployed(served(installationOnly), { FABRIKA_EMAIL_PROVIDER: 'none' }))
		const { result } = await logged('error', () => deployment.jobs.run('notify'))
		expect(result).toEqual({ status: 'failed', attempts: 1, code: 'mail_failed', reason: 'mail_not_configured' })
		expect(seen.kept?.available).toBe(false)
		expect(seen.failure).toBeInstanceOf(EmailDeliveryError)
		expect(seen.failure).toMatchObject({ code: 'mail_not_configured', outcome: 'not_sent', retryable: false })
		expect(seen.mayRetry).toBe(false)
	})

	test('a provider named with a missing credential still does not boot beside the explicit none', () => {
		expect(refusals(() => deployed(served(installationOnly), { FABRIKA_EMAIL_PROVIDER: 'resend' }))).toEqual([
			"the installation's mail transport: Email configuration is invalid: FABRIKA_EMAIL_FROM is missing; FABRIKA_EMAIL_RESEND_API_KEY is missing",
		])
	})

	test("a local composition's own providers are named only there", async () => {
		const local = new MemoryEmailSender()
		const options = { localEmailProviders: { 'local-stub': stubProvider(local) } }
		const variables = { ...SENDER, FABRIKA_EMAIL_PROVIDER: 'local-stub' }
		const deployment = deployed(served(installationOnly), variables, options, LOCAL_ISSUER)
		expect(await deployment.jobs.run('notify')).toEqual({ status: 'succeeded', attempts: 1 })
		expect(local.accepted).toHaveLength(1)
		expect(refusals(() => deployed(served(installationOnly), variables, options))).toEqual([
			"the installation's mail transport: FABRIKA_EMAIL_PROVIDER must be none or one of: resend, smartemailing",
		])
	})

	test("the platform's relay: posted under the bearer key with the prefixed key, queued, and no FABRIKA_EMAIL_FROM", async () => {
		const requests: Request[] = []
		// Stubbed before boot, so the job's egress guard wraps it and the relay call passes as the platform's.
		const relay = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
			requests.push(new Request(input, init))
			return Response.json({ status: 'accepted', messageId: 'relay-1' })
		}, { preconnect: fetch.preconnect }))
		try {
			const deployment = deployed(served(installationOnly), PLATFORM)
			expect(await deployment.jobs.run('notify')).toEqual({ status: 'succeeded', attempts: 1 })
		} finally {
			relay.mockRestore()
		}
		expect(seen.kept?.available).toBe(true)
		expect(seen.kept?.capabilities.confirmation).toBe('queued')
		expect(requests.map((request) => request.url)).toEqual(['http://control:3000/platform/mail/send'])
		const [request] = requests
		expect(request?.headers.get('authorization')).toBe(`Bearer ${PLATFORM.FABRIKA_PLATFORM_MAIL_KEY}`)
		expect(await request?.json()).toMatchObject({ to: 'ada@example.com', idempotencyKey: transportMailKey(DEPLOYED, 'n-1') })
	})

	test("the platform's relay without its key or with a URL that is no origin does not boot, and no problem holds a value", () => {
		const { FABRIKA_PLATFORM_MAIL_KEY: key, ...keyless } = PLATFORM
		expect(refusals(() => deployed(served(installationOnly), keyless))).toEqual([
			"the installation's mail transport: Email configuration is invalid: FABRIKA_PLATFORM_MAIL_KEY is missing",
		])
		expect(refusals(() => deployed(served(installationOnly), { FABRIKA_EMAIL_PROVIDER: 'platform' }))).toEqual([
			"the installation's mail transport: Email configuration is invalid: FABRIKA_PLATFORM_MAIL_URL is missing; FABRIKA_PLATFORM_MAIL_KEY is missing",
		])
		const pathed = { ...PLATFORM, FABRIKA_PLATFORM_MAIL_URL: 'http://control:3000/relay-path' }
		const problems = refusals(() => deployed(served(installationOnly), pathed))
		expect(problems).toEqual([
			"the installation's mail transport: Email configuration is invalid: FABRIKA_PLATFORM_MAIL_URL or FABRIKA_PLATFORM_MAIL_KEY is invalid (Platform mail URL is not an http(s) origin)",
		])
		for (const value of ['relay-path', key]) expect(problems.join('\n')).not.toContain(value)
	})

	test('a contract without a mailer job reads no FABRIKA_EMAIL_*', async () => {
		const deployment = deployed(served(noMailer), { FABRIKA_EMAIL_PROVIDER: 'carrier-pigeon' })
		expect(await deployment.jobs.run('quiet')).toEqual({ status: 'succeeded', attempts: 1 })
	})
})
