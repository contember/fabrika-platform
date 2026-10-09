import { type ContractArtifact, contractDigest } from '@fabrika/auth-core'
import type { ProviderApprovedAccess, ProviderNamespaceMember } from '@fabrika/provider-contract'
import { contractProxyTable, parseProxyManifest } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { schemaFromContract } from '../../../app/src/contract/platform'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { defineApp } from '../authoring'
import { compileFabrikaManifest, zeropsArtifactCodec, type ZeropsArtifactSourceDescriptor } from '../manifest'
import { compileNamespaceProxyManifest } from '../namespace/manifest'

const SOURCE_DESCRIPTOR: ZeropsArtifactSourceDescriptor = {
	path: 'zerops.yaml',
	contents: 'zerops:\n  - setup: test\n',
	sha256: '560802d669a116e27e5ce76af3312048e3e9e7743a4fb7d6e73f14d800dc46d1',
}
const GATES = { rules: [{ path: '/healthz', kind: 'public' as const }, { path: '/*', kind: 'human' as const }] }

const TABLE = contractProxyTable(notesArtifact)

const member = (
	appId: string,
	domain: string | undefined,
	options: { manifestId?: string; manifestEnv?: string; proxy?: boolean; contract?: boolean; access?: ProviderApprovedAccess; trusted?: boolean } = {},
): ProviderNamespaceMember => {
	const manifest = compileFabrikaManifest(
		defineApp({
			id: options.manifestId ?? appId,
			target: {
				platform: 'zerops',
				services: () => [{ hostname: appId, type: 'alpine/bun@1.3' }],
				...(options.contract === true ? { contract: notesArtifact } : {}),
				...(options.proxy === false
					? {}
					: { proxy: options.contract === true ? { upstream: `${appId}:3000`, ...TABLE } : { upstream: `${appId}:3000`, gates: GATES } }),
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
		...(options.access === undefined ? {} : { access: options.access }),
		...(options.contract === true || options.access !== undefined || options.trusted === false ? {} : { artifactAccess: true }),
	}
}

const approved = (artifact: ContractArtifact): ProviderApprovedAccess => ({
	contract: artifact,
	contractDigest: contractDigest(artifact),
	schema: schemaFromContract(artifact),
})

describe('namespace proxy manifest', () => {
	test('routes every public member on its lowercased domain over https and skips members without a proxy', () => {
		expect(compileNamespaceProxyManifest('apps-prod', [
			member('alpha', 'Alpha.Example.com'),
			member('worker', undefined, { proxy: false }),
			member('beta', 'beta.example.com'),
		])).toEqual({
			apps: [
				{ id: 'alpha@prod', hosts: ['alpha.example.com'], upstream: 'alpha:3000', gates: GATES, scheme: 'https' },
				{ id: 'beta@prod', hosts: ['beta.example.com'], upstream: 'beta:3000', gates: GATES, scheme: 'https' },
			],
		})
	})

	test('a contract application gets its endpoint table instead of gates, in a manifest the proxy accepts', () => {
		const manifest = compileNamespaceProxyManifest('apps-prod', [
			member('notes', 'notes.example.com', { contract: true, access: approved(notesArtifact) }),
			member('beta', 'beta.example.com'),
		])
		expect(manifest.apps[0]).toEqual({ id: 'notes@prod', hosts: ['notes.example.com'], upstream: 'notes:3000', scheme: 'https', ...TABLE })
		expect(parseProxyManifest(manifest)).toEqual(manifest)
	})

	test('the table comes from the approved contract, never the artifact; a contract without approval is not routed', () => {
		const narrowed: ContractArtifact = { ...notesArtifact, endpoints: notesArtifact.endpoints.slice(0, 1) }
		const routed = compileNamespaceProxyManifest('apps-prod', [member('notes', 'notes.example.com', { contract: true, access: approved(narrowed) })])
		expect(routed.apps[0]).toEqual({
			id: 'notes@prod',
			hosts: ['notes.example.com'],
			upstream: 'notes:3000',
			scheme: 'https',
			...contractProxyTable(narrowed),
		})
		expect(compileNamespaceProxyManifest('apps-prod', [member('notes', 'notes.example.com', { contract: true })])).toEqual({ apps: [] })
	})

	test('a configuration that drops its contract still gets the approved table, not its gates', () => {
		const manifest = compileNamespaceProxyManifest('apps-prod', [member('alpha', 'alpha.example.com', { access: approved(notesArtifact) })])
		expect(manifest.apps[0]).toEqual({ id: 'alpha@prod', hosts: ['alpha.example.com'], upstream: 'alpha:3000', scheme: 'https', ...TABLE })
	})

	test('an uploaded gates descriptor is not routed unless Control knows the application has no contract', () => {
		// A first protected run parked for approval: nothing published, and the upload hides its contract behind `/* → public`.
		expect(compileNamespaceProxyManifest('apps-prod', [member('alpha', 'alpha.example.com', { trusted: false })])).toEqual({ apps: [] })
		expect(compileNamespaceProxyManifest('apps-prod', [member('alpha', 'alpha.example.com')]).apps.map((app) => app.id)).toEqual(['alpha@prod'])
	})

	test('the artifact refuses an endpoint row whose digest does not describe its rules', () => {
		const tampered = () =>
			compileFabrikaManifest(
				defineApp({
					id: 'notes',
					target: {
						platform: 'zerops',
						services: () => [{ hostname: 'notes', type: 'alpine/bun@1.3' }],
						proxy: { upstream: 'notes:3000', ...TABLE, endpoints: TABLE.endpoints.map((row) => ({ ...row, path: `${row.path}x` })) },
					},
				}),
				'prod',
				SOURCE_DESCRIPTOR,
			)
		expect(tampered).toThrow('invalid fabrika manifest')
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
