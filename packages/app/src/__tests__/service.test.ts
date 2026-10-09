// `@fabrika/app/service`: the refusals of `defineServiceContract`, then `serveService`'s fixed order — canonical path
// (400), selection (404), the proxy's endpoint on a `service` row (503), the handler by row id. Deny cases first.

import { type BodyAdmission, ENDPOINT_HEADER, formatEndpointHeader, requirementDigest } from '@fabrika/auth-core'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
	defineServiceContract,
	serveService,
	type ServiceArtifact,
	ServiceContractError,
	type ServiceEndpointOptions,
	ServiceHandlersError,
} from '../service/index.js'

const JSON_BODY: BodyAdmission = { contentTypes: ['application/json'], maxBytes: null }

const SERVICE = defineServiceContract('console', (s) => ({
	endpoints: {
		'health': s.health('GET', '/healthz'),
		'webhook': s.protocol('POST', '/webhooks/:connectionId'),
		'rpc': s.service('POST', '/api/rpc', { callers: ['human', 'machine'], admission: JSON_BODY }),
		'mcp': s.service('*', '/mcp', { callers: ['oauth'], scopes: ['authoring'] }),
		'spa': s.service('GET', '/*', { callers: ['human'] }),
		'disabled': null,
	},
	reservedPrefixes: ['/api'],
}))

type Id = typeof SERVICE extends ServiceArtifact<infer RowId> ? RowId : never

const EXEC = { waitUntil: () => {} }

function header(service: ServiceArtifact, id: string): string {
	const row = service.endpoints.find((entry) => entry.id === id)
	if (row === undefined) throw new Error(`no row '${id}'`)
	return formatEndpointHeader(row.id, requirementDigest({ ...row, delegation: null }))
}

function serve() {
	const calls: { id: Id; params: Readonly<Record<string, string>> }[] = []
	const handler = (id: Id) => ({ params }: { params: Readonly<Record<string, string>> }) => {
		calls.push({ id, params })
		return Response.json({ served: id })
	}
	const app = serveService(SERVICE, {
		health: handler('health'),
		webhook: handler('webhook'),
		rpc: handler('rpc'),
		mcp: handler('mcp'),
		spa: handler('spa'),
		disabled: () => {
			throw new Error('a row the composition left out is never served')
		},
	})
	const send = (method: string, path: string, headers: Record<string, string> = {}) =>
		app.fetch(new Request(`http://console.test${path}`, { method, headers }), undefined, EXEC)
	return { calls, send }
}

let errors: ReturnType<typeof spyOn>
beforeEach(() => {
	errors = spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
	errors.mockRestore()
})

describe('defineServiceContract refuses', () => {
	test('an id that is an application environment, or empty', () => {
		for (const id of ['notes@prod', '']) {
			expect(() => defineServiceContract(id, (s) => ({ endpoints: { health: s.health('GET', '/healthz') }, reservedPrefixes: [] }))).toThrow(
				ServiceContractError,
			)
		}
	})

	test('an oauth caller without scopes, scopes without it, and empty scopes', () => {
		const cases: ServiceEndpointOptions[] = [
			{ callers: ['oauth'] },
			{ callers: ['human'], scopes: ['authoring'] },
			{ callers: ['oauth'], scopes: [] },
		]
		for (const options of cases) {
			expect(() => defineServiceContract('console', (s) => ({ endpoints: { mcp: s.service('*', '/mcp', options) }, reservedPrefixes: [] })))
				.toThrow(ServiceContractError)
		}
	})

	test('a table the matcher refuses: * beside a method on one shape, an invalid path, an invalid reserved prefix', () => {
		expect(() =>
			defineServiceContract('console', (s) => ({
				endpoints: { any: s.protocol('*', '/admin/*'), get: s.protocol('GET', '/admin/*') },
				reservedPrefixes: [],
			}))
		).toThrow(/both serve/)
		expect(() => defineServiceContract('console', (s) => ({ endpoints: { bad: s.protocol('GET', '/a/*/b') }, reservedPrefixes: [] }))).toThrow(
			ServiceContractError,
		)
		expect(() => defineServiceContract('console', (s) => ({ endpoints: { ok: s.protocol('GET', '/a') }, reservedPrefixes: ['/api/'] }))).toThrow(
			ServiceContractError,
		)
	})
})

describe('defineServiceContract', () => {
	test('a row the composition leaves out has no row; every other row keeps its record key as its id', () => {
		expect(SERVICE.endpoints.map((row) => row.id)).toEqual(['health', 'webhook', 'rpc', 'mcp', 'spa'])
		expect(SERVICE.endpoints.find((row) => row.id === 'rpc')).toEqual({
			id: 'rpc',
			kind: 'service',
			method: 'POST',
			path: '/api/rpc',
			callers: ['human', 'machine'],
			requirement: { kind: 'authenticated' },
			admission: JSON_BODY,
			oauth: null,
		})
		expect(SERVICE.endpoints.find((row) => row.id === 'mcp')?.oauth).toEqual({ scopes: ['authoring'] })
	})
})

describe('serveService', () => {
	test('refuses to start without a handler for every row', () => {
		// Widened to any id, so only the runtime check stands between the missing 'b' and a request.
		const partial: ServiceArtifact = defineServiceContract('console', (s) => ({
			endpoints: { a: s.protocol('GET', '/a'), b: s.protocol('GET', '/b') },
			reservedPrefixes: [],
		}))
		expect(() => serveService(partial, { a: () => new Response('a') })).toThrow(ServiceHandlersError)
	})

	test('a non-canonical path is 400 before anything else', async () => {
		const { calls, send } = serve()
		const response = await send('GET', '//healthz')
		expect(response.status).toBe(400)
		expect(calls).toEqual([])
	})

	test('a request no row selects is 404: an unknown path under a reserved prefix, and a method no row serves', async () => {
		const { calls, send } = serve()
		const probes: [string, string][] = [['GET', '/api/other'], ['GET', '/api/rpc'], ['POST', '/page'], ['HEAD', '/page']]
		for (const [method, path] of probes) {
			const response = await send(method, path, { [ENDPOINT_HEADER]: header(SERVICE, 'spa') })
			expect(response.status).toBe(404)
		}
		expect(calls).toEqual([])
	})

	test('a service row without the proxy endpoint, with a malformed one, another row or another digest is 503', async () => {
		const { calls, send } = serve()
		const other = header(SERVICE, 'spa')
		const staleDigest = formatEndpointHeader('rpc', `sha256:${'0'.repeat(64)}`)
		const presented: Record<string, string>[] = [{}, { [ENDPOINT_HEADER]: 'rpc' }, { [ENDPOINT_HEADER]: other }, { [ENDPOINT_HEADER]: staleDigest }]
		for (const headers of presented) {
			const response = await send('POST', '/api/rpc', headers)
			expect(response.status).toBe(503)
			expect(await response.json()).toEqual({ error: { type: 'unavailable', message: 'Service unavailable' } })
		}
		expect(calls).toEqual([])
		const logged = errors.mock.calls.flat().join('\n')
		expect(logged).toContain("'rpc'")
		expect(logged).not.toContain(staleDigest)
	})

	test('a service row with its own endpoint and digest reaches its handler; so does an oauth row', async () => {
		const { calls, send } = serve()
		expect((await send('POST', '/api/rpc', { [ENDPOINT_HEADER]: header(SERVICE, 'rpc') })).status).toBe(200)
		expect((await send('DELETE', '/mcp', { [ENDPOINT_HEADER]: header(SERVICE, 'mcp') })).status).toBe(200)
		expect((await send('GET', '/deep/page', { [ENDPOINT_HEADER]: header(SERVICE, 'spa') })).status).toBe(200)
		expect(calls.map((call) => call.id)).toEqual(['rpc', 'mcp', 'spa'])
	})

	test('a protocol or health row needs no endpoint and ignores one another hop forwarded', async () => {
		const { calls, send } = serve()
		expect((await send('GET', '/healthz')).status).toBe(200)
		expect((await send('POST', '/webhooks/c1')).status).toBe(200)
		// A private hop carries the calling service's own `X-Fabrika-Endpoint`, which names none of these rows.
		expect((await send('POST', '/webhooks/c1', { [ENDPOINT_HEADER]: header(SERVICE, 'rpc') })).status).toBe(200)
		expect(calls.map((call) => call.id)).toEqual(['health', 'webhook', 'webhook'])
	})

	test('path parameters reach the handler decoded; one that does not decode is 400', async () => {
		const { calls, send } = serve()
		expect((await send('POST', '/webhooks/a%20b')).status).toBe(200)
		expect(calls).toEqual([{ id: 'webhook', params: { connectionId: 'a b' } }])
		expect((await send('POST', '/webhooks/%E0%A4%A')).status).toBe(400)
		expect(calls).toHaveLength(1)
	})

	test('a handler that throws is answered by onError', async () => {
		const service = defineServiceContract('console', (s) => ({ endpoints: { boom: s.protocol('GET', '/boom') }, reservedPrefixes: [] }))
		const app = serveService(service, {
			boom: () => {
				throw new Error('postgres://user:secret@db/x')
			},
		}, { onError: () => new Response('failed', { status: 500 }) })
		const response = await app.fetch(new Request('http://console.test/boom'), undefined, EXEC)
		expect(response.status).toBe(500)
		expect(await response.text()).toBe('failed')
	})
})
