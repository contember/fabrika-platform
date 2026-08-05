import type { AppSchema } from '@fabrika/auth-core'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { reconcileSchema, ReconcileSchemaError } from '../provision'

// reconcileSchema goes over the global fetch (HTTP to the admin origin). We spy on fetch, capture
// the outgoing request, and drive the response status — no network, no `as` casts.

const SCHEMA: AppSchema = {
	scopes: [{ type: 'project', label: 'Project' }],
	actions: [{ action: 'report.read', description: 'Read reports' }],
	roles: { viewer: { name: 'Viewer', permissions: ['report.read'] } },
}

// One captured outgoing fetch call → its url + parsed request shape.
function captured(
	spy: ReturnType<typeof stubFetch>,
	index = 0,
): { url: string; method: string | undefined; headers: Headers; body: unknown } {
	const call = spy.mock.calls[index]
	if (!call) {
		throw new Error('fetch was not called')
	}
	const [input, init] = call
	return {
		url: String(input),
		method: init?.method,
		headers: new Headers(init?.headers),
		body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
	}
}

let restore: (() => void) | undefined

function stubFetch(status: number, body: unknown = {}) {
	const spy = spyOn(globalThis, 'fetch').mockResolvedValue(
		new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
	)
	restore = () => spy.mockRestore()
	return spy
}

/** Answer each call with its own status/body — the two-call path needs the second to differ. */
function stubFetchSequence(...answers: Array<{ status: number; body?: unknown }>) {
	const spy = spyOn(globalThis, 'fetch')
	for (const answer of answers) {
		spy.mockResolvedValueOnce(
			new Response(JSON.stringify(answer.body ?? {}), { status: answer.status, headers: { 'content-type': 'application/json' } }),
		)
	}
	// A call beyond the script is a test failure, not a silently successful request.
	spy.mockResolvedValue(new Response(JSON.stringify({ error: 'unexpected request' }), { status: 599 }))
	restore = () => spy.mockRestore()
	return spy
}

afterEach(() => {
	restore?.()
	restore = undefined
})

describe('reconcileSchema', () => {
	test('PUTs the declaration to /admin/apps/:app/schema (trailing slash trimmed)', async () => {
		const spy = stubFetch(200)
		await reconcileSchema({ url: 'https://propustka.example.com/', app: 'opice', schema: SCHEMA })
		expect(spy.mock.calls).toHaveLength(1)
		const req = captured(spy)
		expect(req.url).toBe('https://propustka.example.com/admin/apps/opice/schema')
		expect(req.method).toBe('PUT')
		expect(req.body).toEqual(SCHEMA)
	})

	test('forwards the admin key as an Authorization: Bearer header when provided', async () => {
		const spy = stubFetch(200)
		await reconcileSchema({ url: 'https://propustka.example.com', app: 'opice', schema: SCHEMA, adminKey: 'px_admin-key' })
		const req = captured(spy)
		expect(req.headers.get('Authorization')).toBe('Bearer px_admin-key')
	})

	test('no admin key → no Authorization header (local-dev bypass path)', async () => {
		const spy = stubFetch(200)
		await reconcileSchema({ url: 'https://propustka.example.com', app: 'opice', schema: SCHEMA })
		const req = captured(spy)
		expect(req.headers.get('Authorization')).toBeNull()
	})

	test('a non-2xx response throws ReconcileSchemaError carrying status + message', async () => {
		stubFetch(502, { error: 'admin said no' })
		const err = await reconcileSchema({ url: 'https://propustka.example.com', app: 'opice', schema: SCHEMA }).catch((e: unknown) => e)
		expect(err).toBeInstanceOf(ReconcileSchemaError)
		if (err instanceof ReconcileSchemaError) {
			expect(err.status).toBe(502)
			expect(err.message).toContain('admin said no')
		}
	})

	test('no returnOrigins → the registry is never touched (one call, the schema PUT)', async () => {
		const spy = stubFetch(200)
		await reconcileSchema({ url: 'https://propustka.example.com', app: 'opice', schema: SCHEMA })
		expect(spy.mock.calls).toHaveLength(1)
	})

	test('returnOrigins → a SECOND call to apps.setReturnOrigins, after the schema PUT registers the app', async () => {
		const spy = stubFetchSequence({ status: 200 }, { status: 200, body: { result: { app: 'opice', origins: ['https://opice.test'] } } })
		await reconcileSchema({
			url: 'https://propustka.example.com/',
			app: 'opice',
			schema: SCHEMA,
			returnOrigins: ['https://opice.test', 'https://stage.opice.test'],
			adminKey: 'px_admin-key',
		})
		expect(spy.mock.calls).toHaveLength(2)
		// Ordering is load-bearing: `apps.setReturnOrigins` 404s for an app IAM has not been told about,
		// and the schema PUT is what registers it.
		expect(captured(spy, 0).url).toBe('https://propustka.example.com/admin/apps/opice/schema')
		const registration = captured(spy, 1)
		expect(registration.url).toBe('https://propustka.example.com/admin/rpc')
		expect(registration.method).toBe('POST')
		expect(registration.headers.get('Authorization')).toBe('Bearer px_admin-key')
		expect(registration.body).toEqual({
			method: 'apps.setReturnOrigins',
			input: { app: 'opice', origins: ['https://opice.test', 'https://stage.opice.test'] },
		})
		// The origins must NEVER travel inside the schema body — an app would then be asserting where it
		// can be handed a session, which is the thing the registry exists to prevent.
		expect(captured(spy, 0).body).toEqual(SCHEMA)
	})

	test('a rejected registration throws with the RPC envelope message and its status', async () => {
		stubFetchSequence({ status: 200 }, { status: 400, body: { error: { type: 'validation', message: 'not an absolute http(s) origin: nope' } } })
		const err = await reconcileSchema({
			url: 'https://propustka.example.com',
			app: 'opice',
			schema: SCHEMA,
			returnOrigins: ['nope'],
		}).catch((e: unknown) => e)
		expect(err).toBeInstanceOf(ReconcileSchemaError)
		if (err instanceof ReconcileSchemaError) {
			expect(err.status).toBe(400)
			expect(err.message).toContain('apps.setReturnOrigins')
			expect(err.message).toContain('not an absolute http(s) origin: nope')
		}
	})

	test('an error envelope answered with 200 is still a failure, never a silent no-op', async () => {
		stubFetchSequence({ status: 200 }, { status: 200, body: { error: { type: 'forbidden', message: 'admin permission required' } } })
		const err = await reconcileSchema({
			url: 'https://propustka.example.com',
			app: 'opice',
			schema: SCHEMA,
			returnOrigins: ['https://opice.test'],
		}).catch((e: unknown) => e)
		expect(err).toBeInstanceOf(ReconcileSchemaError)
		expect(err instanceof Error ? err.message : '').toContain('admin permission required')
	})

	test('a failed schema PUT never reaches the registry', async () => {
		const spy = stubFetchSequence({ status: 403, body: { error: 'admin permission required' } })
		await expect(
			reconcileSchema({ url: 'https://propustka.example.com', app: 'opice', schema: SCHEMA, returnOrigins: ['https://opice.test'] }),
		).rejects.toBeInstanceOf(ReconcileSchemaError)
		expect(spy.mock.calls).toHaveLength(1)
	})

	test('an EMPTY returnOrigins array is a caller error, refused before any request', async () => {
		const spy = stubFetch(200)
		await expect(
			reconcileSchema({ url: 'https://propustka.example.com', app: 'opice', schema: SCHEMA, returnOrigins: [] }),
		).rejects.toThrow('must not be empty')
		expect(spy.mock.calls).toHaveLength(0)
	})

	test('aborts an in-flight request with the signal native cancellation reason', async () => {
		const controller = new AbortController()
		const started = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: async () => {
				started.resolve()
				await release.promise
				return new Response(null, { status: 200 })
			},
		})
		try {
			const reconciliation = reconcileSchema({
				url: server.url.origin,
				app: 'opice',
				schema: SCHEMA,
				signal: controller.signal,
			})
			await started.promise
			controller.abort()

			const error = await reconciliation.catch((reason: unknown) => reason)
			expect(error).toBe(controller.signal.reason)
			expect(error).not.toBeInstanceOf(ReconcileSchemaError)
		} finally {
			release.resolve()
			await server.stop(true)
		}
	})
})
