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
import { sandboxUpstreamHost } from '../sandbox-host'
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

describe('namespaceProxySecrets: dev sandboxes', () => {
	const WORKSPACE = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
	const devMember = (proxySecret?: string): ProviderNamespaceMember => {
		const routed = member('notes', { routed: true, proxySecret: 'member-secret' })
		const access = routed.access
		if (access === undefined) throw new Error('the routed member carries access')
		return {
			...routed,
			env: 'dev',
			devSandboxes: [{
				workspaceId: WORKSPACE,
				host: `${WORKSPACE}.dev.example.com`,
				upstreamHost: sandboxUpstreamHost('sbxa'),
				...(proxySecret === undefined ? {} : { proxySecret }),
				access,
			}],
		}
	}

	test("names each sandbox entry's own secret by its entry id, never the member's", () => {
		const members = [devMember('sandbox-secret')]
		const secrets = namespaceProxySecrets(compileNamespaceProxyManifest('apps-dev', members), members)
		expect([...secrets]).toEqual([[proxySecretVariable(`dev:notes:${WORKSPACE}`), 'sandbox-secret']])
	})

	test('refuses a sandbox entry Control handed no secret, even when its member has one', () => {
		for (const proxySecret of [undefined, '']) {
			const members = [devMember(proxySecret)]
			expect(() => namespaceProxySecrets(compileNamespaceProxyManifest('apps-dev', members), members)).toThrow(
				`dev:notes:${WORKSPACE} is a contract application, and Control supplied no proxy secret`,
			)
		}
	})
})
