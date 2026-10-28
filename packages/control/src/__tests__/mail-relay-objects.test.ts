// The relay on the Worker's storage: a D1 row holds at most 2,000,000 bytes, so every message keeps its content in an
// object its row names (`MailMessageRepository` with `objects`). The harness's SQLite gets D1's row limit as a trigger,
// so a message that would only fit Postgres fails here as it fails on D1.

import type { EmailMessage } from '@fabrika/email'
import { MemoryEmailSender } from '@fabrika/email/memory'
import { encodePlatformMailRequest, hashPlatformKey, parsePlatformMailAnswer } from '@fabrika/email/platform'
import type { JobQueue, SqlDatabase } from '@fabrika/platform'
import { MemoryBlobs } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { type ControlRepositories, createControlRepositories, MAIL_CONTENT_UPLOAD_GRACE_S } from '../db'
import type { Env } from '../env'
import { dispatchMail } from '../mail-relay/dispatch'
import { handleMailRelay } from '../mail-relay/handler'
import { runMailMaintenance } from '../mail-relay/maintenance'
import { type MailDispatchMessage, mayRequeueMail, requeueMailMessage } from '../mail-relay/queue'
import { createHarness, type Harness } from './helpers/harness'
import { fakeControlProvider } from './helpers/provider'
import { unusedSourceConnection } from './helpers/source-connection'

const APP_KEY = `px_${'b'.repeat(40)}`
const NOW = Math.floor(Date.now() / 1000)
const D1_ROW_LIMIT_BYTES = 2_000_000
const ATTACHMENT = new Uint8Array(2_500_000).map((_, index) => index % 251)

const LARGE: EmailMessage = {
	to: 'ada@example.com',
	subject: 'The quarterly report',
	text: 'Attached.',
	idempotencyKey: 'report:1',
	attachments: [{ filename: 'report.pdf', contentType: 'application/pdf', content: ATTACHMENT }],
}

interface Worker {
	harness: Harness
	repositories: ControlRepositories
	objects: MemoryBlobs
	jobs: MailDispatchMessage[]
	sender: MemoryEmailSender
	send(body?: string): Promise<Response>
	dispatch(id: string): ReturnType<typeof dispatchMail>
	uploads(): number
}

/** D1 refuses a row over its limit; SQLite would store it, so the harness refuses it the same way. */
function withD1RowLimit(harness: Harness): void {
	for (const event of ['INSERT', 'UPDATE']) {
		harness.sqlite.exec(`
			CREATE TRIGGER mail_messages_d1_row_limit_${event.toLowerCase()} BEFORE ${event} ON mail_messages
			WHEN length(CAST(NEW.content AS BLOB)) > ${D1_ROW_LIMIT_BYTES}
			BEGIN SELECT RAISE(ABORT, 'string or blob too big: SQLITE_TOOBIG'); END
		`)
	}
}

async function worker(options: { objects?: boolean; d1?: (d1: SqlDatabase) => SqlDatabase } = {}): Promise<Worker> {
	const harness = createHarness()
	withD1RowLimit(harness)
	const objects = new MemoryBlobs()
	const d1 = options.d1?.(harness.d1) ?? harness.d1
	const repositories = createControlRepositories(d1, options.objects === false ? {} : { mailContent: objects })
	await harness.repositories.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
	await harness.repositories.registry.upsertAppEnv({
		appId: 'notes',
		env: 'prod',
		namespaceId: null,
		provider: 'test',
		providerTargetJson: '{}',
		providerArtifactJson: '{}',
	})
	await harness.repositories.platformTransportKeys.insert({
		app_id: 'notes',
		env: 'prod',
		receiver: 'mail',
		key_id: 'k1',
		key_hash: await hashPlatformKey(APP_KEY),
		value_ref: 'vault:platform:platform-key:notes@prod:mail',
		expires_at: NOW + 3600,
		created_at: NOW,
	})
	const jobs: MailDispatchMessage[] = []
	const queue: JobQueue<MailDispatchMessage> = {
		send(message) {
			jobs.push(message)
			return Promise.resolve()
		},
	}
	const sender = new MemoryEmailSender()
	const env: Env = {
		DB: d1,
		REPOSITORIES: repositories,
		ASSETS: { fetch: () => Promise.resolve(new Response('dashboard')) },
		RUN_LOGS: { put: () => Promise.resolve(), get: () => Promise.resolve(null), delete: () => Promise.resolve() },
		DEPLOY_QUEUE: { send: () => Promise.resolve() },
		WAIT_UNTIL: () => {},
		ENVIRONMENT: 'local',
		MAIL_TRANSPORT: { kind: 'transport', transport: { variables: {}, secretNames: new Set() } },
		MAIL_RELAY: { queue, iamKeyHash: null, sender },
	}
	return {
		harness,
		repositories,
		objects,
		jobs,
		sender,
		send: (body = encodePlatformMailRequest(LARGE)) => {
			const request = new Request('http://control:3000/platform/mail/send', {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${APP_KEY}` },
				body,
			})
			return handleMailRelay({ env, provider: fakeControlProvider, sourceConnection: unusedSourceConnection('harbor'), request })
		},
		dispatch: (id) => dispatchMail({ messages: repositories.mailMessages, queue, sender, now: () => NOW }, { messageId: id }),
		uploads: () => harness.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM mail_content_uploads').get()?.n ?? 0,
	}
}

async function reply(response: Response): Promise<ReturnType<typeof parsePlatformMailAnswer>> {
	const body: unknown = await response.json()
	return parsePlatformMailAnswer(response.status, body)
}

async function acceptedId(response: Response): Promise<string> {
	const answer = await reply(response)
	if (answer === null || !('messageId' in answer)) throw new Error(`not accepted: ${JSON.stringify(answer)}`)
	return answer.messageId
}

describe('the relay on the Worker: content over the D1 row limit', () => {
	test('the harness refuses what D1 refuses: without an object store the message is not recorded', async () => {
		const w = await worker({ objects: false })
		expect(encodePlatformMailRequest(LARGE).length).toBeGreaterThan(D1_ROW_LIMIT_BYTES)
		expect(await reply(await w.send())).toEqual({ error: { code: 'provider_unavailable' } })
		expect(await w.repositories.mailMessages.list({ limit: 10 })).toEqual([])
	})

	test('a message over 2 MB records into an object and dispatches with its attachment intact', async () => {
		const w = await worker()
		const id = await acceptedId(await w.send())
		const row = await w.repositories.mailMessages.get(id)
		expect(row).toMatchObject({ state: 'queued', content: null, content_ref: `messages/${id}.json` })
		expect([...w.objects.values.keys()]).toEqual([`messages/${id}.json`])
		expect(w.uploads()).toBe(0)
		expect(w.jobs).toEqual([{ messageId: id }])

		expect(await w.dispatch(id)).toEqual({ status: 'sent' })
		const [sent] = w.sender.accepted
		expect(sent?.message.attachments?.[0]?.content).toEqual(ATTACHMENT)
		expect(sent?.message.to).toBe('ada@example.com')
	})

	test('a repeated key keeps one object, and a conflicting one leaves none behind', async () => {
		const w = await worker()
		const id = await acceptedId(await w.send())
		expect(await acceptedId(await w.send())).toBe(id)
		const conflicting = encodePlatformMailRequest({ ...LARGE, subject: 'Another report' })
		expect(await reply(await w.send(conflicting))).toEqual({ error: { code: 'idempotency_conflict' } })
		expect([...w.objects.values.keys()]).toEqual([`messages/${id}.json`])
		expect(w.uploads()).toBe(0)
	})

	test('a failed message requeues and sends from its object; retention removes the object with its row content', async () => {
		const w = await worker()
		const id = await acceptedId(await w.send())
		w.sender.refuse('provider_rejected')
		expect(await w.dispatch(id)).toMatchObject({ status: 'failed' })
		const failed = await w.repositories.mailMessages.get(id)
		if (failed === null) throw new Error('the message is gone')
		expect(mayRequeueMail(failed, w.sender)).toBe(true)

		const sender = new MemoryEmailSender()
		expect(await requeueMailMessage({ messages: w.repositories.mailMessages, queue: { send: () => Promise.resolve() }, sender }, id, 'admin', NOW))
			.toBe(true)
		expect(
			await dispatchMail({ messages: w.repositories.mailMessages, queue: { send: () => Promise.resolve() }, sender, now: () => NOW }, { messageId: id }),
		).toEqual(
			{ status: 'sent' },
		)
		expect(sender.accepted).toHaveLength(1)

		const sent = await w.repositories.mailMessages.get(id)
		if (sent === null) throw new Error('the message is gone')
		expect(await w.repositories.mailMessages.content(sent)).toBe(encodePlatformMailRequest(LARGE))
		const summary = await runMailMaintenance({ messages: w.repositories.mailMessages, now: NOW + 31 * 24 * 60 * 60 })
		expect(summary).toEqual({ requeued: 0, purged: 1, collected: 0 })
		const purged = await w.repositories.mailMessages.get(id)
		expect(purged).toMatchObject({ content: null, content_ref: null })
		expect(w.objects.values.size).toBe(0)
	})

	test('an object whose row never committed is collected after the grace, and one a row names is kept', async () => {
		const unavailable = await worker({
			d1: (d1) => ({ prepare: (sql) => d1.prepare(sql), batch: () => Promise.reject(new Error('D1 is unavailable')) }),
		})
		expect(await reply(await unavailable.send())).toEqual({ error: { code: 'provider_unavailable' } })
		expect(unavailable.objects.values.size).toBe(1)
		expect(unavailable.uploads()).toBe(1)
		expect(await unavailable.repositories.mailMessages.collectUploads(NOW - MAIL_CONTENT_UPLOAD_GRACE_S)).toBe(0)
		expect(await unavailable.repositories.mailMessages.collectUploads(NOW + MAIL_CONTENT_UPLOAD_GRACE_S)).toBe(1)
		expect(unavailable.objects.values.size).toBe(0)
		expect(unavailable.uploads()).toBe(0)

		// The batch committed and its answer was lost: the row names the object, so only the upload record goes.
		const lostAnswer = await worker({
			d1: (d1) => ({
				prepare: (sql) => d1.prepare(sql),
				batch: async (statements) => {
					await d1.batch(statements)
					throw new Error('the answer was lost')
				},
			}),
		})
		expect(await reply(await lostAnswer.send())).toEqual({ error: { code: 'provider_unavailable' } })
		expect(await lostAnswer.repositories.mailMessages.collectUploads(NOW + MAIL_CONTENT_UPLOAD_GRACE_S)).toBe(0)
		const [row] = await lostAnswer.repositories.mailMessages.list({ limit: 10 })
		if (row === undefined) throw new Error('the committed row is gone')
		expect(await lostAnswer.repositories.mailMessages.content(row)).toBe(encodePlatformMailRequest(LARGE))
		expect(lostAnswer.uploads()).toBe(0)
	})
})
