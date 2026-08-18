import {
	compileFabrikaManifest,
	defineApp,
	type ZeropsAppVersion,
	zeropsArtifactCodec,
	type ZeropsArtifactSourceDescriptor,
	zeropsNamespaceTargetCodec,
	zeropsStoredTargetCodec,
} from '@fabrika/provider-zerops'
import { FABRIKA_PROXY_MANIFEST_JSON } from '@fabrika/proxy-contract'
import { describe, expect, test } from 'bun:test'
import { createHarness } from '../../__tests__/helpers/harness'
import { compileNamespaceProxyManifest, syncZeropsProxy } from '../zerops-proxy'

const SOURCE_DESCRIPTOR: ZeropsArtifactSourceDescriptor = {
	path: 'zerops.yaml',
	contents: 'zerops:\n  - setup: test\n',
	sha256: '560802d669a116e27e5ce76af3312048e3e9e7743a4fb7d6e73f14d800dc46d1',
}

const appManifest = (id: string, env: string, upstream: string) =>
	compileFabrikaManifest(
		defineApp({
			id,
			target: {
				platform: 'zerops',
				services: () => [{ hostname: id, type: 'alpine/bun@1.3' }],
				proxy: { upstream, gates: { rules: [{ path: '/healthz', kind: 'public' }, { path: '/*', kind: 'human' }] } },
			},
		}),
		env,
		SOURCE_DESCRIPTOR,
	)

const envelope = <T>(codec: { version: number; encode(value: T): unknown }, value: T) => ({
	provider: 'zerops',
	version: codec.version,
	payload: codec.encode(value),
})

describe('Zerops proxy manifest delivery', () => {
	test('groups manifests by namespace and rolls the selected namespace proxy directly', async () => {
		const { db } = createHarness()
		for (const id of ['alpha', 'beta', 'gamma']) {
			await db.registry.createApp({ id, repoUrl: `github.com/acme/${id}` })
		}
		for (
			const namespace of [
				{ id: 'apps-prod', projectId: 'project-shared', proxyServiceId: 'proxy-shared', exclusiveAppId: null },
				{ id: 'gamma-prod', projectId: 'project-gamma', proxyServiceId: 'proxy-gamma', exclusiveAppId: 'gamma' },
			]
		) {
			await db.registry.createDeploymentNamespace({
				id: namespace.id,
				env: 'prod',
				provider: 'zerops',
				exclusiveAppId: namespace.exclusiveAppId,
				providerTargetJson: JSON.stringify(envelope(zeropsNamespaceTargetCodec, {
					projectId: namespace.projectId,
					proxyServiceId: namespace.proxyServiceId,
					ready: true,
				})),
				state: 'ready',
			})
		}
		for (
			const entry of [
				{ id: 'alpha', namespaceId: 'apps-prod', domain: 'Alpha.Example.com', upstream: 'alpha:3000' },
				{ id: 'beta', namespaceId: 'apps-prod', domain: 'beta.example.com', upstream: 'beta:8080' },
				{ id: 'gamma', namespaceId: 'gamma-prod', domain: 'gamma.example.com', upstream: 'gamma:3000' },
			]
		) {
			await db.registry.upsertAppEnv({
				appId: entry.id,
				env: 'prod',
				domain: entry.domain,
				namespaceId: entry.namespaceId,
				provider: 'zerops',
				providerTargetJson: JSON.stringify(
					envelope(zeropsStoredTargetCodec, { serviceId: `${entry.id}-service` }),
				),
				providerArtifactJson: JSON.stringify(
					envelope(zeropsArtifactCodec, appManifest(entry.id, 'prod', entry.upstream)),
				),
			})
		}

		const calls: string[] = []
		let written = ''
		const active: ZeropsAppVersion = { id: 'version-1', status: 'ACTIVE' }
		const api = {
			putServiceEnv: (input: { serviceId: string; key: string; value: string; signal: AbortSignal }) => {
				calls.push(`put:${input.serviceId}:${input.key}`)
				written = input.value
				return Promise.resolve()
			},
			triggerPipeline: (input: { buildFromGit?: string }) => {
				const { buildFromGit } = input
				// A namespace proxy has no Git integration, so a trigger without a source answers 400.
				calls.push(`trigger:${buildFromGit ?? '(none)'}`)
				return Promise.resolve({ id: 'process-1', appVersionId: 'version-1' })
			},
			latestAppVersion: () => Promise.resolve(null),
			getAppVersion: () => {
				calls.push('poll')
				return Promise.resolve(active)
			},
		}

		expect((await compileNamespaceProxyManifest(db.registry, 'gamma-prod')).apps.map((app) => app.id)).toEqual(['gamma'])
		await syncZeropsProxy({
			db: db.registry,
			api,
			namespaceId: 'apps-prod',
			proxyServiceId: 'proxy-shared',
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
			sleep: () => Promise.resolve(),
		})
		expect(calls).toEqual([
			`put:proxy-shared:${FABRIKA_PROXY_MANIFEST_JSON}`,
			'trigger:https://github.com/contember/fabrika-platform',
			'poll',
		])
		expect(JSON.parse(written)).toEqual({
			apps: [
				{
					id: 'alpha',
					hosts: ['alpha.example.com'],
					upstream: 'alpha:3000',
					gates: { rules: [{ path: '/healthz', kind: 'public' }, { path: '/*', kind: 'human' }] },
					scheme: 'https',
				},
				{
					id: 'beta',
					hosts: ['beta.example.com'],
					upstream: 'beta:8080',
					gates: { rules: [{ path: '/healthz', kind: 'public' }, { path: '/*', kind: 'human' }] },
					scheme: 'https',
				},
			],
		})
	})

	test('fails before writing when a public app in the namespace has no domain', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'alpha', repoUrl: 'github.com/acme/alpha' })
		await db.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'zerops',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(envelope(zeropsNamespaceTargetCodec, {
				projectId: 'project-1',
				proxyServiceId: 'proxy-service',
				ready: true,
			})),
			state: 'ready',
		})
		await db.registry.upsertAppEnv({
			appId: 'alpha',
			env: 'prod',
			namespaceId: 'apps-prod',
			provider: 'zerops',
			providerTargetJson: JSON.stringify(
				envelope(zeropsStoredTargetCodec, { serviceId: 'alpha-service' }),
			),
			providerArtifactJson: JSON.stringify(
				envelope(zeropsArtifactCodec, appManifest('alpha', 'prod', 'alpha:3000')),
			),
		})
		await expect(compileNamespaceProxyManifest(db.registry, 'apps-prod')).rejects.toThrow('requires a public domain')
	})
})
