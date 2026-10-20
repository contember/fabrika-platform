// A public procedure that keeps a 0.5 form's URL and widget action (`http.path`, `challenge.action`): what it compiles
// to, what `compileContract` refuses, which row the proxy's planner selects, and the path the typed client calls.

import { compileEndpointTable, planEndpoint } from '@fabrika/auth-core'
import { contractProxyTable, proxyEndpointRowSchema } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { createClient, type RpcFetch } from '../client'
import { compileContract, ContractError } from '../contract'
import { app } from './public-fixture/src/app-kit'
import { tables } from './public-fixture/src/db/tables'

const Register = z.strictObject({ name: z.string(), challengeToken: z.string() })
const Empty = z.strictObject({})
const PUBLIC = { public: true } as const
const challenge = { provider: 'turnstile', secret: 'TURNSTILE_SECRET' } as const

/** `options` with `key` set, as a hand-written declaration would set what the kit's types refuse. */
const withField = <const T extends object>(options: T, key: string, value: unknown): T => {
	Object.defineProperty(options, key, { value, enumerable: true })
	return options
}

function problemsOf(compile: () => unknown): readonly string[] {
	try {
		compile()
	} catch (error) {
		if (error instanceof ContractError) return error.problems
		throw error
	}
	throw new Error('the contract compiled')
}

const visitors = app.group({}, (r) => ({
	register: r.mutation({
		input: Register,
		output: Empty,
		access: PUBLIC,
		actions: ['intake.register'],
		http: { path: '/register' },
		admission: { challenge: { ...challenge, action: 'register' } },
	}).handle(() => ({})),
	resend: r.mutation({ input: Register, output: Empty, access: PUBLIC, actions: ['intake.register'], admission: { challenge } })
		.handle(() => ({})),
}))

const staff = app.group({ callers: ['human'] }, (r) => ({
	submissions: r.query({ output: Empty, access: { action: 'intake.read', app: true } }).handle(() => ({})),
}))

/** The 0.5 shape of the intake: a public page at `/`, staff pages at `/hr`, and the form's URL beside them. */
const intake = app.contract((c) => ({
	api: c.rpc('/api', { visitors, staff }),
	site: c.spa('/', { dir: 'dist/site', access: PUBLIC }),
	hr: c.spa('/hr', { dir: 'dist/hr', access: { member: true } }),
	health: c.health('/healthz'),
}))

/** A contract whose one public procedure declares `http` and `admission` as given, mounted beside `extra`. */
function registering(http: object, admission: object = {}) {
	const group = app.group({}, (r) => ({
		register: r.mutation({ input: Register, output: Empty, access: PUBLIC, actions: ['intake.register'], ...withField({}, 'http', http), admission })
			.handle(() => ({})),
	}))
	return app.contract((c) => ({
		api: c.rpc('/api', { visitors: group, staff }),
		hr: c.spa('/hr', { dir: 'dist/hr', access: { member: true } }),
		hooks: app.webhook('/hooks/billing', {
			input: z.strictObject({}),
			scheme: 'stripe',
			boundTo: 'app',
			actions: ['intake.register'],
		}).handle(() => undefined),
		health: c.health('/healthz'),
	}))
}

describe('a public procedure at a path of its own', () => {
	const artifact = compileContract(intake, tables)

	test('its row carries the path and keeps its endpoint id; the challenge carries the declared action', () => {
		expect(artifact.endpoints.find((row) => row.id === 'api.visitors.register')).toMatchObject({ kind: 'public', method: 'POST', path: '/register' })
		expect(artifact.procedures?.['api.visitors.register']?.challenge).toEqual({ ...challenge, action: 'register' })
		expect(artifact.declared?.['api.visitors.register']?.actions).toEqual(['intake.register'])
	})

	test('a procedure without one keeps the derived path and the derived action', () => {
		expect(artifact.endpoints.find((row) => row.id === 'api.visitors.resend')?.path).toBe('/api/visitors.resend')
		expect(artifact.procedures?.['api.visitors.resend']?.challenge).toEqual({ ...challenge, action: 'api_visitors_resend' })
	})

	test("the proxy's planner selects it at its path; the root SPA keeps every other path and GET /register", () => {
		const table = contractProxyTable(artifact)
		for (const row of table.endpoints) {
			expect(proxyEndpointRowSchema.safeParse(row).success).toBe(true)
		}
		const compiled = compileEndpointTable(table)
		const selected = (method: string, path: string) => {
			const plan = planEndpoint(compiled, method, path)
			return plan.outcome === 'endpoint' ? plan.endpoint.id : plan.outcome
		}
		expect(selected('POST', '/register')).toBe('api.visitors.register')
		expect(selected('POST', '/api/visitors.register')).toBe('no-endpoint')
		expect(selected('GET', '/register')).toBe('site')
		expect(selected('POST', '/api/visitors.resend')).toBe('api.visitors.resend')
	})

	test('the typed client calls the declared path, and the derived one for every other procedure', async () => {
		const urls: string[] = []
		const fetch: RpcFetch = (input) => {
			urls.push(String(input))
			return Promise.resolve(Response.json({ result: {} }))
		}
		const api = createClient(intake, 'api', { baseUrl: 'https://intake.example', fetch })
		await api.visitors.register({ name: 'Visitor', challengeToken: 't' })
		await api.visitors.resend({ name: 'Visitor', challengeToken: 't' })
		expect(urls).toEqual(['https://intake.example/register', 'https://intake.example/api/visitors.resend'])
	})
})

describe('compileContract refuses an own path', () => {
	test('on a credentialed procedure', () => {
		const group = app.group({ callers: ['human'] }, (r) => ({
			list: r.query({ output: Empty, access: { action: 'intake.read', app: true }, ...withField({}, 'http', { path: '/list' }) }).handle(() => ({})),
		}))
		expect(problemsOf(() => compileContract(app.contract((c) => ({ api: c.rpc('/api', { staff: group }) })), tables))).toEqual([
			"procedure 'api.staff.list': declares http.path, which only a public procedure does: its caller is outside the application, and every other caller uses the typed client",
		])
	})

	test('that is no literal path, or lies under /__fabrika', () => {
		// A path the planner cannot read is refused by the endpoint table too, after the problem that names http.path.
		for (const path of ['register', '/register/', '/:id', '/.well-known/x', '/a b']) {
			expect(problemsOf(() => compileContract(registering({ path }), tables))[0]).toEqual(
				`procedure 'api.visitors.register': http.path ${
					JSON.stringify(path)
				} is not a literal path (allowed: '/register', segments of letters, digits and '._~-', no trailing '/')`,
			)
		}
		expect(problemsOf(() => compileContract(registering({ path: '/__fabrika/register' }), tables))).toEqual([
			"procedure 'api.visitors.register': http.path '/__fabrika/register' is under /__fabrika, which the framework reserves",
		])
	})

	test("under any mount's prefix or path, its own mount's included", () => {
		const cases: [string, string, string][] = [
			['/api/register', 'api', '/api'],
			['/api', 'api', '/api'],
			['/hr', 'hr', '/hr'],
			['/hr/register', 'hr', '/hr'],
			['/hooks/billing', 'hooks', '/hooks/billing'],
			['/hooks/billing/register', 'hooks', '/hooks/billing'],
			['/healthz', 'health', '/healthz'],
		]
		for (const [path, mount, prefix] of cases) {
			expect(problemsOf(() => compileContract(registering({ path }), tables))).toEqual([
				`procedure 'api.visitors.register': http.path '${path}' lies under mount '${mount}' ('${prefix}'), which serves its paths itself (allowed: a path outside every mount's prefix, such as '/register')`,
			])
		}
	})

	test('that another endpoint serves with the same method', () => {
		const group = app.group({}, (r) => ({
			register: r.mutation({ output: Empty, access: PUBLIC, actions: ['intake.register'], http: { path: '/register' } }).handle(() => ({})),
			signup: r.mutation({ output: Empty, access: PUBLIC, actions: ['intake.register'], http: { path: '/register' } }).handle(() => ({})),
		}))
		expect(problemsOf(() => compileContract(app.contract((c) => ({ api: c.rpc('/api', { visitors: group }) })), tables))).toEqual([
			"endpoints: the endpoint table is invalid:\n- 'api.visitors.signup' and 'api.visitors.register' both serve POST /register",
		])
	})

	test('beside a credentialed root SPA it is served, as a 0.5 form was: the root answers only what no endpoint claims', () => {
		const group = app.group({}, (r) => ({
			register: r.mutation({ output: Empty, access: PUBLIC, actions: ['intake.register'], http: { path: '/register' } }).handle(() => ({})),
		}))
		const artifact = compileContract(
			app.contract((c) => ({ api: c.rpc('/api', { visitors: group }), site: c.spa('/', { dir: 'dist', access: { member: true } }) })),
			tables,
		)
		expect(artifact.endpoints.map((row) => `${row.method} ${row.path} ${row.id}`)).toEqual([
			'POST /register api.visitors.register',
			'GET /* site',
		])
	})
})

describe("compileContract refuses a challenge's action", () => {
	test('that the provider does not admit', () => {
		for (const action of ['', 'a.b', 'x'.repeat(33), 42]) {
			expect(problemsOf(() => compileContract(registering({ path: '/register' }, { challenge: { ...challenge, action } }), tables))).toEqual([
				`procedure 'api.visitors.register': challenge.action ${
					JSON.stringify(action)
				} is not a widget action (allowed: at most 32 letters, digits, '_' or '-', such as 'register')`,
			])
		}
	})

	test('derived from an endpoint id longer than the provider admits, naming challenge.action', () => {
		const group = app.group({}, (r) => ({
			registerForTheAutumnIntake: r.mutation({ input: Register, output: Empty, access: PUBLIC, actions: ['intake.register'], admission: { challenge } })
				.handle(() => ({})),
		}))
		const contract = app.contract((c) => ({ api: c.rpc('/api', { visitors: group }) }))
		expect(problemsOf(() => compileContract(contract, tables))).toEqual([
			"procedure 'api.visitors.registerForTheAutumnIntake': its challenge action is its endpoint id with '_' for '.', 'api_visitors_registerForTheAutumnIntake', longer than the 32 characters the provider admits (allowed: challenge.action, such as 'register')",
		])
	})

	test('that another procedure verifies with, declared or derived', () => {
		const group = app.group({}, (r) => ({
			register: r.mutation({
				input: Register,
				output: Empty,
				access: PUBLIC,
				actions: ['intake.register'],
				admission: { challenge: { ...challenge, action: 'api_visitors_resend' } },
			}).handle(() => ({})),
			resend: r.mutation({ input: Register, output: Empty, access: PUBLIC, actions: ['intake.register'], admission: { challenge } })
				.handle(() => ({})),
		}))
		expect(problemsOf(() => compileContract(app.contract((c) => ({ api: c.rpc('/api', { visitors: group }) })), tables))).toEqual([
			"procedure 'api.visitors.resend': its challenge action 'api_visitors_resend' is the action of 'api.visitors.register' too, so a token solved for one would pass the other (allowed: challenge.action unique to each procedure)",
		])
	})
})
