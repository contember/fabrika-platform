import { type SqlDatabase, SqlDeployLocks } from '@fabrika/platform'
import {
	compileFabrikaManifest,
	createZeropsApi,
	createZeropsArtifactSourceDescriptor,
	createZeropsNamespaceCapabilities,
	defineApp,
	ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE,
	ZEROPS_NAMESPACE_IAM_KEY_VARIABLE,
	type ZeropsAppVersion,
	zeropsArtifactCodec,
	type ZeropsArtifactSourceDescriptor,
	zeropsNamespaceTargetCodec,
	type ZeropsSourceClient,
	zeropsStoredTargetCodec,
} from '@fabrika/provider-zerops'
import { FABRIKA_PROXY_MANIFEST_JSON } from '@fabrika/proxy-contract'
import { describe, expect, test } from 'bun:test'
import { createHarness } from '../../__tests__/helpers/harness'
import { runNamespaceJob } from '../../api/namespaces'
import { runMaintenance } from '../../cron'
import type { Env } from '../../env'
import { FakeRepoSource } from '../../repo-source'
import type { ControlJobMessage } from '../../run-lifecycle'
import { compileNamespaceProxyManifest, syncNamespaceProxy, syncZeropsProxy } from '../zerops-proxy'

const SOURCE_DESCRIPTOR: ZeropsArtifactSourceDescriptor = {
	path: 'zerops.yaml',
	contents: 'zerops:\n  - setup: test\n',
	sha256: '560802d669a116e27e5ce76af3312048e3e9e7743a4fb7d6e73f14d800dc46d1',
}

const PIN = {
	repository: { owner: 'example', name: 'platform' },
	commitSha: 'a'.repeat(40),
	descriptor: await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: proxy\n'),
}
const source: ZeropsSourceClient = {
	resolve: async input => ({ protocolVersion: 1, runId: input.runId, commitSha: PIN.commitSha, descriptorSha256: PIN.descriptor.sha256 }),
	upload: async input => ({
		protocolVersion: 1,
		runId: input.runId,
		appVersionId: input.appVersionId,
		commitSha: input.commitSha,
		descriptorSha256: input.descriptor.sha256,
	}),
	cancel: async () => {},
}
const lock = (db: SqlDatabase) => {
	const store = new SqlDeployLocks(db)
	return {
		acquire: (key: string, holder: string) => store.acquire(key, holder, 30 * 60 * 1000),
		renew: (key: string, holder: string) => store.renew(key, holder, 30 * 60 * 1000),
		release: (key: string, holder: string) => store.release(key, holder),
	}
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
		const { db, d1 } = createHarness()
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
					proxySource: PIN,
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
			createAppVersion: async () => ({ id: 'version-1', uploadUrl: 'https://upload.example.test' }),
			deleteAppVersion: async () => {},
			cancelBuild: async () => {},
			buildAndDeployAppVersion: (input: { appVersionId: string }) => {
				calls.push(`trigger:${input.appVersionId}`)
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
			lock: lock(d1),
			source,
			api,
			namespaceId: 'apps-prod',
			iamUrl: 'https://iam.example.com',
			iamKey: 'px_proxy',
			sleep: () => Promise.resolve(),
		})
		// Every variable the proxy's code reads is written BEFORE the pipeline that replaces that code.
		expect(calls).toEqual([
			`put:proxy-shared:${FABRIKA_PROXY_MANIFEST_JSON}`,
			`put:proxy-shared:${ZEROPS_NAMESPACE_IAM_ISSUER_VARIABLE}`,
			`put:proxy-shared:${ZEROPS_NAMESPACE_IAM_KEY_VARIABLE}`,
			'trigger:version-1',
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
			createAppVersion: async () => ({ id: 'version-1', uploadUrl: 'https://upload.example.test' }),
			deleteAppVersion: async () => {},
			cancelBuild: async () => {},
			buildAndDeployAppVersion: () => {
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
				...(options.proxyBuildFromGit === undefined ? {} : { proxySource: PIN }),
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

	const sync = (db: ReturnType<typeof createHarness>['db'], api: ReturnType<typeof fakeApi>['api'], d1: SqlDatabase) =>
		syncNamespaceProxy({
			db: db.registry,
			queue: { send: async () => {} },
			lock: lock(d1),
			source,
			api,
			namespaceId: 'apps-prod',
			iamUrl: 'https://iam.example.com',
			iamKey: 'px_proxy',
			sleep: () => Promise.resolve(),
		})

	test('publishes the registry as it stands, so a deleted app is no longer routed or gated', async () => {
		const { db, d1 } = createHarness()
		await seedNamespace(db, { proxyServiceId: 'proxy-shared', proxyBuildFromGit: 'https://github.com/acme/proxy' })
		await seedApp(db, 'notes', 'notes.example.com')
		await seedApp(db, 'keeps', 'keeps.example.com')

		const before = fakeApi()
		await sync(db, before.api, d1)
		expect(JSON.parse(before.manifest()).apps.map((app: { hosts: string[] }) => app.hosts[0])).toEqual([
			'keeps.example.com',
			'notes.example.com',
		])

		expect(await db.registry.deleteApp('notes')).toBe(true)
		const after = fakeApi()
		await sync(db, after.api, d1)

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
		const { db, d1 } = createHarness()
		await seedNamespace(db, { proxyServiceId: 'proxy-shared', proxyBuildFromGit: 'https://github.com/acme/proxy' })
		await seedApp(db, 'keeps', 'keeps.example.com')
		const recorded = fakeApi()

		await sync(db, recorded.api, d1)

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
				{ state: 'failed', proxyServiceId: 'proxy', proxyBuildFromGit: 'https://github.com/acme/proxy' } satisfies Parameters<typeof seedNamespace>[1],
				{ ready: false, proxyServiceId: 'proxy', proxyBuildFromGit: 'https://github.com/acme/proxy' },
				{ proxyBuildFromGit: 'https://github.com/acme/proxy' },
				{ proxyServiceId: 'proxy' },
			]
		) {
			const { db, d1 } = createHarness()
			await seedNamespace(db, seed)
			const recorded = fakeApi()
			await expect(sync(db, recorded.api, d1)).rejects.toThrow()
			expect(recorded.calls).toEqual([])
		}
	})

	test('refuses an unknown namespace rather than publishing an empty manifest over it', async () => {
		const { db, d1 } = createHarness()
		const recorded = fakeApi()
		await expect(sync(db, recorded.api, d1)).rejects.toThrow('not found')
		expect(recorded.calls).toEqual([])
	})

	test('app-style sync excludes registry republish and namespace reconcile on the same SQL lease', async () => {
		const { db, d1 } = createHarness()
		await seedNamespace(db, { proxyServiceId: 'proxy-shared', proxyBuildFromGit: 'legacy-inspection-only' })
		await seedApp(db, 'first', 'first.example.test')
		const recorded = fakeApi()
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const api = {
			...recorded.api,
			buildAndDeployAppVersion: async () => {
				entered.resolve()
				await release.promise
				return recorded.api.buildAndDeployAppVersion()
			},
		}
		const first = syncZeropsProxy({
			db: db.registry,
			lock: lock(d1),
			source,
			api,
			namespaceId: 'apps-prod',
			iamUrl: 'https://iam.example.test',
			iamKey: 'not-logged',
		})
		await entered.promise
		try {
			await seedApp(db, 'second', 'second.example.test')
			await expect(sync(db, recorded.api, d1)).rejects.toThrow('busy')
			const job = await runNamespaceJob({
				repositories: db,
				lock: lock(d1),
				provider: {
					id: 'zerops',
					normalizeRegistration: input => input,
					deploy: async () => {
						throw new Error('not called')
					},
					namespaces: {
						normalize: input => input,
						namespaceResourceClaims: () => [],
						registrationResourceClaims: () => [],
						provision: async () => {
							throw new Error('competing provision')
						},
						reconcile: async () => {
							throw new Error('competing reconcile')
						},
					},
				},
			}, { kind: 'namespace', namespaceId: 'apps-prod', mutation: 'reconcile' })
			expect(job.status).toBe('deferred')
		} finally {
			release.resolve()
		}
		await first
		expect(recorded.manifest()).not.toContain('second.example.test')
		await sync(db, recorded.api, d1)
		expect(recorded.manifest()).toContain('second.example.test')
	})

	test('a new request cannot bypass an ambiguous durable attempt after the first invocation releases its lease', async () => {
		const { db, d1 } = createHarness()
		await seedNamespace(db, { proxyServiceId: 'proxy-shared', proxyBuildFromGit: 'legacy-inspection-only' })
		const recorded = fakeApi()
		const api = {
			...recorded.api,
			buildAndDeployAppVersion: async () => {
				recorded.calls.push('ambiguous')
				throw new Error('response lost')
			},
			getAppVersion: async (): Promise<ZeropsAppVersion> => ({ id: 'version-1', status: 'UPLOADING' }),
		}
		const input = {
			db: db.registry,
			lock: lock(d1),
			queue: { send: async () => {} },
			source,
			api,
			namespaceId: 'apps-prod',
			iamUrl: 'https://iam.example.test',
			iamKey: 'not-logged',
		}
		await expect(syncNamespaceProxy(input)).rejects.toThrow('version-1 remains unresolved')
		const row = await db.registry.getDeploymentNamespace('apps-prod')
		expect(row?.state).toBe('provisioning')
		expect(row?.provider_target_json).toContain('build_trigger_requested')
		recorded.calls.length = 0
		await expect(syncNamespaceProxy(input)).rejects.toThrow('version-1 remains unresolved')
		expect(recorded.calls).toEqual([])
		await syncNamespaceProxy({ ...input, api: recorded.api })
		expect(recorded.calls).toContain('trigger')
		expect((await db.registry.getDeploymentNamespace('apps-prod'))?.state).toBe('provisioning')
	})

	for (const delivery of ['queued', 'enqueue-failed', 'crash-gap']) {
		test(`started request reaches ready through the existing namespace worker after ${delivery}`, async () => {
			const { db, d1 } = createHarness()
			await seedNamespace(db, { proxyServiceId: 'proxy-shared', proxyBuildFromGit: 'inspection-only' })
			const recorded = fakeApi()
			const jobs: ControlJobMessage[] = []
			const queue = {
				send: async (job: ControlJobMessage) => {
					jobs.push(job)
				},
			}
			const input = {
				db: db.registry,
				lock: lock(d1),
				source,
				api: recorded.api,
				namespaceId: 'apps-prod',
				iamUrl: 'https://iam.example.test',
				iamKey: 'not-logged',
				queue: delivery === 'enqueue-failed'
					? {
						send: async () => {
							throw new Error('queue unavailable')
						},
					}
					: queue,
			}
			if (delivery === 'enqueue-failed') await expect(syncNamespaceProxy(input)).rejects.toThrow('queue unavailable')
			else await syncNamespaceProxy(input)
			expect((await db.registry.getDeploymentNamespace('apps-prod'))?.state).toBe('provisioning')
			if (delivery === 'crash-gap') jobs.length = 0
			if (delivery !== 'queued') {
				const env: Env = {
					DB: d1,
					REPOSITORIES: db,
					DEPLOY_QUEUE: queue,
					ENVIRONMENT: 'local',
					REPO_EVENTS: new FakeRepoSource(),
					ASSETS: { fetch: async () => new Response() },
					WAIT_UNTIL: () => {},
					RUN_LOGS: { put: async () => {}, get: async () => null, delete: async () => {} },
				}
				await runMaintenance(env)
			}
			expect(jobs).toEqual([{ kind: 'namespace', namespaceId: 'apps-prod', mutation: 'reconcile' }])
			const job = jobs[0]
			if (job?.kind !== 'namespace') throw new Error('missing namespace job')
			const capabilities = createZeropsNamespaceCapabilities({
				clientId: 'client',
				iamUrl: input.iamUrl,
				iamKey: input.iamKey,
				source,
				proxyManifest: async () => recorded.manifest(),
				api: {
					...createZeropsApi({ token: 'not-used' }),
					...recorded.api,
					getProject: async () => ({ id: 'project-1', name: 'apps-prod', mode: 'LIGHT', description: 'Managed by Fabrika namespace apps-prod (prod).' }),
					listProjectServices: async () => [{ id: 'proxy-shared', name: 'proxy', base: 'alpine@3.21', projectId: 'project-1' }],
				},
			})
			const result = await runNamespaceJob({
				repositories: db,
				lock: lock(d1),
				provider: {
					id: 'zerops',
					normalizeRegistration: value => value,
					deploy: async () => {
						throw new Error('not called')
					},
					namespaces: capabilities,
				},
			}, job)
			expect(result.status).toBe('ready')
			expect(recorded.calls.filter(call => call === 'trigger')).toHaveLength(1)
			expect((await db.registry.getDeploymentNamespace('apps-prod'))?.state).toBe('ready')
			expect(await db.registry.deleteDeploymentNamespaceWithResourceClaims('apps-prod')).not.toBeNull()
		})
	}
})
