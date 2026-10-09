// Route coverage of work unit B10: every route a service's `defineApp` declares is served by the rows listed for it
// or, explicitly, by none. A request that reaches a route reaches one of its rows or no row at all, never another
// route's row; every row serves some route; every listed pairing occurs. Selection only — the differential
// (`service-parity.test.ts`) compares the decisions. A route no row covers would otherwise become a production 403.

import { compileEndpointTable, type InstallationEndpointTable, planEndpoint } from '@fabrika/auth-core'
import { controlServiceContract } from '@fabrika/control/service'
import { iamServiceContract, type IamServiceOptions } from '@fabrika/iam/service'
import { OPERATIONS_PRIVATE_SERVICE, OPERATIONS_PUBLIC_SERVICE } from '@fabrika/operations/service'
import { describe, expect, test } from 'bun:test'
import {
	FROZEN_CONTROL_BUILDER_PATHS,
	FROZEN_CONTROL_MCP,
	FROZEN_CONTROL_ROUTES,
	FROZEN_IAM_MINT_PATHS,
	FROZEN_OPERATIONS_ROUTES,
	frozenIamRoutes,
	type FrozenRoute,
} from './frozen'
import { legacyRouter, METHODS, probePaths } from './harness'

/** The rows that serve a route; an empty list says no row does, and `why`. */
type Served = { readonly rows: readonly [string, ...string[]] } | { readonly rows: readonly []; readonly why: string }

interface Coverage {
	readonly name: string
	readonly table: InstallationEndpointTable
	/** The route or pre-route surface a request reaches. */
	readonly legacy: (method: string, path: string) => string | null
	readonly served: Readonly<Record<string, Served>>
	readonly handlers: readonly string[]
	readonly paths: readonly string[]
}

const none = (why: string): Served => ({ rows: [], why })

function controlLegacy(mcp: boolean): (method: string, path: string) => string | null {
	const router = legacyRouter(FROZEN_CONTROL_ROUTES)
	return (method, path) => {
		const normalized = `/${path.split('/').filter((segment) => segment !== '').join('/')}`
		if (mcp && normalized === FROZEN_CONTROL_MCP.path && FROZEN_CONTROL_MCP.methods.includes(method)) return 'mcp'
		if (FROZEN_CONTROL_BUILDER_PATHS.includes(path)) return `builder:${path}`
		return router(method, path)
	}
}

const patterns = (routes: readonly FrozenRoute[]) => routes.map((entry) => entry.pattern)

const CONTROL_SERVED: Readonly<Record<string, Served>> = {
	'builder:/.well-known/fabrika-builder': { rows: ['builder-discovery'] },
	'builder:/builder/connect': { rows: ['builder-connect'] },
	'/healthz': { rows: ['health'] },
	'/api/health': { rows: ['api-health'] },
	'/webhooks/github/:connectionId': { rows: ['github-webhook'] },
	'/webhooks': { rows: ['webhooks-root'] },
	'/webhooks/*path': none('/webhooks is reserved: only the GitHub webhook row is below it'),
	'/api/source/github/manifest/:connectionId': { rows: ['github-manifest'] },
	'/api/source/github/callback': { rows: ['github-callback'] },
	'/iam/admin': { rows: ['iam-admin-root'] },
	'/iam/admin/*path': { rows: ['iam-admin-rpc'] },
	'/operations/api/rpc': { rows: ['operations-rpc'] },
	'/operations/api': { rows: ['operations-api-root'] },
	'/operations/api/*path': none('/operations/api is reserved: only its RPC mount is below it'),
	'/api/rpc': { rows: ['rpc'] },
	'/api': { rows: ['api-root'] },
	'/api/*path': none('/api is reserved: an unknown path below it reaches no row'),
	// `/mcp` on a method `withMcp` passed on, or with MCP off, reached the SPA route.
	'/*path': { rows: ['console', 'mcp'] },
}

const CONTROL_PATHS = probePaths([...patterns(FROZEN_CONTROL_ROUTES), ...FROZEN_CONTROL_BUILDER_PATHS], ['/mcp', '/mcp/', '/iam/admin/rpc'])

const OPERATIONS_PATHS = probePaths(patterns(FROZEN_OPERATIONS_ROUTES), ['/api/1/envelope/'])

function iamCoverage(options: IamServiceOptions): Coverage {
	const transport = (on: boolean, rows: readonly [string, ...string[]], why: string): Served => on ? { rows } : none(why)
	return {
		name: `IAM (health ${options.health}, management ${options.managementRpc}, mint ${options.mintRpc}, membership ${options.membershipTransport})`,
		table: iamServiceContract(options),
		legacy: legacyRouter(frozenIamRoutes(options.health, options.membershipTransport)),
		served: {
			...(options.health ? { '/healthz': { rows: ['health'] } } : {}),
			'/.well-known/jwks.json': { rows: ['jwks'] },
			'/.well-known/oauth-authorization-server': { rows: ['oauth-metadata'] },
			'/oauth/*path': { rows: ['oauth'] },
			'/auth': { rows: ['auth-root'] },
			'/auth/*path': { rows: options.mintRpc ? ['auth', 'mint-session', 'mint-key', 'mint-exchange', 'mint-delegation'] : ['auth'] },
			'/admin/rpc': { rows: ['admin-rpc'] },
			'/admin': { rows: ['admin-root'] },
			'/admin/*path': { rows: ['admin'] },
			...(options.membershipTransport ? { '/membership/*method': { rows: ['membership'] } } : {}),
			'/rpc': transport(options.managementRpc, ['rpc-root'], 'the management transport is off: IAM answered 404'),
			'/rpc/*method': transport(options.managementRpc, ['rpc'], 'the management transport is off: IAM answered 404'),
			'/*path': none("IAM's catch-all answered 404"),
		},
		handlers: patterns(frozenIamRoutes(options.health, options.membershipTransport)),
		paths: probePaths(patterns(frozenIamRoutes(true, true)), [...FROZEN_IAM_MINT_PATHS, '/auth/mint/other']),
	}
}

const COVERAGES: readonly Coverage[] = [
	...[false, true].map((mcp): Coverage => ({
		name: `Control (MCP ${mcp})`,
		table: controlServiceContract({ mcp }),
		legacy: controlLegacy(mcp),
		served: mcp ? { ...CONTROL_SERVED, mcp: { rows: ['mcp'] } } : CONTROL_SERVED,
		handlers: [...patterns(FROZEN_CONTROL_ROUTES), ...FROZEN_CONTROL_BUILDER_PATHS.map((path) => `builder:${path}`), ...(mcp ? ['mcp'] : [])],
		paths: CONTROL_PATHS,
	})),
	{
		name: 'Operations, public host',
		table: OPERATIONS_PUBLIC_SERVICE,
		legacy: legacyRouter(FROZEN_OPERATIONS_ROUTES),
		served: {
			'/healthz': none('liveness answers only on the private network'),
			'/api/:projectId/envelope/': { rows: ['ingest'] },
			'/api/artifacts/source-maps/': { rows: ['source-map-upload'] },
			'/private/catalog/reconcile': none('private network only'),
			'/private/releases/reconcile': none('private network only'),
			'/api/rpc': none("private network only: Control's gateway dials it"),
			'/*path': none('the catch-all answered 404'),
		},
		handlers: patterns(FROZEN_OPERATIONS_ROUTES),
		paths: OPERATIONS_PATHS,
	},
	{
		name: 'Operations, private network',
		table: OPERATIONS_PRIVATE_SERVICE,
		legacy: legacyRouter(FROZEN_OPERATIONS_ROUTES),
		served: {
			'/healthz': { rows: ['health'] },
			'/api/:projectId/envelope/': none('ingest answers only on the public host'),
			'/api/artifacts/source-maps/': none('the upload answers only on the public host'),
			'/private/catalog/reconcile': { rows: ['catalog-reconcile'] },
			'/private/releases/reconcile': { rows: ['release-reconcile'] },
			'/api/rpc': { rows: ['rpc'] },
			'/*path': none('the catch-all answered 404'),
		},
		handlers: patterns(FROZEN_OPERATIONS_ROUTES),
		paths: OPERATIONS_PATHS,
	},
	iamCoverage({ health: true, managementRpc: true, mintRpc: true, membershipTransport: true }),
	iamCoverage({ health: false, managementRpc: false, mintRpc: false, membershipTransport: false }),
]

describe('every route of every service maps to its rows, or explicitly to none', () => {
	test.each(COVERAGES.map((coverage): [string, Coverage] => [coverage.name, coverage]))('%s', (_name, coverage) => {
		expect(Object.keys(coverage.served).sort()).toEqual([...coverage.handlers].sort())
		const listed = new Set(Object.values(coverage.served).flatMap((served) => served.rows))
		expect(coverage.table.endpoints.map((row) => row.id).filter((id) => !listed.has(id))).toEqual([])

		const table = compileEndpointTable(coverage.table)
		const strays: string[] = []
		const witnessed = new Set<string>()
		for (const path of coverage.paths) {
			for (const method of METHODS) {
				const handler = coverage.legacy(method, path)
				const plan = planEndpoint(table, method, path)
				if (plan.outcome !== 'endpoint') continue
				const rows: readonly string[] = handler === null ? [] : (coverage.served[handler]?.rows ?? [])
				if (rows.includes(plan.endpoint.id)) {
					witnessed.add(`${handler} → ${plan.endpoint.id}`)
				} else {
					strays.push(`${method} ${path}: route ${handler} reached row ${plan.endpoint.id}`)
				}
			}
		}
		expect(strays).toEqual([])
		const pairings = Object.entries(coverage.served).flatMap(([handler, served]) => served.rows.map((row) => `${handler} → ${row}`))
		expect(pairings.filter((pairing) => !witnessed.has(pairing))).toEqual([])
	})
})

describe('a surface a composition switches off has no row', () => {
	const select = (options: IamServiceOptions, method: string, path: string) => {
		const plan = planEndpoint(compileEndpointTable(iamServiceContract(options)), method, path)
		return plan.outcome === 'endpoint' ? plan.endpoint.id : plan.outcome
	}
	const off: IamServiceOptions = { health: false, managementRpc: false, mintRpc: false, membershipTransport: false }

	test('the mint transport: no mint path falls to /auth/*', () => {
		for (const path of [...FROZEN_IAM_MINT_PATHS, '/auth/mint/other']) {
			expect(select(off, 'POST', path)).toBe('no-endpoint')
		}
		expect(select({ ...off, mintRpc: true }, 'POST', '/auth/mint/key')).toBe('mint-key')
		expect(select({ ...off, mintRpc: true }, 'POST', '/auth/mint/other')).toBe('no-endpoint')
	})

	test('the management and membership transports and liveness', () => {
		expect(select({ ...off, membershipTransport: true }, 'POST', '/membership/members.list')).toBe('membership')
		for (const path of ['/rpc', '/rpc/mintToken', '/healthz', '/membership/members.list']) {
			expect(select(off, 'POST', path)).toBe('no-endpoint')
		}
		expect(select({ ...off, managementRpc: true }, 'POST', '/rpc/mintToken')).toBe('rpc')
		expect(select({ ...off, health: true }, 'GET', '/healthz')).toBe('health')
	})

	test('MCP: without it /mcp is a session-only 404 row, with it an oauth row; nothing below /mcp either way', () => {
		const mcpRow = (mcp: boolean) => controlServiceContract({ mcp }).endpoints.find((row) => row.id === 'mcp')
		expect(mcpRow(false)?.callers).toEqual(['human'])
		expect(mcpRow(true)?.callers).toEqual(['oauth'])
		for (const mcp of [false, true]) {
			const plan = planEndpoint(compileEndpointTable(controlServiceContract({ mcp })), 'GET', '/mcp/x')
			expect(plan.outcome).toBe('no-endpoint')
		}
	})
})
