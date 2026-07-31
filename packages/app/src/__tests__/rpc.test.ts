import type { AuthContext } from '@fabrika/auth'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { BadRequestError, UnauthorizedError } from '../errors.js'
import { initRpc } from '../rpc/builder.js'
import { dispatchRpcRequest } from '../rpc/dispatcher.js'
import type { InferRouterClient } from '../rpc/types.js'
import type { StandardSchemaV1 } from '../standard-schema.js'
import { fakeAuth, jsonRequest, raise, record } from './helpers.js'

interface Ctx {
	auth: AuthContext
}

const t = initRpc<Ctx>()

const appRouter = t.router({
	// No output schema → result returned as-is.
	echo: t.procedure.input(z.object({ msg: z.string() })).handler(({ input }) => ({ echoed: input.msg })),
	// Output schema present and satisfied.
	double: t.procedure
		.input(z.object({ n: z.number() }))
		.output(z.object({ doubled: z.number() }))
		.query(({ input }) => ({ doubled: input.n * 2 })),
	// Output schema present and violated at runtime (min length).
	badOutput: t.procedure
		.input(z.object({}))
		.output(z.object({ x: z.string().min(5) }))
		.handler(() => ({ x: 'ab' })),
	// Authz requirement.
	secret: t.procedure.input(z.object({})).require('read:secret').handler(() => ({ ok: true })),
	math: t.router({
		add: t.procedure.input(z.object({ a: z.number(), b: z.number() })).mutation(({ input }) => input.a + input.b),
	}),
})

// Compile-time: a procedure WITHOUT `.output()` infers its result type for the client (not `unknown`).
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Expect<T extends true> = T
type EchoResult = Awaited<ReturnType<InferRouterClient<typeof appRouter>['echo']>>
type _EchoInferred = Expect<Equals<EchoResult, { echoed: string }>>

async function dispatch(body: unknown, ctx: Ctx = { auth: fakeAuth(['*']) }) {
	const response = await dispatchRpcRequest({ router: appRouter, ctx, request: jsonRequest('https://x/rpc', body) })
	return { status: response.status, body: await response.json() }
}

describe('rpc dispatch — single', () => {
	test('resolves a procedure and returns { result }', async () => {
		const { status, body } = await dispatch({ method: 'echo', input: { msg: 'hi' } })
		expect(status).toBe(200)
		expect(record(record(body)['result'])['echoed']).toBe('hi')
	})

	test('resolves a nested procedure', async () => {
		const { status, body } = await dispatch({ method: 'math.add', input: { a: 2, b: 3 } })
		expect(status).toBe(200)
		expect(record(body)['result']).toBe(5)
	})

	test('input validation failure → 400 with issues', async () => {
		const { status, body } = await dispatch({ method: 'echo', input: { msg: 123 } })
		expect(status).toBe(400)
		expect(record(record(body)['error'])['type']).toBe('validation')
		expect(record(record(body)['error'])['issues']).toBeDefined()
	})

	test('unknown method → 404 method_not_found', async () => {
		const { status, body } = await dispatch({ method: 'nope.missing', input: null })
		expect(status).toBe(404)
		expect(record(record(body)['error'])['type']).toBe('method_not_found')
	})
})

describe('rpc dispatch — output schema', () => {
	test('present output schema validates and passes through', async () => {
		const { status, body } = await dispatch({ method: 'double', input: { n: 4 } })
		expect(status).toBe(200)
		expect(record(record(body)['result'])['doubled']).toBe(8)
	})

	test('present output schema violation → 500 internal', async () => {
		const { status, body } = await dispatch({ method: 'badOutput', input: {} })
		expect(status).toBe(500)
		expect(record(record(body)['error'])['type']).toBe('internal')
	})
})

describe('rpc dispatch — .require authz', () => {
	test('allows when auth.can returns true', async () => {
		const { status, body } = await dispatch({ method: 'secret', input: {} }, { auth: fakeAuth(['read:secret']) })
		expect(status).toBe(200)
		expect(record(record(body)['result'])['ok']).toBe(true)
	})

	test('denies with 403 forbidden when auth.can returns false', async () => {
		const { status, body } = await dispatch({ method: 'secret', input: {} }, { auth: fakeAuth([]) })
		expect(status).toBe(403)
		expect(record(record(body)['error'])['type']).toBe('forbidden')
	})

	test('passes the resolved scope to auth.can', async () => {
		let seenScope: unknown = 'unset'
		const auth: AuthContext = {
			ok: true,
			principal: null,
			can(_action, scope) {
				seenScope = scope
				return true
			},
			scopedTo() {
				return null
			},
			async audit() {},
		}
		const scopedRouter = t.router({
			open: t.procedure
				.input(z.object({ projectId: z.string() }))
				.require('project:read', (input) => ({ type: 'project', value: input.projectId }))
				.handler(() => ({ ok: true })),
		})
		const response = await dispatchRpcRequest({
			router: scopedRouter,
			ctx: { auth },
			request: jsonRequest('https://x/rpc', { method: 'open', input: { projectId: 'p1' } }),
		})
		expect(response.status).toBe(200)
		expect(seenScope).toEqual({ type: 'project', value: 'p1' })
	})
})

describe('rpc dispatch — error status from the thrown error httpStatus', () => {
	const r = initRpc<Ctx>()
	const router = r.router({
		bad: r.procedure.input(z.object({})).handler(() => raise(new BadRequestError('nope'))),
		teapot: r.procedure.input(z.object({})).handler(() => raise({ httpStatus: 418, type: 'teapot', message: 'short and stout' })),
		boom: r.procedure.input(z.object({})).handler(() => raise(new Error('kaboom'))),
		login: r.procedure.input(z.object({})).handler(() => raise(new UnauthorizedError('login required', { loginUrl: 'https://iam.test/auth/login' }))),
	})
	async function d(method: string) {
		const res = await dispatchRpcRequest({ router, ctx: { auth: fakeAuth(['*']) }, request: jsonRequest('https://x/rpc', { method, input: {} }) })
		return { status: res.status, body: await res.json() }
	}

	test('BadRequestError → 400 with type bad_request (not 500)', async () => {
		const { status, body } = await d('bad')
		expect(status).toBe(400)
		expect(record(record(body)['error'])['type']).toBe('bad_request')
	})

	test('a thrown structural { httpStatus } maps to that status', async () => {
		const { status, body } = await d('teapot')
		expect(status).toBe(418)
		expect(record(record(body)['error'])['type']).toBe('teapot')
	})

	test('a plain Error → 500 internal', async () => {
		const { status, body } = await d('boom')
		expect(status).toBe(500)
		expect(record(record(body)['error'])['type']).toBe('internal')
	})

	test('a structural auth error preserves loginUrl', async () => {
		const { status, body } = await d('login')
		expect(status).toBe(401)
		expect(record(record(body)['error'])['loginUrl']).toBe('https://iam.test/auth/login')
	})
})

describe('rpc dispatch — accepts any Standard Schema (not just zod)', () => {
	// A hand-rolled validator using ONLY the `~standard` contract — no zod anywhere.
	const customInput: StandardSchemaV1<unknown, { msg: string }> = {
		'~standard': {
			version: 1,
			vendor: 'custom',
			validate(value) {
				if (value && typeof value === 'object' && 'msg' in value && typeof value.msg === 'string') {
					return { value: { msg: value.msg } }
				}
				return { issues: [{ message: 'msg must be a string', path: ['msg'] }] }
			},
		},
	}
	const r = initRpc<Ctx>()
	const router = r.router({
		echo: r.procedure.input(customInput).handler(({ input }) => ({ echoed: input.msg })),
	})
	async function d(input: unknown) {
		const res = await dispatchRpcRequest({ router, ctx: { auth: fakeAuth(['*']) }, request: jsonRequest('https://x/rpc', { method: 'echo', input }) })
		return { status: res.status, body: await res.json() }
	}

	test('valid input passes through the custom validator', async () => {
		const { status, body } = await d({ msg: 'hi' })
		expect(status).toBe(200)
		expect(record(record(body)['result'])['echoed']).toBe('hi')
	})

	test('invalid input → 400 with the custom issue message (path-prefixed)', async () => {
		const { status, body } = await d({ msg: 123 })
		expect(status).toBe(400)
		expect(record(record(body)['error'])['type']).toBe('validation')
		expect(record(record(body)['error'])['message']).toContain('msg must be a string')
	})
})

describe('rpc dispatch — batch', () => {
	test('runs every call and returns { batch: [...] }', async () => {
		const { status, body } = await dispatch({
			batch: [
				{ method: 'echo', input: { msg: 'a' } },
				{ method: 'math.add', input: { a: 1, b: 1 } },
				{ method: 'nope', input: null },
			],
		})
		expect(status).toBe(200)
		const batch = record(body)['batch']
		if (!Array.isArray(batch)) throw new Error('expected batch array')
		expect(batch.length).toBe(3)
		expect(record(record(batch[0])['result'])['echoed']).toBe('a')
		expect(record(batch[1])['result']).toBe(2)
		expect(record(record(batch[2])['error'])['type']).toBe('method_not_found')
	})
})

describe('rpc dispatch — malformed body', () => {
	test('non-{method} body → 400 validation', async () => {
		const { status, body } = await dispatch({ notAMethod: true })
		expect(status).toBe(400)
		expect(record(record(body)['error'])['type']).toBe('validation')
	})
})
