// ctx.signal of a request handler: it aborts when the request is cancelled or outlives its budget, so an outbound call
// the handler passes it to stops with the request instead of running on after the client left. Every deadline the
// framework sets ends with the work it guards: a pending timer keeps a Durable Object awake, and billed. A multipart
// body needs file kinds, so its case runs against a REAL Postgres and skips when FABRIKA_TEST_POSTGRES_URL is unset.

import { defineApp, defineVocabulary, file, PROCEDURE_LIMITS } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { bodyDeadlineMs } from '../implement/anonymous'
import { handlerSignal, REQUEST_BUDGET_MS } from '../implement/bounded'
import { platformCall } from '../implement/egress'
import { issuerWorkloadTokens } from '../implement/workload'
import { operationsReporter } from '../jobs/report'
import { secretScrubber } from '../jobs/scrub'
import { app as filesApp } from './stored-files-fixture/src/app-kit'
import { tables as filesTables } from './stored-files-fixture/src/db/tables'

const vocabulary = defineVocabulary({
	app: 'signals',
	dimensions: { project: {} },
	actions: { 'projects.read': 'Read projects' },
	roles: { reader: { grants: ['projects.read'] } },
})
const app = defineApp(vocabulary)
const Called = z.strictObject({ status: z.int() })

/** What the handler saw of its signal after its outbound call ended. */
const seen = { aborted: false, reason: '' }

/** A provider that holds every request until its caller gives up, and says when one reached it and when it was dropped. */
const upstream = (() => {
	const reached = Promise.withResolvers<void>()
	const dropped = Promise.withResolvers<void>()
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			reached.resolve()
			await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }))
			dropped.resolve()
			return new Response(null, { status: 204 })
		},
	})
	return {
		local: `http://127.0.0.1:${server.port}/send`,
		reached: reached.promise,
		dropped: dropped.promise,
		stop: () => server.stop(true),
	}
})()

afterAll(() => upstream.stop())

/** The provider's public address, which the handler declares in `egress`; the fetch below `boot`'s guard routes it locally. */
const PROVIDER = 'https://provider.example'

const projects = app.group({ callers: ['human'] }, (r) => ({
	call: r.mutation({ output: Called, access: { action: 'projects.read', over: 'project' }, egress: [PROVIDER] })
		.handle(async ({ ctx }) => {
			try {
				const response = await fetch(`${PROVIDER}/send`, { method: 'POST', signal: ctx.signal })
				return { status: response.status }
			} finally {
				seen.aborted = ctx.signal.aborted
				seen.reason = ctx.signal.aborted ? String(Reflect.get(Object(ctx.signal.reason), 'name')) : ''
			}
		}),
}))
const Echoed = z.strictObject({ text: z.string() })
const echo = app.group({ callers: ['human'] }, (r) => ({
	echo: r.mutation({ input: Echoed, output: Echoed, access: { action: 'projects.read', over: 'project' } })
		.handle(async ({ input }) => input),
	fail: r.mutation({ input: Echoed, output: Echoed, access: { action: 'projects.read', over: 'project' } })
		.handle(async () => {
			throw new Error('the handler failed')
		}),
}))
const contract = app.contract((c) => ({ api: c.rpc('/api', { projects, echo }), health: c.health('/healthz') }))

/** A body deadline: `bodyDeadlineMs` of the default 64 KiB limit. */
const BODY_DEADLINE_MS = 30_000
/** The workload exchange's and a report delivery's deadline. */
const OUTBOUND_DEADLINE_MS = 5_000

/** The delays of the deadlines (timers of a second or more) set while `work` ran, and of those still pending when it settled. */
async function deadlinesOf(work: () => Promise<unknown>): Promise<{ readonly set: readonly number[]; readonly pending: readonly number[] }> {
	const native = spyOn(AbortSignal, 'timeout')
	const started = spyOn(globalThis, 'setTimeout')
	const cleared = spyOn(globalThis, 'clearTimeout')
	try {
		await work()
		// A native timeout's timer is invisible to the spies and never cleared: it counts as a pending deadline.
		const set: number[] = native.mock.calls.map(([delay]) => delay)
		const pending: number[] = [...set]
		const clearedTimers = new Set<unknown>(cleared.mock.calls.map(([timer]) => timer))
		started.mock.calls.forEach(([, delay], index) => {
			if (delay === undefined || delay < 1000) {
				return
			}
			set.push(delay)
			const result = started.mock.results[index]
			if (result === undefined || !clearedTimers.has(result.value)) {
				pending.push(delay)
			}
		})
		return { set: set.sort((a, b) => a - b), pending: pending.sort((a, b) => a - b) }
	} finally {
		cleared.mockRestore()
		started.mockRestore()
		native.mockRestore()
	}
}

describe('ctx.signal of a request handler', () => {
	test('a cancelled request aborts it, and the fetch the handler passed it to stops at the provider', async () => {
		// The provider was reached, so the signal was live until the cancel.
		const direct = fetch
		const routed = spyOn(globalThis, 'fetch').mockImplementation(
			// Routed outside the site's scope: an earlier suite's guard may sit beneath this stub.
			Object.assign((_input: string | URL | Request, init?: RequestInit) => platformCall(() => direct(upstream.local, init)), {
				preconnect: direct.preconnect,
			}),
		)
		const kit = testKit(serve(contract, { database: null }))
		const reader = kit.testCaller([{ action: 'projects.read', scope: { type: 'project', value: 'p1' } }])
		const cancel = new AbortController()
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const answer = kit.browser(reader)('/api/projects.call', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{}',
				signal: cancel.signal,
			}).catch(() => null)
			await upstream.reached
			cancel.abort()
			await upstream.dropped
			await answer
		} finally {
			log.mockRestore()
			routed.mockRestore()
		}
		expect(seen).toEqual({ aborted: true, reason: 'AbortError' })
	})

	test('the budget aborts it when the request runs too long, with a TimeoutError', async () => {
		const { signal } = handlerSignal(new Request('https://signals.test/api/projects.call'), 20)
		expect(signal.aborted).toBe(false)
		await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
		expect(String(Reflect.get(Object(signal.reason), 'name'))).toBe('TimeoutError')
	})

	test('a real timeout aborts the budget with the TimeoutError AbortSignal.timeout aborts with', async () => {
		const native = AbortSignal.timeout(1)
		await new Promise((resolve) => native.addEventListener('abort', resolve, { once: true }))
		const { signal } = handlerSignal(new Request('https://signals.test/api/projects.call'), 20)
		await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
		expect(signal.reason).toBeInstanceOf(DOMException)
		expect({ name: Reflect.get(Object(signal.reason), 'name'), message: Reflect.get(Object(signal.reason), 'message') }).toEqual({
			name: Reflect.get(Object(native.reason), 'name'),
			message: Reflect.get(Object(native.reason), 'message'),
		})
	})
})

describe('every deadline ends with the work it guards', () => {
	const kit = testKit(serve(contract, { database: null }))
	const reader = kit.testCaller([{ action: 'projects.read', scope: { type: 'project', value: 'p1' } }])
	const call = (path: string, body: string) => kit.browser(reader)(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })

	test("a request that succeeds clears its body deadline and its handler's budget", async () => {
		let status = 0
		const deadlines = await deadlinesOf(async () => {
			status = (await call('/api/echo.echo', JSON.stringify({ text: 'hello' }))).status
		})
		expect(status).toBe(200)
		expect(deadlines).toEqual({ set: [REQUEST_BUDGET_MS, BODY_DEADLINE_MS], pending: [] })
	})

	test("a request whose handler fails clears its body deadline and its handler's budget", async () => {
		const log = spyOn(console, 'error').mockImplementation(() => {})
		let status = 0
		try {
			const deadlines = await deadlinesOf(async () => {
				status = (await call('/api/echo.fail', JSON.stringify({ text: 'hello' }))).status
			})
			expect(deadlines).toEqual({ set: [REQUEST_BUDGET_MS, BODY_DEADLINE_MS], pending: [] })
		} finally {
			log.mockRestore()
		}
		expect(status).toBe(500)
	})

	test('a body read that fails clears its deadline', async () => {
		let status = 0
		const deadlines = await deadlinesOf(async () => {
			status = (await call('/api/echo.echo', JSON.stringify({ text: 'x'.repeat(64 * 1024) }))).status
		})
		expect(status).toBe(413)
		expect(deadlines).toEqual({ set: [BODY_DEADLINE_MS], pending: [] })
	})

	test.each([
		['succeeds', () => Promise.resolve(Response.json({ ok: false, reason: 'invalid_key' }))],
		['fails', () => Promise.reject(new Error('connect ECONNREFUSED'))],
	])('a workload key exchange that %s clears its deadline', async (_name, answer) => {
		const deadlines = await deadlinesOf(async () => {
			await issuerWorkloadTokens('https://iam.test', answer).exchange({ app: 'signals@test', key: 'px_signals' }).catch(() => null)
		})
		expect(deadlines).toEqual({ set: [OUTBOUND_DEADLINE_MS], pending: [] })
	})

	test('a workload key exchange IAM refuses with a streaming body cancels that body before it clears its deadline', async () => {
		const cancelled = Promise.withResolvers<void>()
		// The head of a body and then nothing: only a cancel ends it.
		const refusal = () =>
			Promise.resolve(
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"error":'))
						},
						cancel() {
							cancelled.resolve()
						},
					}),
					{ status: 503 },
				),
			)
		let refused: unknown = null
		const deadlines = await deadlinesOf(async () => {
			refused = await issuerWorkloadTokens('https://iam.test', refusal).exchange({ app: 'signals@test', key: 'px_signals' }).then(
				() => null,
				(error: unknown) => error,
			)
		})
		expect(deadlines).toEqual({ set: [OUTBOUND_DEADLINE_MS], pending: [] })
		expect(String(Reflect.get(Object(refused), 'message'))).toBe('IAM answered the workload token exchange with 503')
		await cancelled.promise
	})

	test('a refusal whose body fails to cancel still fails the exchange with the refusal', async () => {
		const refusal = () =>
			Promise.resolve(
				new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							throw new Error('the stream cannot be cancelled')
						},
					}),
					{ status: 429 },
				),
			)
		const refused = await issuerWorkloadTokens('https://iam.test', refusal).exchange({ app: 'signals@test', key: 'px_signals' }).then(
			() => null,
			(error: unknown) => error,
		)
		expect(String(Reflect.get(Object(refused), 'message'))).toBe('IAM answered the workload token exchange with 429')
	})

	test.each([
		['is delivered', () => Promise.resolve(new Response(null, { status: 200 }))],
		['cannot be delivered', () => Promise.reject(new Error('connect ECONNREFUSED'))],
	])('a report that %s clears its deadline', async (_name, answer) => {
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const reporter = operationsReporter({
				target: { envelopeUrl: 'https://operations.test/api/42/envelope/', publicKey: '0123456789abcdef0123456789abcdef' },
				release: null,
				environment: null,
				source: 'fabrika.requests',
				scrubber: secretScrubber([]),
				fetch: answer,
			})
			const deadlines = await deadlinesOf(async () => {
				await reporter.report({ fingerprint: ['signals'], type: 'Failed', message: 'failed', tags: {} })
			})
			expect(deadlines).toEqual({ set: [OUTBOUND_DEADLINE_MS], pending: [] })
		} finally {
			log.mockRestore()
		}
	})
})

const postgres = await testDatabase({
	migrations: join(import.meta.dir, 'stored-files-fixture', 'db', 'migrations'),
	label: 'request-signal.test.ts',
})

afterAll(async () => {
	await postgres?.close()
})

if (postgres !== null) {
	describe('a multipart body ends with the request', () => {
		const uploads = filesApp.group({ callers: ['human'] }, (r) => ({
			upload: r.mutation({
				input: z.strictObject({ file: file('attachments') }),
				http: { query: z.strictObject({ n: z.string().regex(/^[0-9]+$/) }) },
				output: z.strictObject({}),
				access: { action: 'catalog.write', app: true },
			}).handle(async () => ({})),
		}))
		const contract = filesApp.contract((c) => ({
			api: c.rpc('/api', { uploads }),
			health: c.health('/healthz'),
			files: {
				attachments: c.files({ types: ['application/pdf'], maxBytes: 1024 * 1024 }),
				catalog: c.files({ types: ['image/png'], maxBytes: 1024 }),
				photos: c.files({ types: ['image/png'], maxBytes: 1024 }),
			},
		}))
		const kit = testKit(serve(contract, { database: scoped(filesTables) }), { database: postgres.database, files: new MemoryFileObjects() })
		const staff = kit.testCaller([{ action: 'catalog.write' }])

		test('a request refused once its multipart body is open clears the body deadline and cancels the stream', async () => {
			const boundary = 'deadline-boundary'
			const cancelled = Promise.withResolvers<void>()
			// The input part and the head of a file part, then nothing: only a cancel ends this body.
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(
							[
								`--${boundary}`,
								'Content-Disposition: form-data; name="input"',
								'',
								'{}',
								`--${boundary}`,
								'Content-Disposition: form-data; name="file"; filename="a.pdf"',
								'Content-Type: application/pdf',
								'',
								'%PDF-',
							].join('\r\n'),
						),
					)
				},
				cancel() {
					cancelled.resolve()
				},
			})
			let status = 0
			const deadlines = await deadlinesOf(async () => {
				status = (await kit.browser(staff)('/api/uploads.upload?n=not-a-number', {
					method: 'POST',
					headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
					body,
				})).status
			})
			expect(status).toBe(400)
			expect(deadlines).toEqual({ set: [bodyDeadlineMs(PROCEDURE_LIMITS.maxBytes + 1024 * 1024)], pending: [] })
			await cancelled.promise
		})
	})
}
