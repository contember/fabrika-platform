import {
	compileFabrikaManifest,
	defineApp,
	ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE,
	ZEROPS_NAMESPACE_IAM_KEY_VARIABLE,
	type ZeropsAppVersion,
	zeropsArtifactCodec,
	type ZeropsArtifactSourceDescriptor,
	zeropsNamespaceTargetCodec,
	zeropsStoredTargetCodec,
} from '@fabrika/provider-zerops'
import { FABRIKA_PROXY_MANIFEST_JSON } from '@fabrika/proxy-contract'
import { describe, expect, test } from 'bun:test'
import { createHarness } from '../../__tests__/helpers/harness'
import { compileNamespaceProxyManifest, syncNamespaceProxy, syncZeropsProxy } from '../zerops-proxy'

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
			// The proxy already carries the PREVIOUS installation's issuer, which is the case that took a
			// live proxy down: new code, configuration nobody rewrote.
			listServiceEnv: () => Promise.resolve([{ id: 'env-1', key: ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE, content: 'https://iam.stale.example' }]),
			putServiceEnv: (input: { serviceId: string; key: string; value: string; signal: AbortSignal }) => {
				calls.push(`put:${input.serviceId}:${input.key}`)
				if (input.key === FABRIKA_PROXY_MANIFEST_JSON) {
					written = input.value
				}
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
			iamUrl: 'https://iam.example.com',
			iamKey: 'px_proxy',
			sleep: () => Promise.resolve(),
		})
		// Every variable the proxy's code reads is written BEFORE the pipeline that replaces that code.
		expect(calls).toEqual([
			`put:proxy-shared:${FABRIKA_PROXY_MANIFEST_JSON}`,
			`put:proxy-shared:${ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE}`,
			`put:proxy-shared:${ZEROPS_NAMESPACE_IAM_KEY_VARIABLE}`,
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

describe('a namespace republish addressed by id alone', () => {
	/** Records what reached the platform; `written` is the manifest the proxy would then serve. */
	function fakeApi() {
		const calls: string[] = []
		let written = ''
		const api = {
			listServiceEnv: () => Promise.resolve([]),
			putServiceEnv: (input: { serviceId: string; key: string; value: string }) => {
				calls.push(`put:${input.serviceId}:${input.key}`)
				if (input.key === FABRIKA_PROXY_MANIFEST_JSON) written = input.value
				return Promise.resolve()
			},
			triggerPipeline: () => {
				calls.push('trigger')
				return Promise.resolve({ id: 'process-1', appVersionId: 'version-1' })
			},
			latestAppVersion: () => Promise.resolve(null),
			getAppVersion: () => {
				calls.push('poll')
				return Promise.resolve({ id: 'version-1', status: 'ACTIVE' } satisfies ZeropsAppVersion)
			},
		}
		return { api, calls, manifest: () => written }
	}

	async function seedNamespace(
		db: ReturnType<typeof createHarness>['db'],
		options: { state?: 'ready' | 'failed'; proxyServiceId?: string; proxyBuildFromGit?: string; ready?: boolean } = {},
	): Promise<void> {
		await db.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'zerops',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(envelope(zeropsNamespaceTargetCodec, {
				projectId: 'project-1',
				...(options.proxyServiceId === undefined ? {} : { proxyServiceId: options.proxyServiceId }),
				...(options.proxyBuildFromGit === undefined ? {} : { proxyBuildFromGit: options.proxyBuildFromGit }),
				ready: options.ready ?? true,
			})),
			state: options.state ?? 'ready',
		})
	}

	async function seedApp(db: ReturnType<typeof createHarness>['db'], id: string, domain: string): Promise<void> {
		await db.registry.createApp({ id, repoUrl: `github.com/acme/${id}` })
		await db.registry.upsertAppEnv({
			appId: id,
			env: 'prod',
			domain,
			namespaceId: 'apps-prod',
			provider: 'zerops',
			providerTargetJson: JSON.stringify(envelope(zeropsStoredTargetCodec, { serviceId: `${id}-service` })),
			providerArtifactJson: JSON.stringify(envelope(zeropsArtifactCodec, appManifest(id, 'prod', `${id}:3000`))),
		})
	}

	const sync = (db: ReturnType<typeof createHarness>['db'], api: ReturnType<typeof fakeApi>['api']) =>
		syncNamespaceProxy({
			db: db.registry,
			api,
			namespaceId: 'apps-prod',
			iamUrl: 'https://iam.example.com',
			iamKey: 'px_proxy',
			sleep: () => Promise.resolve(),
		})

	test('publishes the registry as it stands, so a deleted app is no longer routed or gated', async () => {
		const { db } = createHarness()
		await seedNamespace(db, { proxyServiceId: 'proxy-shared', proxyBuildFromGit: 'https://github.com/acme/proxy' })
		await seedApp(db, 'notes', 'notes.example.com')
		await seedApp(db, 'keeps', 'keeps.example.com')

		const before = fakeApi()
		await sync(db, before.api)
		expect(JSON.parse(before.manifest()).apps.map((app: { hosts: string[] }) => app.hosts[0])).toEqual([
			'keeps.example.com',
			'notes.example.com',
		])

		expect(await db.registry.deleteApp('notes')).toBe(true)
		const after = fakeApi()
		await sync(db, after.api)

		expect(JSON.parse(after.manifest())).toEqual({
			apps: [
				{
					id: 'keeps',
					hosts: ['keeps.example.com'],
					upstream: 'keeps:3000',
					gates: { rules: [{ path: '/healthz', kind: 'public' }, { path: '/*', kind: 'human' }] },
					scheme: 'https',
				},
			],
		})
		expect(after.manifest()).not.toContain('notes.example.com')
	})

	test('publishes and starts the roll, but never waits for the build — this runs inside a request', async () => {
		const { db } = createHarness()
		await seedNamespace(db, { proxyServiceId: 'proxy-shared', proxyBuildFromGit: 'https://github.com/acme/proxy' })
		await seedApp(db, 'keeps', 'keeps.example.com')
		const recorded = fakeApi()

		await sync(db, recorded.api)

		// Everything the proxy's code reads is published, the pipeline is told to build — and no poll.
		expect(recorded.calls).toEqual([
			`put:proxy-shared:${FABRIKA_PROXY_MANIFEST_JSON}`,
			`put:proxy-shared:${ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE}`,
			`put:proxy-shared:${ZEROPS_NAMESPACE_IAM_KEY_VARIABLE}`,
			'trigger',
		])
		expect(recorded.calls).not.toContain('poll')
	})

	test('refuses a namespace that is not ready or carries no proxy, before touching the platform', async () => {
		for (
			const seed of [
				{ state: 'failed' as const, proxyServiceId: 'proxy', proxyBuildFromGit: 'https://github.com/acme/proxy' },
				{ ready: false, proxyServiceId: 'proxy', proxyBuildFromGit: 'https://github.com/acme/proxy' },
				{ proxyBuildFromGit: 'https://github.com/acme/proxy' },
				{ proxyServiceId: 'proxy' },
			]
		) {
			const { db } = createHarness()
			await seedNamespace(db, seed)
			const recorded = fakeApi()
			await expect(sync(db, recorded.api)).rejects.toThrow()
			expect(recorded.calls).toEqual([])
		}
	})

	test('refuses an unknown namespace rather than publishing an empty manifest over it', async () => {
		const { db } = createHarness()
		const recorded = fakeApi()
		await expect(sync(db, recorded.api)).rejects.toThrow('not found')
		expect(recorded.calls).toEqual([])
	})
})
