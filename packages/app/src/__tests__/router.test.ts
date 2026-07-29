import { describe, expect, test } from 'bun:test'
import { matchRoutes, route } from '../router.js'
import type { Route } from '../router.js'
import { initRpc } from '../rpc/builder.js'
import { getRequest } from './helpers.js'

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
		const matched = matchRoutes(routes, getRequest('https://x/api/a%2Fb/envelope'))
		expect(matched?.params).toEqual({ project: 'a/b' })
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

	test('a terminal wildcard may capture an empty remainder', () => {
		const matched = matchRoutes(routes, getRequest('https://x/public/'))
		expect(matched?.params).toEqual({ path: '' })
	})

	test('a non-terminal wildcard is rejected at definition time', () => {
		expect(() => route.get('/public/*path/tail', () => new Response('nope'))).toThrow('a wildcard route segment must be terminal')
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
