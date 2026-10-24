import { type ContractArtifact, contractDigest } from '@fabrika/auth-core'
import type { JsonValue, ProviderApprovedAccess, ProviderNamespaceMember } from '@fabrika/provider-contract'
import { contractProxyTable, parseProxyManifest } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { schemaFromContract } from '../../../app/src/contract/platform'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { defineApp } from '../authoring'
import { FABRIKA_CHECK_VERSION } from '../execution'
import { compileFabrikaManifest, zeropsArtifactCodec, type ZeropsArtifactSourceDescriptor } from '../manifest'
import { compileNamespaceProxyManifest } from '../namespace/manifest'

const SOURCE_DESCRIPTOR: ZeropsArtifactSourceDescriptor = {
	path: 'zerops.yaml',
	contents: 'zerops:\n  - setup: test\n',
	sha256: '560802d669a116e27e5ce76af3312048e3e9e7743a4fb7d6e73f14d800dc46d1',
}
const TABLE = contractProxyTable(notesArtifact)

/** The notes contract, declared by another application. */
const contractOf = (app: string): ContractArtifact => ({ ...notesArtifact, app })

const approved = (artifact: ContractArtifact): ProviderApprovedAccess => ({
	contract: artifact,
	contractDigest: contractDigest(artifact),
	schema: schemaFromContract(artifact),
	checker: FABRIKA_CHECK_VERSION,
})

/** A member whose artifact is a contract application behind its table; Control approved that contract unless `access: null`. */
const member = (
	appId: string,
	domain: string | undefined,
	options: { manifestId?: string; manifestEnv?: string; proxy?: boolean; access?: ProviderApprovedAccess | null } = {},
): ProviderNamespaceMember => {
	const contract = contractOf(options.manifestId ?? appId)
	const manifest = compileFabrikaManifest(
		defineApp({
			id: options.manifestId ?? appId,
			target: {
				platform: 'zerops',
				services: () => [{ hostname: appId, type: 'alpine/bun@1.3' }],
				// A worker serves nothing through the proxy, so it carries no contract and no table.
				...(options.proxy === false ? {} : { contract, proxy: { upstream: `${appId}:3000`, ...contractProxyTable(contract) } }),
			},
		}),
		options.manifestEnv ?? 'prod',
		SOURCE_DESCRIPTOR,
	)
	const access = options.access === undefined ? approved(contractOf(appId)) : options.access
	return {
		appId,
		env: 'prod',
		...(domain === undefined ? {} : { domain }),
		artifact: { provider: 'zerops', version: zeropsArtifactCodec.version, payload: zeropsArtifactCodec.encode(manifest) },
		...(access === null ? {} : { access }),
	}
}

const isJsonObject = (value: JsonValue | undefined): value is { [key: string]: JsonValue } =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** A member registered before applications needed a contract: its artifact's proxy carries gates, and nothing is approved. */
const legacyMember = (appId: string, domain: string): ProviderNamespaceMember => {
	const { access: _access, ...current } = member(appId, domain, { access: null })
	const payload = current.artifact.payload
	if (!isJsonObject(payload) || !isJsonObject(payload['target'])) throw new Error('the encoded artifact is not an object')
	const target = { ...payload['target'], proxy: { upstream: `${appId}:3000`, gates: { rules: [{ path: '/*', kind: 'public' }] } } }
	return { ...current, artifact: { ...current.artifact, payload: { ...payload, target } } }
}

describe('namespace proxy manifest', () => {
	test('routes every public member on its lowercased domain over https and skips members without a proxy', () => {
		expect(compileNamespaceProxyManifest('apps-prod', [
			member('alpha', 'Alpha.Example.com'),
			member('worker', undefined, { proxy: false }),
			member('beta', 'beta.example.com'),
		])).toEqual({
			apps: [
				{ id: 'alpha@prod', hosts: ['alpha.example.com'], upstream: 'alpha:3000', scheme: 'https', ...contractProxyTable(contractOf('alpha')) },
				{ id: 'beta@prod', hosts: ['beta.example.com'], upstream: 'beta:3000', scheme: 'https', ...contractProxyTable(contractOf('beta')) },
			],
		})
	})

	test('a contract application gets its endpoint table instead of gates, in a manifest the proxy accepts', () => {
		const manifest = compileNamespaceProxyManifest('apps-prod', [
			member('notes', 'notes.example.com', { access: approved(notesArtifact) }),
			member('beta', 'beta.example.com'),
		])
		expect(manifest.apps[0]).toEqual({ id: 'notes@prod', hosts: ['notes.example.com'], upstream: 'notes:3000', scheme: 'https', ...TABLE })
		expect(parseProxyManifest(manifest)).toEqual(manifest)
	})

	test("a contract application's entry carries the Operations ingest origin Control handed its member", () => {
		const notes = member('notes', 'notes.example.com', { access: approved(notesArtifact) })
		const manifest = compileNamespaceProxyManifest('apps-prod', [{ ...notes, operationsOrigin: 'https://operations.example.com' }])
		expect(manifest.apps[0]).toEqual({
			id: 'notes@prod',
			hosts: ['notes.example.com'],
			upstream: 'notes:3000',
			scheme: 'https',
			...TABLE,
			operationsOrigin: 'https://operations.example.com',
		})
		expect(parseProxyManifest(manifest)).toEqual(manifest)
		expect(() => compileNamespaceProxyManifest('apps-prod', [{ ...notes, operationsOrigin: 'https://key@operations.example.com' }])).toThrow(
			'proxy entry `notes@prod` is one the proxy manifest refuses (operationsOrigin)',
		)
	})

	test("a contract application's entry lists the cross origins its environment names, and omits an empty list", () => {
		const notes = member('notes', 'notes.example.com', { access: approved(notesArtifact) })
		const origins = ['https://partner.example.org', 'http://localhost:5173']
		const manifest = compileNamespaceProxyManifest('apps-prod', [{ ...notes, crossOrigins: origins }])
		expect(manifest.apps[0]).toEqual({
			id: 'notes@prod',
			hosts: ['notes.example.com'],
			upstream: 'notes:3000',
			scheme: 'https',
			...TABLE,
			crossOrigins: origins,
		})
		expect(parseProxyManifest(manifest)).toEqual(manifest)
		expect(compileNamespaceProxyManifest('apps-prod', [{ ...notes, crossOrigins: [] }]).apps[0]).not.toHaveProperty('crossOrigins')
	})

	test('a cross-origin list the manifest parser would refuse fails the compile', () => {
		const notes = member('notes', 'notes.example.com', { access: approved(notesArtifact) })
		const refused = [
			['https://partner.example.org/'],
			['https://partner.example.org', 'https://partner.example.org'],
			['https://notes.example.com'],
			['https://*.example.org'],
			Array.from({ length: 17 }, (_, index) => `https://p${index}.example.org`),
		]
		for (const crossOrigins of refused) {
			expect(() => compileNamespaceProxyManifest('apps-prod', [{ ...notes, crossOrigins }])).toThrow(
				'proxy entry `notes@prod` is one the proxy manifest refuses',
			)
		}
	})

	test('the table comes from the approved contract, never the artifact; a contract without approval is not routed', () => {
		const narrowed: ContractArtifact = { ...notesArtifact, endpoints: notesArtifact.endpoints.slice(0, 1) }
		const routed = compileNamespaceProxyManifest('apps-prod', [member('notes', 'notes.example.com', { access: approved(narrowed) })])
		expect(routed.apps[0]).toEqual({
			id: 'notes@prod',
			hosts: ['notes.example.com'],
			upstream: 'notes:3000',
			scheme: 'https',
			...contractProxyTable(narrowed),
		})
		expect(compileNamespaceProxyManifest('apps-prod', [member('notes', 'notes.example.com', { access: null })])).toEqual({ apps: [] })
	})

	test('a legacy member whose artifact carries gates is not routed, and the approved members still are', () => {
		const legacy = legacyMember('legacy', 'legacy.example.test')
		expect(() => zeropsArtifactCodec.decode(legacy.artifact.payload)).toThrow('`gates` is gone')
		const manifest = compileNamespaceProxyManifest('apps-prod', [legacy, member('notes', 'notes.example.test')])
		expect(manifest.apps.map((app) => app.id)).toEqual(['notes@prod'])
		expect(parseProxyManifest(manifest)).toEqual(manifest)
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
