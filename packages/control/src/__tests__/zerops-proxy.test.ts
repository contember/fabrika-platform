import {
	compileFabrikaManifest,
	defineApp,
	type ZeropsAppVersion,
	zeropsArtifactCodec,
	zeropsStoredTargetCodec,
} from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { compileProjectProxyManifest, PROXY_MANIFEST_VARIABLE, syncZeropsProxy } from '../zerops-proxy'
import { createHarness } from './helpers/harness'

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
	)

const envelope = <T>(codec: { version: number; encode(value: T): unknown }, value: T) => ({
	provider: 'zerops',
	version: codec.version,
	payload: codec.encode(value),
})

describe('Zerops proxy manifest delivery', () => {
	test('compiles all apps in a project, writes one service variable, and rolls the proxy', async () => {
		const { db } = createHarness()
		for (
			const entry of [
				{ id: 'alpha', domain: 'Alpha.Example.com', upstream: 'alpha:3000' },
				{ id: 'beta', domain: 'beta.example.com', upstream: 'beta:8080' },
			]
		) {
			await db.createApp({ id: entry.id, repoUrl: `github.com/acme/${entry.id}` })
			await db.upsertAppEnv({
				appId: entry.id,
				env: 'prod',
				domain: entry.domain,
				provider: 'zerops',
				providerTargetJson: JSON.stringify(
					envelope(zeropsStoredTargetCodec, { projectId: 'project-1', serviceId: `${entry.id}-service` }),
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
			findService: () => Promise.resolve({ id: 'proxy-service', name: 'proxy' }),
			putServiceEnv: (input: { serviceId: string; key: string; value: string; signal: AbortSignal }) => {
				calls.push(`put:${input.serviceId}:${input.key}`)
				written = input.value
				return Promise.resolve()
			},
			triggerPipeline: () => {
				calls.push('trigger')
				return Promise.resolve({ id: 'process-1', appVersionId: 'version-1' })
			},
			latestAppVersion: () => Promise.resolve(null),
			getAppVersion: () => {
				calls.push('poll')
				return Promise.resolve(active)
			},
		}

		await syncZeropsProxy({ db, api, projectId: 'project-1', sleep: () => Promise.resolve() })
		expect(calls).toEqual([`put:proxy-service:${PROXY_MANIFEST_VARIABLE}`, 'trigger', 'poll'])
		expect(JSON.parse(written)).toEqual({
			apps: [
				{
					id: 'alpha',
					hosts: ['alpha.example.com'],
					upstream: 'alpha:3000',
					gates: { rules: [{ path: '/healthz', kind: 'public' }, { path: '/*', kind: 'human' }] },
				},
				{
					id: 'beta',
					hosts: ['beta.example.com'],
					upstream: 'beta:8080',
					gates: { rules: [{ path: '/healthz', kind: 'public' }, { path: '/*', kind: 'human' }] },
				},
			],
		})
	})

	test('fails before writing when a public app has no domain or the proxy is unavailable', async () => {
		const { db } = createHarness()
		await db.createApp({ id: 'alpha', repoUrl: 'github.com/acme/alpha' })
		await db.upsertAppEnv({
			appId: 'alpha',
			env: 'prod',
			provider: 'zerops',
			providerTargetJson: JSON.stringify(
				envelope(zeropsStoredTargetCodec, { projectId: 'project-1', serviceId: 'alpha-service' }),
			),
			providerArtifactJson: JSON.stringify(
				envelope(zeropsArtifactCodec, appManifest('alpha', 'prod', 'alpha:3000')),
			),
		})
		await expect(compileProjectProxyManifest(db, 'project-1')).rejects.toThrow('requires a public domain')

		await expect(
			syncZeropsProxy({
				db,
				projectId: 'missing',
				api: {
					findService: () => Promise.resolve(null),
					putServiceEnv: () => Promise.resolve(),
					triggerPipeline: () => Promise.resolve(null),
					latestAppVersion: () => Promise.resolve(null),
					getAppVersion: () => Promise.resolve({ id: 'unused' }),
				},
			}),
		).rejects.toThrow('has no proxy service')
	})
})
