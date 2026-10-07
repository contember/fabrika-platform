import type { ProviderNamespaceMember } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { defineApp } from '../authoring'
import { compileFabrikaManifest, zeropsArtifactCodec, type ZeropsArtifactSourceDescriptor } from '../manifest'
import { compileNamespaceProxyManifest } from '../namespace/manifest'

const SOURCE_DESCRIPTOR: ZeropsArtifactSourceDescriptor = {
	path: 'zerops.yaml',
	contents: 'zerops:\n  - setup: test\n',
	sha256: '560802d669a116e27e5ce76af3312048e3e9e7743a4fb7d6e73f14d800dc46d1',
}
const GATES = { rules: [{ path: '/healthz', kind: 'public' as const }, { path: '/*', kind: 'human' as const }] }

const member = (
	appId: string,
	domain: string | undefined,
	options: { manifestId?: string; manifestEnv?: string; proxy?: boolean } = {},
): ProviderNamespaceMember => {
	const manifest = compileFabrikaManifest(
		defineApp({
			id: options.manifestId ?? appId,
			target: {
				platform: 'zerops',
				services: () => [{ hostname: appId, type: 'alpine/bun@1.3' }],
				...(options.proxy === false ? {} : { proxy: { upstream: `${appId}:3000`, gates: GATES } }),
			},
		}),
		options.manifestEnv ?? 'prod',
		SOURCE_DESCRIPTOR,
	)
	return {
		appId,
		env: 'prod',
		...(domain === undefined ? {} : { domain }),
		artifact: { provider: 'zerops', version: zeropsArtifactCodec.version, payload: zeropsArtifactCodec.encode(manifest) },
	}
}

describe('namespace proxy manifest', () => {
	test('routes every public member on its lowercased domain over https and skips members without a proxy', () => {
		expect(compileNamespaceProxyManifest('apps-prod', [
			member('alpha', 'Alpha.Example.com'),
			member('worker', undefined, { proxy: false }),
			member('beta', 'beta.example.com'),
		])).toEqual({
			apps: [
				{ id: 'alpha', hosts: ['alpha.example.com'], upstream: 'alpha:3000', gates: GATES, scheme: 'https' },
				{ id: 'beta', hosts: ['beta.example.com'], upstream: 'beta:3000', gates: GATES, scheme: 'https' },
			],
		})
	})

	for (const drift of [{ manifestId: 'beta' }, { manifestEnv: 'stage' }]) {
		test(`refuses decoded artifact coordinate drift ${JSON.stringify(drift)}`, () => {
			expect(() => compileNamespaceProxyManifest('apps-prod', [member('alpha', 'alpha.example.test', drift)])).toThrow(
				drift.manifestId === undefined ? 'manifest environment drift: expected `prod`, got `stage`' : 'manifest app drift: expected `alpha`, got `beta`',
			)
		})
	}

	test('refuses a public member without a domain, a duplicate host, and a foreign artifact', () => {
		expect(() => compileNamespaceProxyManifest('apps-prod', [member('alpha', undefined)])).toThrow('requires a public domain')
		expect(() => compileNamespaceProxyManifest('apps-prod', [member('alpha', 'shared.example.test'), member('beta', 'Shared.example.test')])).toThrow(
			'duplicate proxy host',
		)
		const foreign = { ...member('alpha', 'alpha.example.test'), artifact: { provider: 'other', version: 1, payload: {} } }
		expect(() => compileNamespaceProxyManifest('apps-prod', [foreign])).toThrow('belongs to provider "other"')
	})
})
