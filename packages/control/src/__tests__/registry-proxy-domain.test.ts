import type { ControlProvider, ProviderEnvelope, ProviderRegistration } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import type { ApiDeps } from '../api/router'
import { handleApi } from '../api/router'
import { FakeRepoSource } from '../repo-source'
import { createHarness } from './helpers/harness'
import { allowAllAuth } from './helpers/iam'

// A namespaced provider refuses a registration whose manifest publishes the app but names no host, and
// control has to make that refusal reach the caller BEFORE the provider creates anything. The second
// half is the other side of the same problem: which hosts the namespace can serve, and which are free.

const namespaceTarget = (): ProviderEnvelope => ({ provider: 'harbor', version: 1, payload: { phase: 'ready' } })

const appTarget = (): ProviderEnvelope => ({ provider: 'harbor', version: 1, payload: {} })

/** The artifact half a Zerops manifest carries: whether this app is published through the proxy. */
const artifact = (proxy: boolean): ProviderEnvelope => ({ provider: 'harbor', version: 1, payload: { proxy } })

interface Recording {
	prepared: string[]
}

/**
 * Models the Zerops provider closely enough for this: only the provider can read its own artifact, so
 * only the provider knows a registration is a proxy target — and it refuses one with no domain from the
 * synchronous claims hook, which runs before any provider mutation.
 */
function proxyAwareProvider(recording: Recording): ControlProvider {
	const declaresProxy = (registration: ProviderRegistration): boolean => {
		const payload = registration.environment.artifact.payload
		return typeof payload === 'object' && payload !== null && !Array.isArray(payload) && payload.proxy === true
	}
	return {
		id: 'harbor',
		normalizeRegistration: (input) => input,
		deploy: () => Promise.resolve({ state: 'succeeded' }),
		namespaces: {
			normalize: (namespace) => namespace,
			namespaceResourceClaims: () => ['service:proxy'],
			registrationResourceClaims: (registration) => {
				if (declaresProxy(registration) && (registration.environment.domain ?? '').trim() === '') {
					throw new Error(
						`proxy target \`${registration.app.id}/${registration.environment.env}\` requires a public domain: pass --domain`,
					)
				}
				return [`service:${registration.app.id}`]
			},
			prepareRegistration: (input) => {
				recording.prepared.push(input.registration.app.id)
				return Promise.resolve(input.registration)
			},
			provision: (input) => Promise.resolve(input.namespace),
			reconcile: (input) => Promise.resolve(input.namespace),
			operator: {
				presets: [{ id: 'shared', label: 'Shared', description: 'Shared test namespace.', requiresExclusiveApp: false }],
				plan: (input) => ({
					namespace: { id: input.id, env: input.env, target: namespaceTarget() },
					presentation: { preset: input.preset, title: 'Planned', facts: [], instructions: [] },
				}),
				present: () => ({
					preset: 'shared',
					title: 'Test namespace',
					facts: [],
					instructions: [],
					hosts: [
						{ host: 'proxy-2ec8-8080.prg1.zerops.app', port: 8080 },
						{ host: 'proxy-2ec8-8082.prg1.zerops.app', port: 8082 },
					],
				}),
			},
		},
	}
}

function makeDeps(provider: ControlProvider): { deps: ApiDeps; repositories: ApiDeps['repositories'] } {
	const { db } = createHarness()
	const deps: ApiDeps = {
		repositories: db,
		auth: allowAllAuth(),
		queue: { send: () => Promise.resolve() },
		logs: { get: () => Promise.resolve(null) },
		repoSource: new FakeRepoSource({ fakeInstallationId: null }),
		provider,
		cancelRun: () => Promise.resolve(),
	}
	return { deps, repositories: db }
}

function req(method: string, path: string, body?: unknown): Request {
	return new Request(`https://control.test/api${path}`, {
		method,
		...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
	})
}

async function readyNamespace(repositories: ApiDeps['repositories']): Promise<void> {
	await repositories.registry.createDeploymentNamespaceWithResourceClaims({
		id: 'apps-prod',
		env: 'prod',
		provider: 'harbor',
		exclusiveAppId: null,
		providerTargetJson: JSON.stringify(namespaceTarget()),
		state: 'ready',
	}, ['service:proxy'])
}

describe('a proxy target registers with the domain its deploy needs', () => {
	test('refuses a domainless proxy registration before the provider creates anything', async () => {
		const recording: Recording = { prepared: [] }
		const { deps, repositories } = makeDeps(proxyAwareProvider(recording))
		await readyNamespace(repositories)

		const response = await handleApi(
			req('POST', '/register-app', {
				id: 'notes',
				repoUrl: 'github.com/acme/notes',
				env: 'prod',
				namespaceId: 'apps-prod',
				target: appTarget(),
				artifact: artifact(true),
			}),
			deps,
		)

		expect(response.status).toBe(400)
		expect(await response.text()).toContain('--domain')
		expect(recording.prepared).toEqual([])
		expect(await repositories.registry.getApp('notes')).toBeNull()
	})

	test('registers the same manifest once a domain names a host', async () => {
		const recording: Recording = { prepared: [] }
		const { deps, repositories } = makeDeps(proxyAwareProvider(recording))
		await readyNamespace(repositories)

		const response = await handleApi(
			req('POST', '/register-app', {
				id: 'notes',
				repoUrl: 'github.com/acme/notes',
				env: 'prod',
				namespaceId: 'apps-prod',
				domain: 'proxy-2ec8-8080.prg1.zerops.app',
				target: appTarget(),
				artifact: artifact(true),
			}),
			deps,
		)

		expect(response.status).toBe(201)
		expect(recording.prepared).toEqual(['notes'])
		expect((await repositories.registry.getAppEnv('notes', 'prod'))?.domain).toBe('proxy-2ec8-8080.prg1.zerops.app')
	})

	test('refuses an environment update that drops the domain, without calling the provider', async () => {
		const recording: Recording = { prepared: [] }
		const { deps, repositories } = makeDeps(proxyAwareProvider(recording))
		await readyNamespace(repositories)
		await handleApi(
			req('POST', '/register-app', {
				id: 'notes',
				repoUrl: 'github.com/acme/notes',
				env: 'prod',
				namespaceId: 'apps-prod',
				domain: 'proxy-2ec8-8080.prg1.zerops.app',
				target: appTarget(),
				artifact: artifact(true),
			}),
			deps,
		)
		recording.prepared.length = 0

		const response = await handleApi(
			req('PUT', '/apps/notes/envs/prod', { namespaceId: 'apps-prod', domain: null, target: appTarget(), artifact: artifact(true) }),
			deps,
		)

		expect(response.status).toBe(400)
		expect(await response.text()).toContain('--domain')
		expect(recording.prepared).toEqual([])
		// The stored environment is untouched: the refusal happens before anything is written.
		expect((await repositories.registry.getAppEnv('notes', 'prod'))?.domain).toBe('proxy-2ec8-8080.prg1.zerops.app')
	})

	test('leaves a manifest with no proxy target alone', async () => {
		const recording: Recording = { prepared: [] }
		const { deps, repositories } = makeDeps(proxyAwareProvider(recording))
		await readyNamespace(repositories)

		const response = await handleApi(
			req('POST', '/register-app', {
				id: 'worker',
				repoUrl: 'github.com/acme/worker',
				env: 'prod',
				namespaceId: 'apps-prod',
				target: appTarget(),
				artifact: artifact(false),
			}),
			deps,
		)

		expect(response.status).toBe(201)
		expect(recording.prepared).toEqual(['worker'])
	})
})

describe('a namespace says which hosts it serves', () => {
	test('marks the host a registered environment already took and leaves the rest free', async () => {
		const recording: Recording = { prepared: [] }
		const { deps, repositories } = makeDeps(proxyAwareProvider(recording))
		await readyNamespace(repositories)
		await handleApi(
			req('POST', '/register-app', {
				id: 'notes',
				repoUrl: 'github.com/acme/notes',
				env: 'prod',
				namespaceId: 'apps-prod',
				// Matched case-insensitively: the proxy manifest lowercases the domain it routes on.
				domain: 'Proxy-2ec8-8080.prg1.zerops.app',
				target: appTarget(),
				artifact: artifact(true),
			}),
			deps,
		)

		const response = await handleApi(req('GET', '/namespaces/apps-prod'), deps)

		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			hosts: [
				{ host: 'proxy-2ec8-8080.prg1.zerops.app', port: 8080, takenBy: { appId: 'notes', environment: 'prod' } },
				{ host: 'proxy-2ec8-8082.prg1.zerops.app', port: 8082 },
			],
		})
	})

	test('answers no hosts for a provider that names none', async () => {
		const provider = proxyAwareProvider({ prepared: [] })
		const operator = provider.namespaces?.operator
		if (operator === undefined) throw new Error('expected a namespace operator')
		const { deps, repositories } = makeDeps({
			...provider,
			namespaces: {
				...provider.namespaces,
				normalize: (namespace) => namespace,
				namespaceResourceClaims: () => ['service:proxy'],
				registrationResourceClaims: () => [],
				provision: (input) => Promise.resolve(input.namespace),
				reconcile: (input) => Promise.resolve(input.namespace),
				operator: { ...operator, present: () => ({ preset: 'shared', title: 'Test namespace', facts: [], instructions: [] }) },
			},
		})
		await readyNamespace(repositories)

		const body: unknown = await (await handleApi(req('GET', '/namespaces/apps-prod'), deps)).json()

		expect(body).not.toHaveProperty('hosts')
	})
})
