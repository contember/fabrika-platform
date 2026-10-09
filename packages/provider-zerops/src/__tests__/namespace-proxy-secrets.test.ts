import { contractDigest, proxySecretVariable } from '@fabrika/auth-core'
import type { ProviderNamespaceMember } from '@fabrika/provider-contract'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { schemaFromContract } from '../../../app/src/contract/platform'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { defineApp } from '../authoring'
import { compileFabrikaManifest, zeropsArtifactCodec } from '../manifest'
import { compileNamespaceProxyManifest } from '../namespace/manifest'
import { namespaceProxySecrets } from '../namespace/proxy-secrets'
import { approvedArtifact } from './fixtures/access'
import { SOURCE_DESCRIPTOR } from './fixtures/descriptor'

const member = (appId: string, options: { contract: boolean; proxySecret?: string }): ProviderNamespaceMember => {
	const proxy = options.contract
		? { upstream: `${appId}:3000`, ...contractProxyTable(notesArtifact) }
		: { upstream: `${appId}:3000`, gates: { rules: [{ path: '/*', kind: 'human' as const }] } }
	const manifest = compileFabrikaManifest(
		defineApp({
			id: appId,
			target: {
				platform: 'zerops',
				services: () => [{ hostname: appId, type: 'alpine/bun@1.3' }],
				proxy,
				...(options.contract ? { contract: notesArtifact } : {}),
			},
		}),
		'prod',
		SOURCE_DESCRIPTOR,
	)
	return {
		appId,
		env: 'prod',
		domain: `${appId}.example.com`,
		artifact: { provider: 'zerops', version: zeropsArtifactCodec.version, payload: zeropsArtifactCodec.encode(manifest) },
		...(options.contract
			? { access: { contract: notesArtifact, contractDigest: contractDigest(notesArtifact), schema: schemaFromContract(notesArtifact) } }
			: { artifactAccess: approvedArtifact(manifest) }),
		...(options.proxySecret === undefined ? {} : { proxySecret: options.proxySecret }),
	}
}

describe('namespaceProxySecrets', () => {
	test("names each contract application's secret by its proxy variable, and no gate application's", () => {
		const members = [member('notes', { contract: true, proxySecret: 'notes-secret' }), member('wiki', { contract: false, proxySecret: 'wiki-secret' })]
		const secrets = namespaceProxySecrets(compileNamespaceProxyManifest('apps-prod', members), members)
		expect([...secrets]).toEqual([[proxySecretVariable('notes@prod'), 'notes-secret']])
	})

	test('refuses a contract application whose member carries no secret: it would refuse every request', () => {
		for (const proxySecret of [undefined, '']) {
			const members = [member('notes', { contract: true, ...(proxySecret === undefined ? {} : { proxySecret }) })]
			expect(() => namespaceProxySecrets(compileNamespaceProxyManifest('apps-prod', members), members)).toThrow(
				'notes@prod is a contract application, and Control supplied no proxy secret',
			)
		}
	})

	test('needs no secret for a gate application', () => {
		const members = [member('wiki', { contract: false })]
		expect(namespaceProxySecrets(compileNamespaceProxyManifest('apps-prod', members), members).size).toBe(0)
	})
})
