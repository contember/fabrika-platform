// The installation services' gates and `defineApp` routes as they stood before work unit B10, frozen as test data.
//
// B10c–e delete the gate exports and B10h deletes `defineApp`; the parity and route-coverage tests keep comparing
// the service contracts against these copies. While the live versions exist, `frozen.test.ts` and each service's
// `service-routes.test.ts` prove the copies equal them. Never edit a copy to make a parity test pass.

import type { AppGates } from '@fabrika/auth-core'

/** `CONTROL_PROXY_GATES`, and `controlProxyGates(publicOrigin)`'s leading `oauth` rule for `/mcp`. */
export function frozenControlGates(publicOrigin?: string): AppGates {
	const mcp: AppGates['rules'] = publicOrigin === undefined
		? []
		: [{ path: '/mcp', kind: 'oauth', resource: `${publicOrigin}/mcp`, scopes: ['authoring'] }]
	return {
		rules: [
			...mcp,
			{ path: '/healthz', kind: 'public' },
			{ path: '/.well-known/fabrika-builder', kind: 'public' },
			{ path: '/builder/connect', kind: 'public' },
			{ path: '/api/health', kind: 'public' },
			{ path: '/webhooks/github', kind: 'public' },
			{ path: '/webhooks/github/*', kind: 'public' },
			{ path: '/iam/admin', kind: 'service' },
			{ path: '/iam/admin', kind: 'human' },
			{ path: '/iam/admin/*', kind: 'service' },
			{ path: '/iam/admin/*', kind: 'human' },
			{ path: '/operations/api', kind: 'service' },
			{ path: '/operations/api', kind: 'human' },
			{ path: '/operations/api/*', kind: 'service' },
			{ path: '/operations/api/*', kind: 'human' },
			{ path: '/api/source/github/manifest/*', kind: 'human' },
			{ path: '/api/source/github/callback', kind: 'human' },
			{ path: '/api/*', kind: 'service' },
			{ path: '/api/*', kind: 'human' },
			{ path: '/*', kind: 'human' },
		],
	}
}

/** `OPERATIONS_PROXY_GATES`: the public hostname's two self-authenticating routes. */
export const FROZEN_OPERATIONS_GATES: AppGates = {
	rules: [
		{ path: '/api/*/envelope/', kind: 'public' },
		{ path: '/api/artifacts/source-maps/', kind: 'public' },
	],
}

/** IAM's platform proxy gates: IAM authenticates every surface itself. */
export const FROZEN_IAM_GATES: AppGates = { rules: [{ path: '/*', kind: 'public' }] }

/** A `defineApp` route as data: its method (`null` for `route.all`, `rpc` for `route.rpc`, which serves POST) and pattern. */
export interface FrozenRoute {
	readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'rpc' | null
	readonly pattern: string
}

/** `controlRoutes`, in order. */
export const FROZEN_CONTROL_ROUTES: readonly FrozenRoute[] = [
	{ method: null, pattern: '/healthz' },
	{ method: null, pattern: '/api/health' },
	{ method: 'POST', pattern: '/webhooks/github/:connectionId' },
	{ method: null, pattern: '/webhooks' },
	{ method: null, pattern: '/webhooks/*path' },
	{ method: 'GET', pattern: '/api/source/github/manifest/:connectionId' },
	{ method: 'GET', pattern: '/api/source/github/callback' },
	{ method: null, pattern: '/iam/admin' },
	{ method: null, pattern: '/iam/admin/*path' },
	{ method: null, pattern: '/operations/api/rpc' },
	{ method: null, pattern: '/operations/api' },
	{ method: null, pattern: '/operations/api/*path' },
	{ method: 'rpc', pattern: '/api/rpc' },
	{ method: null, pattern: '/api' },
	{ method: null, pattern: '/api/*path' },
	{ method: null, pattern: '/*path' },
]

/**
 * What `controlApp` and the Zerops server answer before routing: the builder bootstrap middleware (every method),
 * and, when MCP is configured, `withMcp` for these methods on `/mcp` after dropping empty path segments.
 */
export const FROZEN_CONTROL_BUILDER_PATHS: readonly string[] = ['/.well-known/fabrika-builder', '/builder/connect']
export const FROZEN_CONTROL_MCP: { readonly path: string; readonly methods: readonly string[] } = { path: '/mcp', methods: ['GET', 'POST', 'DELETE'] }

/** `operationsRoutes`, in order. Which host a route answers on is decided inside its handler. */
export const FROZEN_OPERATIONS_ROUTES: readonly FrozenRoute[] = [
	{ method: null, pattern: '/healthz' },
	{ method: null, pattern: '/api/:projectId/envelope/' },
	{ method: null, pattern: '/api/artifacts/source-maps/' },
	{ method: null, pattern: '/private/catalog/reconcile' },
	{ method: null, pattern: '/private/releases/reconcile' },
	{ method: 'rpc', pattern: '/api/rpc' },
	{ method: null, pattern: '/*path' },
]

/** `iamRoutes(options)`, in order; `/healthz` and `/membership/*method` exist only when their option is on. */
export function frozenIamRoutes(health: boolean, membershipTransport: boolean): readonly FrozenRoute[] {
	return [
		...(health ? [{ method: null, pattern: '/healthz' }] : []),
		{ method: null, pattern: '/.well-known/jwks.json' },
		{ method: null, pattern: '/.well-known/oauth-authorization-server' },
		{ method: null, pattern: '/oauth/*path' },
		{ method: null, pattern: '/auth' },
		{ method: null, pattern: '/auth/*path' },
		{ method: 'rpc', pattern: '/admin/rpc' },
		{ method: null, pattern: '/admin' },
		{ method: null, pattern: '/admin/*path' },
		...(membershipTransport ? [{ method: null, pattern: '/membership/*method' }] : []),
		{ method: null, pattern: '/rpc' },
		{ method: null, pattern: '/rpc/*method' },
		{ method: null, pattern: '/*path' },
	]
}

/** IAM's mint transport paths (`isMintPath`), served under `/auth/*path` only with a proxy key. */
export const FROZEN_IAM_MINT_PATHS: readonly string[] = ['/auth/mint/session', '/auth/mint/key', '/auth/mint/exchange', '/auth/mint/delegation']
