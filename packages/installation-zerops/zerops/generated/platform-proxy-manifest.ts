// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source: packages/installation-zerops/zerops/proxy-manifest.ts
// Regenerate: bun run --filter @fabrika/installation-zerops gen
//
// The installation-independent half of `FABRIKA_PROXY_MANIFEST_JSON`: which apps the platform proxy
// fronts, at which private upstream, on which public listener, under which gates. The hosts and the
// browser-facing scheme belong to ONE installation and are supplied at deploy time —
// `resolvePlatformProxyManifest` binds them.
//
// The gate rules below are `CONTROL_PROXY_GATES` and `OPERATIONS_PROXY_GATES` as of the last
// regeneration, copied on purpose: a PUBLISHED deploy command may not import the private package that
// owns them. `gen:check` in CI is what makes the copy a fact rather than a hope.

import type { PlatformProxyManifestTemplate } from '../../src/proxy-manifest'

export const PLATFORM_PROXY_MANIFEST_TEMPLATE: PlatformProxyManifestTemplate = {
	apps: [
		{
			id: 'iam',
			service: 'iam',
			port: 8080,
			upstream: 'iam:3000',
			gates: {
				rules: [
					{ path: '/*', kind: 'public' },
				],
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
		},
		{
			id: 'operations',
			service: 'operations',
			port: 8083,
			upstream: 'operations:3000',
			gates: {
				rules: [
					{ path: '/api/*/envelope/', kind: 'public' },
					{ path: '/api/artifacts/source-maps/', kind: 'public' },
				],
			},
		},
	],
}
