import type { IngestMessage } from '@fabrika/operations-contract/ingest'
import type { JobQueue } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { provisionSourceIngest, rotateSourceIngestCredential } from '../credentials.js'
import { handleDirectIngestRequest, MAX_ENVELOPE_EVENT_ITEMS, MAX_INGEST_BODY_BYTES } from '../direct-ingest.js'
import { createSqliteOperationsRepositories, SourcesRepository } from '../repositories.js'
import { buildSentryEnvelope } from '../testing.js'
import { createHarness } from './helpers/sqlite.js'

const PUBLIC_KEY = '0123456789abcdef0123456789abcdef'
const OTHER_KEY = 'abcdef0123456789abcdef0123456789'
const INGEST_PROJECT_ID = '123456789012345678'
const ENDPOINT = `https://operations.test/api/${INGEST_PROJECT_ID}/envelope/`

class MemoryQueue implements JobQueue<IngestMessage> {
	readonly messages: IngestMessage[] = []
	fail = false

	send(message: IngestMessage): Promise<void> {
		if (this.fail) return Promise.reject(new Error(`queue rejected ${PUBLIC_KEY}`))
		this.messages.push(message)
		return Promise.resolve()
	}
}

class FailingCredentialSources extends SourcesRepository {
	override resolveIngestCredential(): Promise<never> {
		return Promise.reject(new Error(`database failed near ${PUBLIC_KEY}`))
	}
}

async function setup(now: () => number = () => 1_000): Promise<{
	harness: ReturnType<typeof createHarness>
	queue: MemoryQueue
	outcomes: unknown[]
	options: Parameters<typeof handleDirectIngestRequest>[1]
}> {
	const harness = createHarness(now)
	await harness.repositories.sources.upsert({
		id: 'source-uuid',
		appId: 'notes',
		environment: 'production',
		displayName: 'Notes',
		enabled: true,
	})
	await provisionSourceIngest(
		harness.repositories,
		{ sourceId: 'source-uuid', operationsOrigin: 'https://operations.test' },
		{ now, publicKey: () => PUBLIC_KEY, ingestProjectId: () => INGEST_PROJECT_ID },
	)
	const queue = new MemoryQueue()
	const outcomes: unknown[] = []
	return {
		harness,
		queue,
		outcomes,
		options: {
			repositories: harness.repositories,
			queue,
			now,
			onOutcome: (outcome) => outcomes.push(outcome),
		},
	}
}

function envelope(value = 'broken', extra: Record<string, unknown> = {}): string {
	const base = buildSentryEnvelope({
		type: 'TypeError',
		value,
		eventId: 'a'.repeat(32),
		frames: [{ function: 'render', module: 'notes', inApp: true }],
	})
	if (Object.keys(extra).length === 0) return base
	const lines = base.trimEnd().split('\n')
	const payload = JSON.parse(lines[2] ?? '{}')
	return `${lines[0]}\n${lines[1]}\n${JSON.stringify({ ...payload, ...extra })}\n`
}

function request(input: {
	url?: string
	body?: BodyInit
	method?: string
	key?: string | null
	headerKey?: string
	headers?: HeadersInit
} = {}): Request {
	const key = input.key === undefined ? PUBLIC_KEY : input.key
	const url = new URL(input.url ?? ENDPOINT)
	if (key !== null) {
		url.searchParams.set('sentry_version', '7')
		url.searchParams.set('sentry_key', key)
		url.searchParams.set('sentry_client', 'sentry.javascript.browser/9.0.0')
	}
	const headers = new Headers(input.headers)
	if (!headers.has('content-type')) headers.set('content-type', 'text/plain;charset=UTF-8')
	if (input.headerKey !== undefined) {
		headers.set('x-sentry-auth', `Sentry sentry_version=7, sentry_client=test/1.0, sentry_key=${input.headerKey}`)
	}
	return new Request(url, {
		method: input.method ?? 'POST',
		headers,
		body: input.body ?? envelope(),
	})
}

function multiEventEnvelope(count: number, includeIgnored = false): string {
	const sample = envelope().trimEnd().split('\n')
	const envelopeHeader = sample[0] ?? '{}'
	const itemHeader = sample[1] ?? '{"type":"event"}'
	const payload = sample[2] ?? '{}'
	let body = `${envelopeHeader}\n`
	if (includeIgnored) body += `${JSON.stringify({ type: 'client_report', length: 2 })}\n{}\n`
	for (let index = 0; index < count; index++) {
		body += `${itemHeader}\n${JSON.stringify({ ...JSON.parse(payload), event_id: index.toString(16).padStart(32, '0') })}\n`
	}
	return body
}

describe('direct Sentry-compatible ingest', () => {
	test('accepts the official SDK query-auth shape and binds the numeric path to the source UUID', async () => {
		const { queue, outcomes, options } = await setup()
		const response = await handleDirectIngestRequest(request(), options)
		expect(response.status).toBe(202)
		expect(await response.json()).toEqual({ id: 'a'.repeat(32) })
		expect(queue.messages).toHaveLength(1)
		expect(queue.messages[0]?.projectId).toBe('source-uuid')
		expect(queue.messages[0]?.projectId).not.toBe(INGEST_PROJECT_ID)
		expect(outcomes).toEqual([{ kind: 'accepted', sourceId: 'source-uuid', eventCount: 1, bodyBytes: new TextEncoder().encode(envelope()).length }])
	})

	test('accepts header auth or matching dual auth and rejects ambiguous credentials', async () => {
		const headerOnly = await setup()
		expect(
			(await handleDirectIngestRequest(request({ key: null, headerKey: PUBLIC_KEY }), headerOnly.options)).status,
		).toBe(202)

		const matching = await setup()
		expect(
			(await handleDirectIngestRequest(request({ headerKey: PUBLIC_KEY }), matching.options)).status,
		).toBe(202)

		const ambiguous = await setup()
		const response = await handleDirectIngestRequest(request({ headerKey: OTHER_KEY }), ambiguous.options)
		expect(response.status).toBe(401)
		expect(ambiguous.queue.messages).toEqual([])
		expect(JSON.stringify(await response.json())).not.toContain(PUBLIC_KEY)
	})

	test('distinguishes invalid authentication from a valid credential on the wrong project', async () => {
		const missing = await setup()
		expect((await handleDirectIngestRequest(request({ key: null }), missing.options)).status).toBe(401)
		expect(
			(await handleDirectIngestRequest(request({ key: OTHER_KEY }), missing.options)).status,
		).toBe(401)
		const wrongPath = request({ url: 'https://operations.test/api/999/envelope/' })
		expect((await handleDirectIngestRequest(wrongPath, missing.options)).status).toBe(403)
		await missing.harness.repositories.sources.upsert({
			id: 'ignored',
			appId: 'notes',
			environment: 'production',
			displayName: 'Notes',
			enabled: false,
		})
		expect((await handleDirectIngestRequest(request(), missing.options)).status).toBe(401)
		expect(missing.queue.messages).toEqual([])
	})

	test('requires POST and the exact trailing-slash route', async () => {
		const { options } = await setup()
		const method = await handleDirectIngestRequest(request({ method: 'PUT', body: undefined }), options)
		expect(method.status).toBe(405)
		expect(method.headers.get('allow')).toBe('POST')
		expect(
			(await handleDirectIngestRequest(request({ url: `https://operations.test/api/${INGEST_PROJECT_ID}/envelope` }), options)).status,
		).toBe(404)
		expect(
			(await handleDirectIngestRequest(request({ url: 'https://operations.test/api/source-uuid/envelope/' }), options)).status,
		).toBe(404)
	})

	test('enforces content encoding, media type, declared size, streamed size, and queue message size', async () => {
		const encoded = await setup()
		expect(
			(await handleDirectIngestRequest(request({ headers: { 'content-encoding': 'gzip' } }), encoded.options)).status,
		).toBe(415)
		expect(
			(await handleDirectIngestRequest(request({ headers: { 'content-type': 'application/json' } }), encoded.options)).status,
		).toBe(415)

		const declared = await setup()
		expect(
			(await handleDirectIngestRequest(request({ headers: { 'content-length': String(MAX_INGEST_BODY_BYTES + 1) } }), declared.options)).status,
		).toBe(413)

		const streamed = await setup()
		expect(
			(await handleDirectIngestRequest(request({ body: new Blob(['x'.repeat(MAX_INGEST_BODY_BYTES + 1)]) }), streamed.options)).status,
		).toBe(413)

		const message = await setup()
		const oversizedMessage = envelope('broken', { extra: 'x'.repeat(125 * 1024) })
		expect(
			(await handleDirectIngestRequest(request({ body: oversizedMessage }), message.options)).status,
		).toBe(413)
		expect(message.queue.messages).toEqual([])
	})

	test('accepts at most 32 event items and reports ignored item kinds', async () => {
		const accepted = await setup()
		const response = await handleDirectIngestRequest(
			request({ body: multiEventEnvelope(MAX_ENVELOPE_EVENT_ITEMS, true) }),
			accepted.options,
		)
		expect(response.status).toBe(202)
		expect(response.headers.get('x-fabrika-ignored-sentry-items')).toBe('client_report')
		expect(accepted.queue.messages).toHaveLength(MAX_ENVELOPE_EVENT_ITEMS)

		const rejected = await setup()
		expect(
			(await handleDirectIngestRequest(
				request({ body: multiEventEnvelope(MAX_ENVELOPE_EVENT_ITEMS + 1) }),
				rejected.options,
			)).status,
		).toBe(413)
		expect(rejected.queue.messages).toEqual([])
	})

	test('rejects malformed and event-free envelopes without enqueueing', async () => {
		const malformed = await setup()
		expect((await handleDirectIngestRequest(request({ body: '{}\nnot-json\n{}\n' }), malformed.options)).status).toBe(400)
		expect(
			(await handleDirectIngestRequest(
				request({ body: `{}\n${JSON.stringify({ type: 'transaction', length: 2 })}\n{}\n` }),
				malformed.options,
			)).status,
		).toBe(400)
		expect(malformed.queue.messages).toEqual([])
	})

	test('rate limits atomically per source and resets at the next minute', async () => {
		let now = 1_000
		const limited = await setup(() => now)
		limited.options.rateLimitPerMinute = 2
		expect((await handleDirectIngestRequest(request(), limited.options)).status).toBe(202)
		expect((await handleDirectIngestRequest(request(), limited.options)).status).toBe(202)
		const blocked = await handleDirectIngestRequest(request(), limited.options)
		expect(blocked.status).toBe(429)
		expect(blocked.headers.get('retry-after')).toBe('59')
		expect(limited.queue.messages).toHaveLength(2)
		now = 60_000
		expect((await handleDirectIngestRequest(request(), limited.options)).status).toBe(202)

		const batched = await setup()
		batched.options.rateLimitPerMinute = 2
		expect((await handleDirectIngestRequest(request({ body: multiEventEnvelope(3) }), batched.options)).status).toBe(429)
		expect(batched.queue.messages).toEqual([])
	})

	test('maps revoked, expired, and queue-failed delivery without exposing the public key', async () => {
		let now = 1_000
		const revoked = await setup(() => now)
		const credential = revoked.harness.sqlite.query<{ id: string }, []>('SELECT id FROM ingest_credentials').get()
		if (!credential) throw new Error('missing test credential')
		expect(await revoked.harness.repositories.sources.revokeSourceCredential('source-uuid', credential.id)).toBe(true)
		expect((await handleDirectIngestRequest(request(), revoked.options)).status).toBe(401)

		const expired = await setup(() => now)
		await rotateSourceIngestCredential(
			expired.harness.repositories,
			{ sourceId: 'source-uuid', operationsOrigin: 'https://operations.test' },
			{
				now: () => now,
				publicKey: () => OTHER_KEY,
				ingestProjectId: () => '999',
				overlapMs: 500,
			},
		)
		now = 1_500
		expect((await handleDirectIngestRequest(request(), expired.options)).status).toBe(401)

		const unavailableAuth = await setup()
		unavailableAuth.options.repositories = createSqliteOperationsRepositories(unavailableAuth.harness.db, {
			replacements: { sources: new FailingCredentialSources(unavailableAuth.harness.db) },
		})
		const authResponse = await handleDirectIngestRequest(request(), unavailableAuth.options)
		expect(authResponse.status).toBe(503)
		expect(JSON.stringify(await authResponse.json())).not.toContain(PUBLIC_KEY)

		const unavailable = await setup()
		unavailable.queue.fail = true
		const response = await handleDirectIngestRequest(request(), unavailable.options)
		expect(response.status).toBe(503)
		expect(JSON.stringify(await response.json())).not.toContain(PUBLIC_KEY)
		expect(JSON.stringify(unavailable.outcomes)).not.toContain(PUBLIC_KEY)
		expect(JSON.stringify(unavailable.harness.sqlite.query('SELECT * FROM ingest_credentials').all())).not.toContain(PUBLIC_KEY)
	})
})
