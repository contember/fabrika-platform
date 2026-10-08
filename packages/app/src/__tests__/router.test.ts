import { describe, expect, test } from 'bun:test'
import { defineApp } from '../app.js'
import { matchRoutes, route } from '../router.js'
import type { Route } from '../router.js'
import { initRpc } from '../rpc/builder.js'
import { fakeExec, getRequest, record } from './helpers.js'

interface Ctx {
	value: number
}

const rpc = initRpc<Ctx>()
const apiRouter = rpc.router({})

const routes: Route<Ctx>[] = [
	route.get('/health', () => new Response('ok')),
	route.get('/api/:project/envelope', (_ctx, params) => new Response(params.project)),
	route.get('/public/*path', (_ctx, params) => new Response(params.path)),
	route.post('/users/:userId', (_ctx, params) => new Response(params.userId)),
	route.rpc('/api/rpc', apiRouter),
]

describe('matchRoutes', () => {
	test('an all-method route matches every HTTP method', () => {
		const all = route.all('/api/*path', () => new Response('ok'))

		expect(matchRoutes([all], new Request('https://x/api/items', { method: 'GET' }))?.route).toBe(all)
		expect(matchRoutes([all], new Request('https://x/api/items', { method: 'POST' }))?.route).toBe(all)
		expect(matchRoutes([all], new Request('https://x/api/items', { method: 'OPTIONS' }))?.route).toBe(all)
	})

	test('matches a static route', () => {
		const matched = matchRoutes(routes, getRequest('https://x/health'))
		expect(matched).not.toBeNull()
		expect(matched?.route.kind).toBe('http')
	})

	test('extracts a single param', () => {
		const matched = matchRoutes(routes, getRequest('https://x/api/acme/envelope'))
		expect(matched?.params).toEqual({ project: 'acme' })
	})

	test('url-decodes param values', () => {
		const matched = matchRoutes(routes, getRequest('https://x/api/a%20b/envelope'))
		expect(matched?.params).toEqual({ project: 'a b' })
	})

	test('malformed percent-encoding does not throw or match a parameterized route', () => {
		expect(matchRoutes(routes, getRequest('https://x/api/%/envelope'))).toBeNull()
		expect(matchRoutes(routes, getRequest('https://x/public/%'))).toBeNull()
	})

	test('method mismatch → no match', () => {
		const matched = matchRoutes(routes, new Request('https://x/users/u1', { method: 'GET' }))
		expect(matched).toBeNull()
	})

	test('matches a method-specific route', () => {
		const matched = matchRoutes(routes, new Request('https://x/users/u1', { method: 'POST' }))
		expect(matched?.params).toEqual({ userId: 'u1' })
	})

	test('unmatched path → null (fallback)', () => {
		const matched = matchRoutes(routes, getRequest('https://x/nope'))
		expect(matched).toBeNull()
	})

	test('rpc route matches a POST to its path', () => {
		const matched = matchRoutes(routes, new Request('https://x/api/rpc', { method: 'POST' }))
		expect(matched?.route.kind).toBe('rpc')
	})

	test('rpc route does not match a GET', () => {
		const matched = matchRoutes(routes, getRequest('https://x/api/rpc'))
		expect(matched).toBeNull()
	})

	test('segment-count mismatch → no match', () => {
		const matched = matchRoutes(routes, getRequest('https://x/api/acme/envelope/extra'))
		expect(matched).toBeNull()
	})

	test('a terminal wildcard captures the remaining path', async () => {
		const matched = matchRoutes(routes, getRequest('https://x/public/docs/getting-started'))
		if (matched?.route.kind !== 'http') throw new Error('expected http match')
		expect(matched.params).toEqual({ path: 'docs/getting-started' })
		const response = await matched.route.handler({ value: 1 }, matched.params)
		expect(await response.text()).toBe('docs/getting-started')
	})

	test('a terminal wildcard captures an empty remainder only after its slash', () => {
		expect(matchRoutes(routes, getRequest('https://x/public/'))?.params).toEqual({ path: '' })
		expect(matchRoutes(routes, getRequest('https://x/public'))).toBeNull()
	})

	test('a root wildcard still matches the root', () => {
		const all = route.all('/*path', () => new Response('root'))
		expect(matchRoutes([all], getRequest('https://x/'))?.params).toEqual({ path: '' })
		expect(matchRoutes([all], getRequest('https://x/a/b'))?.params).toEqual({ path: 'a/b' })
	})

	test('a terminal wildcard keeps a trailing slash in what it captures', () => {
		expect(matchRoutes(routes, getRequest('https://x/public/docs/'))?.params).toEqual({ path: 'docs/' })
	})

	test('a trailing slash is significant: /foo/ and /foo are different routes', () => {
		const foo = route.get('/foo', () => new Response('foo'))
		const fooSlash = route.get('/foo/', () => new Response('foo/'))
		// A gate `/foo/*` admits `/foo/`; the `/foo` route must not answer it.
		expect(matchRoutes([foo], getRequest('https://x/foo/'))).toBeNull()
		expect(matchRoutes([fooSlash], getRequest('https://x/foo'))).toBeNull()
		expect(matchRoutes([foo, fooSlash], getRequest('https://x/foo/'))?.route).toBe(fooSlash)
		expect(matchRoutes(routes, getRequest('https://x/health/'))).toBeNull()
	})

	test('the empty last segment of a trailing slash is not a parameter value', () => {
		expect(matchRoutes(routes, new Request('https://x/users/', { method: 'POST' }))).toBeNull()
	})

	test('a route pattern must start with a slash', () => {
		expect(() => route.get('health', () => new Response('nope'))).toThrow('a route pattern must start with /')
		expect(() => route.rpc('api/rpc', apiRouter)).toThrow('a route pattern must start with /')
	})

	test('a non-terminal wildcard is rejected at definition time', () => {
		expect(() => route.get('/public/*path/tail', () => new Response('nope'))).toThrow('a wildcard route segment must be terminal')
	})
})

/**
 * A request whose `url` is the string as written. Bun's `Request` resolves dot segments on
 * construction; another runtime may hand them to the application unresolved.
 */
class RawUrlRequest extends Request {
	constructor(private readonly raw: string) {
		super(raw)
	}

	override get url(): string {
		return this.raw
	}
}

describe('defineApp — a non-canonical path is a 400 before routing', () => {
	let reached = 0
	const app = defineApp<Record<string, never>, Ctx>({
		context: () => {
			reached++
			return { value: 1 }
		},
		routes: [
			route.get('/admin/users', () => new Response('admin')),
			route.get('/api/:project/envelope', (_ctx, params) => new Response(params.project)),
			route.get('/public/*path', (_ctx, params) => new Response(params.path)),
			route.rpc('/api/rpc', apiRouter),
		],
		assets: () => ({ fetch: () => Promise.resolve(new Response('spa')) }),
	})

	test.each([
		['a repeated slash', 'https://x//admin/users'],
		['a dot-dot segment', 'https://x/a/../admin/users'],
		['an encoded dot-dot segment', 'https://x/a/%2e%2e/admin/users'],
		['an encoded slash inside a parameter', 'https://x/api/a%2Fb/envelope'],
		['an encoded slash under a wildcard', 'https://x/public/x%2Fy'],
		['an encoded backslash', 'https://x/public/x%5Cy'],
		['a dot segment', 'https://x/admin/./users'],
		['an empty segment before a trailing slash', 'https://x/admin/users//'],
		['a repeated slash before an RPC mount', 'https://x//api/rpc'],
		['a malformed percent escape in a parameter', 'https://x/api/%FF/envelope'],
	])('%s', async (_name, url) => {
		reached = 0
		const response = await app.fetch(new RawUrlRequest(url), {}, fakeExec())
		expect(response.status).toBe(400)
		expect(record(record(await response.json())['error'])['type']).toBe('bad_request')
		expect(reached).toBe(0)
	})

	test('a canonical path still routes, and the root is canonical', async () => {
		expect(await (await app.fetch(getRequest('https://x/admin/users'), {}, fakeExec())).text()).toBe('admin')
		expect(await (await app.fetch(getRequest('https://x/'), {}, fakeExec())).text()).toBe('spa')
	})

	test('a trailing slash is canonical but never reaches the route without it', async () => {
		const response = await app.fetch(getRequest('https://x/admin/users/'), {}, fakeExec())
		expect(response.status).toBe(200)
		expect(await response.text()).toBe('spa')
	})
})

describe('typed params', () => {
	test('handler receives params typed from the pattern literal', async () => {
		const r = route.get('/orgs/:orgId/repos/:repoId', (_ctx: Ctx, params) => {
			// Type-level: params is { orgId: string; repoId: string }.
			return new Response(`${params.orgId}/${params.repoId}`)
		})
		const matched = matchRoutes([r], getRequest('https://x/orgs/o1/repos/r1'))
		if (matched?.route.kind !== 'http') throw new Error('expected http match')
		const response = await matched.route.handler({ value: 1 }, matched.params)
		expect(await response.text()).toBe('o1/r1')
	})

	test('handler receives a named wildcard parameter', async () => {
		const r = route.get('/files/*path', (_ctx: Ctx, params) => new Response(params.path))
		const matched = matchRoutes([r], getRequest('https://x/files/a/b.txt'))
		if (matched?.route.kind !== 'http') throw new Error('expected http match')
		const response = await matched.route.handler({ value: 1 }, matched.params)
		expect(await response.text()).toBe('a/b.txt')
	})
})
