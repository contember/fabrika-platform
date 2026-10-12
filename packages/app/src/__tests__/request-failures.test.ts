// A request that answers 5xx: one server log line and, with an Operations DSN, one error event. Both carry a fixed
// failure code and bounded identifiers only: an error's name and message, the input and the headers never leave.

import { HttpError } from '@fabrika/app'
import { boot } from '@fabrika/app/implement'
import { describe, expect, test } from 'bun:test'
import { FailureReports, MAX_FAILURE_REPORTS_PER_MINUTE } from '../implement/failures'
import { implement } from '../implement/implement'
import type { OperationsReport } from '../jobs/report'
import { contract } from './fixtures/implement/fabrika.contract'
import {
	bootApp,
	echoAssets,
	endpointHeaderFor,
	environment,
	frameworkEnvFor,
	grant,
	keySource,
	ORIGIN,
	send,
	token,
} from './fixtures/implement/harness'
import { noteDatabase } from './fixtures/implement/stores'

const SECRET = 's3cret-password'
const DSN = 'https://0123456789abcdef0123456789abcdef@operations.test/42'
const REQUEST_ID = '0190a0a0-0000-7000-8000-0000000000aa'

function throwing(error: unknown) {
	return implement(contract, {
		database: noteDatabase(new Map()),
		deps: () => null,
		handlers: () => ({
			api: {
				me: () => {
					throw error
				},
				notes: {
					list: () => ({ items: [] }),
					get: () => ({ id: 'x', title: 'x' }),
					create: () => ({ id: 'x', title: 'x' }),
					remove: () => ({ deleted: 'x' }),
				},
			},
			machine: { importNotes: () => ({ imported: 0 }) },
		}),
	})
}

/** An error whose name and message both hold the secret, as an application or a driver may write them. */
const leaking = (): Error => Object.assign(new Error(`connect failed for postgres://notes:${SECRET}@db/notes`), { name: `Driver${SECRET}` })

interface Run {
	readonly status: number
	readonly envelopes: string[]
	readonly logged: string[]
}

async function run(
	error: unknown,
	variables: Readonly<Record<string, string>> = { FABRIKA_OPERATIONS_DSN: DSN, FABRIKA_RELEASE: 'r1' },
): Promise<Run> {
	const app = throwing(error)
	const envelopes: string[] = []
	const operationsFetch = async (request: Request): Promise<Response> => {
		envelopes.push(await request.text())
		return new Response(null, { status: 202 })
	}
	const served = bootApp(app, { environment: environment({ ...frameworkEnvFor(app), ...variables }), operationsFetch })
	const logged: string[] = []
	const original = console.error
	console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
	try {
		const sent = await send(served, '/api/me', {
			token: await token('user', [grant('notes.read')]),
			body: {},
			headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Request-Id': REQUEST_ID, 'X-Custom': SECRET },
		})
		// The delivery is not awaited by the response; let it settle.
		await Bun.sleep(0)
		return { status: sent.status, envelopes, logged }
	} finally {
		console.error = original
	}
}

function eventOf(envelope: string | undefined): Record<string, unknown> {
	const event: unknown = JSON.parse(envelope?.split('\n')[2] ?? 'null')
	if (typeof event !== 'object' || event === null) throw new Error('no event in the envelope')
	return Object.fromEntries(Object.entries(event))
}

describe('a request that answers 5xx', () => {
	test('a throwing handler sends one envelope: endpoint, request id, code and release, no name, message or input', async () => {
		const { status, envelopes, logged } = await run(leaking())
		expect(status).toBe(500)
		expect(envelopes).toHaveLength(1)
		expect(envelopes.join('\n')).not.toContain(SECRET)
		const event = eventOf(envelopes[0])
		expect(event['logger']).toBe('fabrika.requests')
		expect(event['release']).toBe('r1')
		expect(event['fingerprint']).toEqual(['fabrika-request-failed', 'api.me', 'handler_failed'])
		expect(event['tags']).toEqual({ endpoint: 'api.me', code: 'handler_failed', status: '500', request: REQUEST_ID })
		expect(event['exception']).toEqual({ values: [{ type: 'RequestFailed', value: "endpoint 'api.me' answered 500: handler_failed" }] })
		expect(logged).toEqual(['fabrika: api.me: handler_failed'])
	})

	test('without a DSN the log line is the only record, and it carries neither the name nor the message', async () => {
		const { envelopes, logged } = await run(leaking(), {})
		expect(envelopes).toEqual([])
		expect(logged).toEqual(['fabrika: api.me: handler_failed'])
	})

	test("an application's 5xx status is handler_status; a framework fault keeps its own text in the log only", async () => {
		const status = await run(new HttpError(502, 'upstream', `upstream said ${SECRET}`))
		expect(status.status).toBe(502)
		expect(eventOf(status.envelopes[0])['tags']).toMatchObject({ code: 'handler_status', status: '502' })
		expect(status.logged).toEqual(['fabrika: api.me: handler_status'])
		const dressed = await run(Object.assign(new Error(SECRET), { name: 'ServerFault' }))
		expect(dressed.logged).toEqual(['fabrika: api.me: handler_failed'])
	})

	test('a 4xx sends nothing', async () => {
		const { status, envelopes, logged } = await run(new HttpError(400, 'bad_request', 'no'))
		expect(status).toBe(400)
		expect(envelopes).toEqual([])
		expect(logged).toEqual([])
	})

	test("the runtime hands the delivery to the request's waitUntil", async () => {
		const app = throwing(leaking())
		const sent: Request[] = []
		const runtime = boot(app, {
			environment: environment({ ...frameworkEnvFor(app), FABRIKA_OPERATIONS_DSN: DSN }),
			iam: keySource,
			assets: echoAssets,
			operationsFetch: (request) => Promise.resolve(void sent.push(request)).then(() => new Response(null, { status: 202 })),
		})
		const pending: Promise<unknown>[] = []
		const original = console.error
		console.error = () => {}
		try {
			const headers = new Headers({ 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' })
			headers.set('X-Fabrika-Token', await token('user', [grant('notes.read')]))
			headers.set('X-Fabrika-Endpoint', endpointHeaderFor(app, 'POST', '/api/me') ?? '')
			const response = await runtime.fetch(new Request(`${ORIGIN}/api/me`, { method: 'POST', headers, body: '{}' }), {
				waitUntil: (promise) => void pending.push(promise),
			})
			expect(response.status).toBe(500)
			expect(pending).toHaveLength(1)
			await Promise.all(pending)
		} finally {
			console.error = original
		}
		expect(sent).toHaveLength(1)
	})
})

describe('the report budget', () => {
	const recorder = () => {
		const reports: OperationsReport[] = []
		return { reports, reporter: { report: (report: OperationsReport) => Promise.resolve(void reports.push(report)) } }
	}
	const failure = (requestId: string | null) => ({ endpoint: 'api.me', requestId, status: 500, error: new Error('x') })
	const quietly = async (work: () => Promise<void>): Promise<void> => {
		const original = console.error
		console.error = () => {}
		try {
			await work()
		} finally {
			console.error = original
		}
	}

	test('at most the budget per minute becomes an event; the next minute starts again', async () => {
		let now = 1_000_000 * 60_000
		const { reports, reporter } = recorder()
		const failures = new FailureReports(reporter, () => now)
		await quietly(async () => {
			for (let index = 0; index < MAX_FAILURE_REPORTS_PER_MINUTE + 5; index++) {
				await failures.record(failure(null))
			}
			expect(reports).toHaveLength(MAX_FAILURE_REPORTS_PER_MINUTE)
			now += 60_000
			await failures.record(failure(null))
		})
		expect(reports).toHaveLength(MAX_FAILURE_REPORTS_PER_MINUTE + 1)
	})

	test('a request id that is not a bounded token is left out', async () => {
		const { reports, reporter } = recorder()
		const failures = new FailureReports(reporter)
		await quietly(async () => {
			await failures.record(failure(`${'a'.repeat(65)}`))
			await failures.record(failure('a b'))
		})
		expect(reports.map((report) => report.tags['request'])).toEqual([undefined, undefined])
	})
})
