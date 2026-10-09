// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source: packages/platform-artifacts/src/proxy-manifest.ts
// Regenerate: bun run --filter @fabrika/platform-artifacts gen
//
// The installation-independent half of `FABRIKA_PROXY_MANIFEST_JSON`: which apps the platform proxy
// fronts, at which private upstream, on which public listener, under which gates or service table. The
// hosts and the browser-facing scheme belong to ONE installation and are supplied at deploy time —
// `resolvePlatformProxyManifest` binds them.
//
// The gate rules and service tables below are the services' own (`CONTROL_PROXY_GATES`, IAM's and
// Operations' service contracts) as of the last regeneration, copied on purpose: a PUBLISHED deploy command
// may not import the private packages that own them. `gen:check` in CI is what makes the copy a fact
// rather than a hope.
//
// The console's `oauthResource` is its MCP endpoint, copied the same way. A deploy gates and registers
// it only on an installation that enables MCP authoring.

import type { PlatformProxyManifestTemplate } from '../proxy-manifest'

export const PLATFORM_PROXY_MANIFEST_TEMPLATE: PlatformProxyManifestTemplate = {
	apps: [
		{
			id: 'iam',
			service: 'iam',
			port: 8080,
			upstream: 'iam:3000',
			table: {
				endpoints: [
					{
						id: 'health',
						kind: 'health',
						method: '*',
						path: '/healthz',
						callers: [],
						requirement: null,
						admission: null,
						oauth: null,
					},
					{
						id: 'jwks',
						kind: 'protocol',
						method: '*',
						path: '/.well-known/jwks.json',
						callers: [],
						requirement: null,
						admission: null,
						oauth: null,
					},
					{
						id: 'oauth-metadata',
						kind: 'protocol',
						method: '*',
						path: '/.well-known/oauth-authorization-server',
						callers: [],
						requirement: null,
						admission: null,
						oauth: null,
					},
					{
						id: 'oauth',
						kind: 'protocol',
						method: '*',
						path: '/oauth/*',
						callers: [],
						requirement: null,
						admission: null,
						oauth: null,
					},
					{
						id: 'auth-root',
						kind: 'protocol',
						method: '*',
						path: '/auth',
						callers: [],
						requirement: null,
						admission: null,
						oauth: null,
					},
					{
						id: 'auth',
						kind: 'protocol',
						method: '*',
						path: '/auth/*',
						callers: [],
						requirement: null,
						admission: null,
						oauth: null,
					},
					{
						id: 'mint-session',
						kind: 'protocol',
						method: '*',
						path: '/auth/mint/session',
						callers: [],
						requirement: null,
						admission: null,
						oauth: null,
					},
					{
						id: 'mint-key',
						kind: 'protocol',
						method: '*',
						path: '/auth/mint/key',
						callers: [],
						requirement: null,
						admission: null,
						oauth: null,
					},
					{
						id: 'mint-exchange',
						kind: 'protocol',
						method: '*',
						path: '/auth/mint/exchange',
						callers: [],
						requirement: null,
						admission: null,
						oauth: null,
					},
					{
						id: 'mint-delegation',
						kind: 'protocol',
						method: '*',
						path: '/auth/mint/delegation',
						callers: [],
						requirement: null,
						admission: null,
						oauth: null,
					},
					{
						id: 'admin-rpc',
						kind: 'protocol',
						method: 'POST',
						path: '/admin/rpc',
						callers: [],
						requirement: null,
						admission: null,
						oauth: null,
					},
					{
						id: 'admin-root',
						kind: 'protocol',
						method: '*',
						path: '/admin',
						callers: [],
						requirement: null,
						admission: null,
						oauth: null,
					},
					{
						id: 'admin',
						kind: 'protocol',
						method: '*',
						path: '/admin/*',
						callers: [],
						requirement: null,
						admission: null,
						oauth: null,
					},
					{
						id: 'membership',
						kind: 'protocol',
						method: '*',
						path: '/membership/*',
						callers: [],
						requirement: null,
						admission: null,
						oauth: null,
					},
					{
						id: 'rpc-root',
						kind: 'protocol',
						method: '*',
						path: '/rpc',
						callers: [],
						requirement: null,
						admission: null,
						oauth: null,
					},
					{
						id: 'rpc',
						kind: 'protocol',
						method: '*',
						path: '/rpc/*',
						callers: [],
						requirement: null,
						admission: null,
						oauth: null,
					},
				],
				reservedPrefixes: ['/auth/mint', '/rpc'],
			},
		},
		{
			id: 'vozka',
			service: 'control',
			port: 8082,
			upstream: 'control:3000',
			gates: {
				rules: [
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
			},
			oauthResource: {
				path: '/mcp',
				scopes: ['authoring'],
				scopeGrants: [
					{
						scope: 'authoring',
						actions: ['source.workspace.read', 'source.workspace.write', 'source.pull-request.create', 'deploy.trigger', 'deploy.read'],
					},
				],
			},
		},
		{
			id: 'operations',
			service: 'operations',
			port: 8083,
			upstream: 'operations:3000',
			table: {
				endpoints: [
					{
						id: 'ingest',
						kind: 'protocol',
						method: '*',
						path: '/api/:projectId/envelope/',
						callers: [],
						requirement: null,
						admission: null,
						oauth: null,
					},
					{
						id: 'source-map-upload',
						kind: 'protocol',
						method: '*',
						path: '/api/artifacts/source-maps/',
						callers: [],
						requirement: null,
						admission: null,
						oauth: null,
					},
				],
				reservedPrefixes: [],
			},
		},
	],
}
