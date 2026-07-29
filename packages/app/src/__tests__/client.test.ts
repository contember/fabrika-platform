import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createRpcClient, RpcError } from '../client.js'
import { initRpc } from '../rpc/builder.js'
import { record } from './helpers.js'

const t = initRpc<Record<string, never>>()
const appRouter = t.router({
	echo: t.procedure.input(z.object({ msg: z.string() })).output(z.object({ echoed: z.string() })).handler(({ input }) => ({ echoed: input.msg })),
	math: t.router({
		add: t.procedure.input(z.object({ a: z.number(), b: z.number() })).output(z.number()).handler(({ input }) => input.a + input.b),
	}),
})

type AppRouter = typeof appRouter

const realFetch = globalThis.fetch

afterEach(() => {
	globalThis.fetch = realFetch
})

interface Captured {
	url: string
	method: string
	input: unknown
}

function stubFetch(responder: () => Response): Captured[] {
	const captured: Captured[] = []
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const req = new Request(input, init)
			const body = record(await req.json())
			const method = typeof body['method'] === 'string' ? body['method'] : ''
			captured.push({ url: req.url, method, input: body['input'] })
			return responder()
		},
		{ preconnect: realFetch.preconnect },
	)
	return captured
}

function firstCaptured(captured: Captured[]): Captured {
	const first = captured[0]
	if (first === undefined) throw new Error('expected a captured request')
	return first
}

describe('createRpcClient', () => {
	test('builds the correct dotted method path and unwraps result', async () => {
		const captured = stubFetch(() => new Response(JSON.stringify({ result: 4 }), { headers: { 'content-type': 'application/json' } }))
		const client = createRpcClient<AppRouter>({ baseUrl: 'https://x/api/rpc' })
		const result = await client.math.add({ a: 1, b: 3 })
		expect(result).toBe(4)
		expect(captured.length).toBe(1)
		const request = firstCaptured(captured)
		expect(request.url).toBe('https://x/api/rpc')
		expect(request.method).toBe('math.add')
		expect(request.input).toEqual({ a: 1, b: 3 })
	})

	test('builds a top-level method path', async () => {
		const captured = stubFetch(() => new Response(JSON.stringify({ result: { echoed: 'hi' } }), { headers: { 'content-type': 'application/json' } }))
		const client = createRpcClient<AppRouter>({ baseUrl: 'https://x/api/rpc' })
		const result = await client.echo({ msg: 'hi' })
		expect(result).toEqual({ echoed: 'hi' })
		expect(firstCaptured(captured).method).toBe('echo')
	})

	test('throws RpcError carrying type + message on { error }', async () => {
		stubFetch(() =>
			new Response(JSON.stringify({ error: { type: 'forbidden', message: 'nope' } }), {
				status: 403,
				headers: { 'content-type': 'application/json' },
			})
		)
		const client = createRpcClient<AppRouter>({ baseUrl: 'https://x/api/rpc' })
		const error = await client.echo({ msg: 'hi' }).then(() => null, (err: unknown) => err)
		expect(error).toBeInstanceOf(RpcError)
		if (!(error instanceof RpcError)) throw new Error('expected RpcError')
		expect(error.type).toBe('forbidden')
		expect(error.message).toBe('nope')
	})

	test('RpcError carries loginUrl off a human-gated 401 envelope', async () => {
		stubFetch(() =>
			new Response(JSON.stringify({ error: { type: 'auth', message: 'login required', loginUrl: 'https://sso/login' } }), {
				status: 401,
				headers: { 'content-type': 'application/json' },
			})
		)
		// bounceOnAuth is on, but there is no `window` under bun → the guarded bounce no-ops and we throw.
		const client = createRpcClient<AppRouter>({ baseUrl: 'https://x/api/rpc', bounceOnAuth: true })
		const error = await client.echo({ msg: 'hi' }).then(() => null, (err: unknown) => err)
		expect(error).toBeInstanceOf(RpcError)
		if (!(error instanceof RpcError)) throw new Error('expected RpcError')
		expect(error.type).toBe('auth')
		expect(error.loginUrl).toBe('https://sso/login')
		expect(error.httpStatus).toBe(401)
	})

	test('throws RpcError(transport) on a non-JSON response', async () => {
		stubFetch(() => new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' }))
		const client = createRpcClient<AppRouter>({ baseUrl: 'https://x/api/rpc' })
		const error = await client.echo({ msg: 'hi' }).then(() => null, (err: unknown) => err)
		expect(error).toBeInstanceOf(RpcError)
		if (!(error instanceof RpcError)) throw new Error('expected RpcError')
		expect(error.type).toBe('transport')
	})
})
