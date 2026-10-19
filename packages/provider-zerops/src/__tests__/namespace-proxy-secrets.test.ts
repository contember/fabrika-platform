import { contractDigest, proxySecretVariable } from '@fabrika/auth-core'
import type { ProviderNamespaceMember } from '@fabrika/provider-contract'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { schemaFromContract } from '../../../app/src/contract/platform'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { defineApp } from '../authoring'
import { FABRIKA_CHECK_VERSION } from '../execution'
import { compileFabrikaManifest, zeropsArtifactCodec } from '../manifest'
import { compileNamespaceProxyManifest } from '../namespace/manifest'
import { namespaceProxySecrets } from '../namespace/proxy-secrets'
import { SOURCE_DESCRIPTOR } from './fixtures/descriptor'

/** A contract application, or (`routed: false`) one Control approved nothing for, so its proxy does not route it. */
const member = (appId: string, options: { routed: boolean; proxySecret?: string }): ProviderNamespaceMember => {
	const contract = { ...notesArtifact, app: appId }
	const manifest = compileFabrikaManifest(
		defineApp({
			id: appId,
			target: {
				platform: 'zerops',
				services: () => [{ hostname: appId, type: 'alpine/bun@1.3' }],
				proxy: { upstream: `${appId}:3000`, ...contractProxyTable(contract) },
				contract,
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
		...(options.routed
			? { access: { contract, contractDigest: contractDigest(contract), schema: schemaFromContract(contract), checker: FABRIKA_CHECK_VERSION } }
			: {}),
		...(options.proxySecret === undefined ? {} : { proxySecret: options.proxySecret }),
	}
}

describe('namespaceProxySecrets', () => {
	test("names each routed application's secret by its proxy variable, and none of one the proxy does not route", () => {
		const members = [member('notes', { routed: true, proxySecret: 'notes-secret' }), member('wiki', { routed: false, proxySecret: 'wiki-secret' })]
		const secrets = namespaceProxySecrets(compileNamespaceProxyManifest('apps-prod', members), members)
		expect([...secrets]).toEqual([[proxySecretVariable('notes@prod'), 'notes-secret']])
	})

	test('refuses a contract application whose member carries no secret: it would refuse every request', () => {
		for (const proxySecret of [undefined, '']) {
			const members = [member('notes', { routed: true, ...(proxySecret === undefined ? {} : { proxySecret }) })]
			expect(() => namespaceProxySecrets(compileNamespaceProxyManifest('apps-prod', members), members)).toThrow(
				'notes@prod is a contract application, and Control supplied no proxy secret',
			)
		}
	})

	test('needs no secret for an application the proxy does not route', () => {
		const members = [member('wiki', { routed: false })]
		expect(namespaceProxySecrets(compileNamespaceProxyManifest('apps-prod', members), members).size).toBe(0)
	})
})
