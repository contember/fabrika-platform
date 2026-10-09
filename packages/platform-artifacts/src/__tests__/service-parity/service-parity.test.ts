// The differential parity test of work unit B10 (ADR-0022 "Installation entries"): every request over method × path ×
// credential, decided by the proxy under each service's frozen gates and under its service contract.
//
// The contract may allow only what the gates allowed, to the same credential, reaching the same handler. Every
// request where it does not is covered by exactly the accepted differences listed below; an unlisted difference
// fails, and so does a listed one that no request exhibits any more. Deleted with the gates in B10h.

import type { AppGates, InstallationCredentialedEndpoint } from '@fabrika/auth-core'
import { controlServiceContract } from '@fabrika/control/service'
import { iamServiceContract } from '@fabrika/iam/service'
import { OPERATIONS_PUBLIC_SERVICE } from '@fabrika/operations/service'
import { type InstallationProxyTable, isApplicationEntry, serviceProxyTable } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import {
	FROZEN_CONTROL_BUILDER_PATHS,
	FROZEN_CONTROL_MCP,
	FROZEN_CONTROL_ROUTES,
	FROZEN_IAM_GATES,
	FROZEN_IAM_MINT_PATHS,
	FROZEN_OPERATIONS_GATES,
	FROZEN_OPERATIONS_ROUTES,
	frozenControlGates,
	frozenIamRoutes,
} from './frozen'
import { CREDENTIALS, decider, entries, legacyHandler, METHODS, type Observation, type Probe, probePaths, PUBLIC_ORIGIN } from './harness'

interface Difference {
	readonly probe: Probe
	readonly gates: Observation
	readonly table: Observation
	/** What `defineApp` runs for the request, and what the row the contract's proxy selected will run. */
	readonly legacy: string
	readonly served: string | null
}

type DifferenceKind = 'narrowing' | 'widening' | 'credential' | 'handler'

interface Accepted {
	readonly kind: DifferenceKind
	readonly why: string
	readonly covers: (difference: Difference) => boolean
}

interface ServiceCase {
	readonly name: string
	readonly gates: AppGates
	readonly table: InstallationProxyTable
	readonly oauth: boolean
	readonly legacy: (method: string, path: string) => string
	/** The handler each row runs, in the legacy router's names. */
	readonly handlerOfRow: Readonly<Record<string, string>>
	readonly paths: readonly string[]
	readonly accepted: readonly Accepted[]
}

function kindOf(difference: Difference, handlerOfRow: Readonly<Record<string, string>>): DifferenceKind | null {
	const { gates, table } = difference
	if (table.outcome === 'allow' && gates.outcome !== 'allow') return 'widening'
	if (gates.outcome === 'allow' && table.outcome !== 'allow') return 'narrowing'
	if (gates.outcome !== 'allow') return null
	if (gates.source !== table.source) return 'credential'
	return table.row !== null && handlerOfRow[table.row] === difference.legacy ? null : 'handler'
}

const SAME_ORIGIN: readonly Probe['headers'][] = ['same-origin']
const ADMISSION_VARIANTS: readonly Probe['headers'][] = ['same-origin', 'cross-site', 'no-content-type']

async function differences(service: ServiceCase): Promise<{ unexplained: string[]; unused: string[]; unreached: string[] }> {
	const pair = entries(service.gates, service.table, service.oauth)
	const decideGates = decider(pair.gates)
	const decideTable = decider(pair.table)
	const used = new Set<Accepted>()
	const reached = new Set<string>()
	const unexplained: string[] = []
	for (const path of service.paths) {
		for (const method of METHODS) {
			for (const credential of CREDENTIALS) {
				for (const headers of method === 'POST' ? ADMISSION_VARIANTS : SAME_ORIGIN) {
					const probe: Probe = { method, path, credential, headers }
					const gates = await decideGates(probe)
					const table = await decideTable(probe)
					if (table.outcome === 'allow' && table.row !== null) reached.add(table.row)
					const served = table.row === null ? null : (service.handlerOfRow[table.row] ?? null)
					const difference: Difference = { probe, gates, table, legacy: service.legacy(method, path), served }
					const kind = kindOf(difference, service.handlerOfRow)
					if (kind === null) continue
					const accepted = service.accepted.find((entry) => entry.kind === kind && entry.covers(difference))
					if (accepted === undefined) {
						unexplained.push(
							`${kind}: ${method} ${path} ${credential} ${headers} — gates ${gates.outcome} ${gates.status} ${gates.reason} ${gates.source} → ${difference.legacy}; table ${table.outcome} ${table.status} ${table.reason} ${table.source} → ${table.row}`,
						)
					} else {
						used.add(accepted)
					}
				}
			}
		}
	}
	return {
		unexplained,
		unused: service.accepted.filter((entry) => !used.has(entry)).map((entry) => entry.why),
		unreached: service.table.endpoints.map((row) => row.id).filter((id) => !reached.has(id)),
	}
}

const CONTROL_ROW_HANDLERS: Readonly<Record<string, string>> = {
	'health': '/healthz',
	'api-health': '/api/health',
	'builder-discovery': 'builder:/.well-known/fabrika-builder',
	'builder-connect': 'builder:/builder/connect',
	'github-webhook': '/webhooks/github/:connectionId',
	'webhooks-root': 'not-found',
	'github-manifest': '/api/source/github/manifest/:connectionId',
	'github-callback': '/api/source/github/callback',
	'rpc': '/api/rpc',
	'api-root': 'not-found',
	'iam-admin-rpc': '/iam/admin/*path',
	'iam-admin-root': 'not-found',
	'operations-rpc': '/operations/api/rpc',
	'operations-api-root': 'not-found',
	'console': '/*path',
}

const controlRouter = legacyHandler(FROZEN_CONTROL_ROUTES, [
	'/webhooks',
	'/webhooks/*path',
	'/operations/api',
	'/operations/api/*path',
	'/api',
	'/api/*path',
])

function legacyControl(mcp: boolean): (method: string, path: string) => string {
	return (method, path) => {
		// `withMcp` drops empty segments before it compares.
		const normalized = `/${path.split('/').filter((segment) => segment !== '').join('/')}`
		if (mcp && normalized === FROZEN_CONTROL_MCP.path && FROZEN_CONTROL_MCP.methods.includes(method)) return 'mcp'
		if (FROZEN_CONTROL_BUILDER_PATHS.includes(path)) return `builder:${path}`
		return controlRouter(method, path)
	}
}

const CONTROL_PATHS = probePaths(
	[...FROZEN_CONTROL_ROUTES.map((entry) => entry.pattern), ...frozenControlGates(PUBLIC_ORIGIN).rules.map((rule) => rule.path)],
	[
		'/',
		'/index.html',
		'/apps/notes',
		'/mcp',
		'/mcp/',
		'/mcp/x',
		'/webhooks/github',
		'/webhooks/github/c1/x',
		'/api/rpc/x',
		'/iam/admin/apps',
		'/iam/admin/rpc',
	],
)

/** Rows only a person may call; the caller `human` also admits a `user` key there. */
const humanOnlyRows = (mcp: boolean): ReadonlySet<string> =>
	new Set(['console', 'webhooks-root', 'api-root', 'github-manifest', 'github-callback', ...(mcp ? [] : ['mcp'])])

function controlAccepted(mcp: boolean): Accepted[] {
	const humanOnly = humanOnlyRows(mcp)
	return [
		{
			kind: 'widening',
			why: 'the caller human admits a user px_ key without a session: the console shell and the 404 roots (ADR-0022, bounded exception)',
			covers: ({ probe, gates, table }) =>
				probe.credential === 'user-key' && gates.outcome === 'login' && table.source === 'key' && table.row !== null && humanOnly.has(table.row),
		},
		{
			kind: 'credential',
			why: 'a px_ key is terminal at an endpoint, so a user key beside a session decides instead of the session',
			covers: ({ probe, gates, table }) => probe.credential === 'session+user-key' && gates.source === 'session' && table.source === 'key',
		},
		{
			kind: 'narrowing',
			why: 'a machine key beside a session on a human-only row is a 403: the key is terminal and no machine may call there',
			covers: ({ probe, gates, table }) => probe.credential === 'session+machine-key' && gates.source === 'session' && table.reason === 'caller_kind',
		},
		{
			kind: 'narrowing',
			why: 'a machine key on the GitHub browser routes is a 403 (requireHuman refused it behind the gate)',
			covers: ({ probe, table }) =>
				probe.credential === 'machine-key' && table.reason === 'caller_kind' && table.row === null && probe.path.startsWith('/api/source/github/'),
		},
		{
			kind: 'narrowing',
			why: "a link key is no caller of Control's rows; its service gate admitted it",
			covers: ({ probe, table }) => probe.credential === 'link-key' && table.reason === 'caller_kind',
		},
		{
			kind: 'narrowing',
			why: 'the console SPA row answers GET only: another method (HEAD included) on an SPA path is a 403',
			covers: ({ probe, legacy, table }) => probe.method !== 'GET' && legacy === '/*path' && table.reason === 'no_endpoint',
		},
		{
			kind: 'narrowing',
			why: 'a path the service answered with a fixed 404 under a reserved prefix is a proxy 403 (no_endpoint)',
			covers: ({ legacy, table }) => legacy === 'not-found' && table.reason === 'no_endpoint',
		},
		{
			kind: 'narrowing',
			why: 'the IAM admin gateway serves only POST /iam/admin/rpc',
			covers: ({ legacy, table }) => legacy === '/iam/admin/*path' && table.reason === 'no_endpoint',
		},
		{
			kind: 'narrowing',
			why: 'the Operations gateway serves only POST /operations/api/rpc',
			covers: ({ probe, legacy, table }) => legacy === '/operations/api/rpc' && probe.method !== 'POST' && table.reason === 'no_endpoint',
		},
		{
			kind: 'narrowing',
			why: "proxy admission replaces Control's same-origin guard: a cross-site session request that is not a GET is a 403",
			covers: ({ probe, table }) => probe.headers === 'cross-site' && table.reason === 'cross_site',
		},
		{
			kind: 'narrowing',
			why: 'an RPC mount admits only application/json at the proxy',
			covers: ({ probe, table }) => probe.headers === 'no-content-type' && table.reason === 'content_type',
		},
		{
			kind: 'narrowing',
			why: '/mcp is a reserved prefix: a path below it is a 403 and never the SPA or the MCP endpoint',
			covers: ({ probe, table }) => probe.path.startsWith('/mcp/') && table.reason === 'no_endpoint',
		},
		{
			kind: 'handler',
			why: '/iam/admin itself answers 404 at Control instead of being forwarded to IAM',
			covers: ({ probe, legacy, served }) => probe.path === '/iam/admin' && legacy === '/iam/admin' && served === 'not-found',
		},
		...(mcp
			? [{
				kind: 'handler' as const,
				why: 'every method on /mcp reaches the MCP endpoint, which answers the methods it does not serve; withMcp passed them to the SPA',
				covers: ({ probe, legacy, served }: Difference) => probe.path === '/mcp' && legacy === '/*path' && served === 'mcp',
			}]
			: [{
				kind: 'handler' as const,
				why: 'without MCP, /mcp answers 404 instead of the SPA (B10 decision: it never falls through to the SPA)',
				covers: ({ probe, legacy, served }: Difference) => probe.path === '/mcp' && legacy === '/*path' && served === 'not-found',
			}]),
	]
}

const SERVICES: readonly ServiceCase[] = [
	{
		name: 'Control without MCP',
		gates: frozenControlGates(),
		table: serviceProxyTable(controlServiceContract({ mcp: false }), { oauth: false }),
		oauth: false,
		legacy: legacyControl(false),
		handlerOfRow: { ...CONTROL_ROW_HANDLERS, mcp: 'not-found' },
		paths: CONTROL_PATHS,
		accepted: controlAccepted(false),
	},
	{
		name: 'Control with MCP',
		gates: frozenControlGates(PUBLIC_ORIGIN),
		table: serviceProxyTable(controlServiceContract({ mcp: true }), { oauth: true }),
		oauth: true,
		legacy: legacyControl(true),
		handlerOfRow: { ...CONTROL_ROW_HANDLERS, mcp: 'mcp' },
		paths: CONTROL_PATHS,
		accepted: controlAccepted(true),
	},
	{
		name: 'Operations (public host)',
		gates: FROZEN_OPERATIONS_GATES,
		table: serviceProxyTable(OPERATIONS_PUBLIC_SERVICE, { oauth: false }),
		oauth: false,
		legacy: legacyHandler(FROZEN_OPERATIONS_ROUTES, ['/*path']),
		handlerOfRow: { 'ingest': '/api/:projectId/envelope/', 'source-map-upload': '/api/artifacts/source-maps/' },
		paths: probePaths([...FROZEN_OPERATIONS_ROUTES.map((entry) => entry.pattern), ...FROZEN_OPERATIONS_GATES.rules.map((rule) => rule.path)], [
			'/api/1/envelope',
			'/api/1/2/envelope/',
		]),
		accepted: [{
			kind: 'narrowing',
			why: 'a path the service answered with 404 is a proxy 403 (no_endpoint): the envelope glob crossed segments, the row does not',
			covers: ({ legacy, table }) => legacy === 'not-found' && table.reason === 'no_endpoint',
		}],
	},
	{
		name: 'IAM',
		gates: FROZEN_IAM_GATES,
		table: serviceProxyTable(iamServiceContract({ health: true, managementRpc: true, mintRpc: true, membershipTransport: true }), { oauth: false }),
		oauth: false,
		legacy: legacyHandler(frozenIamRoutes(true, true), ['/*path']),
		handlerOfRow: {
			'health': '/healthz',
			'jwks': '/.well-known/jwks.json',
			'oauth-metadata': '/.well-known/oauth-authorization-server',
			'oauth': '/oauth/*path',
			'auth-root': '/auth',
			'auth': '/auth/*path',
			'mint-session': '/auth/*path',
			'mint-key': '/auth/*path',
			'mint-exchange': '/auth/*path',
			'mint-delegation': '/auth/*path',
			'admin-rpc': '/admin/rpc',
			'admin-root': '/admin',
			'admin': '/admin/*path',
			'membership': '/membership/*method',
			'rpc-root': '/rpc',
			'rpc': '/rpc/*method',
		},
		paths: probePaths(frozenIamRoutes(true, true).map((entry) => entry.pattern), [
			...FROZEN_IAM_MINT_PATHS,
			'/auth/mint/other',
			'/auth/login',
			'/unknown',
		]),
		accepted: [
			{
				kind: 'narrowing',
				why: "a path IAM answered with its catch-all 404 is a proxy 403 (no_endpoint); IAM's '/*' public gate admitted it",
				covers: ({ legacy, table }) => legacy === 'not-found' && table.reason === 'no_endpoint',
			},
			{
				kind: 'narrowing',
				why: '/auth/mint is reserved: a path below it that is not one of the four mint paths is a 403, never an /auth/* page',
				covers: ({ probe, table }) => probe.path.startsWith('/auth/mint/') && table.reason === 'no_endpoint',
			},
		],
	},
]

describe('every service contract allows only what its gates allowed, to the same credential and handler', () => {
	test.each(SERVICES.map((service): [string, ServiceCase] => [service.name, service]))('%s', async (_name, service) => {
		const { unexplained, unused, unreached } = await differences(service)
		expect(unexplained).toEqual([])
		expect(unused).toEqual([])
		// Every row admits some request of the matrix, so no row's comparison is vacuous.
		expect(unreached).toEqual([])
	}, 120_000)

	test('a contract that admits one caller more than its gates is reported, not accepted', async () => {
		const contract = controlServiceContract({ mcp: false })
		const callers: InstallationCredentialedEndpoint['callers'] = ['human', 'machine']
		const widened = {
			...contract,
			endpoints: contract.endpoints.map((row) => row.kind === 'service' && row.id === 'console' ? { ...row, callers } : row),
		}
		const [base] = SERVICES
		if (base === undefined) throw new Error('no Control case')
		const { unexplained } = await differences({ ...base, table: serviceProxyTable(widened, { oauth: false }), paths: ['/apps/notes'] })
		expect(unexplained).toContain(
			'widening: GET /apps/notes machine-key same-origin — gates login 302 no_session none → /*path; table allow 204 null key → console',
		)
	}, 120_000)
})

describe('the hop of an installation entry is the hop of a gate entry', () => {
	test.each(SERVICES.map((service): [string, ServiceCase] => [service.name, service]))(
		'%s keeps Authorization, sets no proxy secret and no response policy',
		(_name, service) => {
			const pair = entries(service.gates, service.table, service.oauth)
			expect(isApplicationEntry(pair.gates)).toBe(false)
			expect(isApplicationEntry(pair.table)).toBe(false)
		},
	)
})
