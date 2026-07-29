import type { ControlProvider, ProviderDeploymentNamespace, ProviderEnvelope, ProviderRegistrationInput } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import type { ApiDeps } from '../api/router'
import { handleApi } from '../api/router'
import type { Authenticator } from '../iam'
import { FakeRepoSource } from '../repo-source'
import { createHarness } from './helpers/harness'

const target = (phase: string): ProviderEnvelope => ({
	provider: 'harbor',
	version: 1,
	payload: { phase },
})

const artifact = (): ProviderEnvelope => ({
	provider: 'harbor',
	version: 1,
	payload: { image: 'registry.example/app:v1' },
})

interface ProviderRecording {
	provisions: string[]
	reconciles: string[]
	registrations: ProviderRegistrationInput[]
	failProvision: boolean
}

function providerRecording(): ProviderRecording {
	return { provisions: [], reconciles: [], registrations: [], failProvision: false }
}

function withTarget(namespace: ProviderDeploymentNamespace, nextTarget: ProviderEnvelope): ProviderDeploymentNamespace {
	return {
		id: namespace.id,
		env: namespace.env,
		...(namespace.exclusiveAppId === undefined ? {} : { exclusiveAppId: namespace.exclusiveAppId }),
		target: nextTarget,
	}
}

function namespacedProvider(recording: ProviderRecording): ControlProvider {
	return {
		id: 'harbor',
		normalizeRegistration(input) {
			recording.registrations.push(input)
			return input
		},
		deploy: () => Promise.resolve({ state: 'succeeded' }),
		namespaces: {
			normalize(namespace) {
				if (namespace.target.provider !== 'harbor') {
					throw new Error('foreign namespace target')
				}
				return namespace
			},
			namespaceResourceClaims: () => ['service:proxy'],
			registrationResourceClaims: (registration) => [`service:${registration.app.id}`],
			async provision(input) {
				recording.provisions.push(input.namespace.id)
				const checkpoint = withTarget(input.namespace, target('checkpoint'))
				await input.events.checkpoint(checkpoint)
				if (recording.failProvision) {
					throw new Error('provider details must not escape')
				}
				return withTarget(checkpoint, target('ready'))
			},
			async reconcile(input) {
				recording.reconciles.push(input.namespace.id)
				return withTarget(input.namespace, target('reconciled'))
			},
		},
	}
}

interface AuditRecord {
	action: string
	resourceType: string
	resourceId?: string
	metadata?: unknown
}

function authenticator(actions: string[], audits: AuditRecord[]): Authenticator {
	return {
		authenticate: () =>
			Promise.resolve({
				ok: true,
				context: {
					ok: true,
					principal: { id: 'operator', type: 'user', label: 'operator@test' },
					can: (action) => actions.includes('*') || actions.includes(action),
					scopedTo: () => null,
					audit: (event) => {
						audits.push(event)
						return Promise.resolve()
					},
				},
			}),
	}
}

function makeDeps(
	provider: ControlProvider,
	actions: string[] = ['*'],
): { deps: ApiDeps; audits: AuditRecord[] } {
	const { db } = createHarness()
	const audits: AuditRecord[] = []
	return {
		deps: {
			db,
			iam: authenticator(actions, audits),
			queue: { send: () => Promise.resolve() },
			logs: { get: () => Promise.resolve(null) },
			repoSource: new FakeRepoSource(),
			provider,
			cancelRun: () => Promise.resolve(),
		},
		audits,
	}
}

function request(method: string, path: string, body?: unknown): Request {
	return new Request(`https://control.test/api${path}`, {
		method,
		...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
	})
}

function namespaceBody(id: string, env = 'prod'): {
	id: string
	env: string
	target: ProviderEnvelope
} {
	return { id, env, target: target('requested') }
}

function registrationBody(namespaceId?: string): {
	namespaceId?: string
	target: ProviderEnvelope
	artifact: ProviderEnvelope
} {
	return {
		...(namespaceId === undefined ? {} : { namespaceId }),
		target: target('app'),
		artifact: artifact(),
	}
}

describe('deployment namespace API', () => {
	test('creates, lists, gets, adopts, and reconciles namespaces with audit events', async () => {
		const recording = providerRecording()
		const { deps, audits } = makeDeps(namespacedProvider(recording))

		const created = await handleApi(request('POST', '/namespaces', namespaceBody('apps-prod')), deps)
		expect(created.status).toBe(201)
		const createdBody: { id: string; state: string; target: ProviderEnvelope } = await created.json()
		expect(createdBody).toEqual(expect.objectContaining({ id: 'apps-prod', state: 'ready', target: target('ready') }))
		expect(recording.provisions).toEqual(['apps-prod'])
		expect((await deps.db.listNamespaceResourceClaims('apps-prod')).map((claim) => claim.resource_key)).toEqual(['service:proxy'])

		const listed = await handleApi(request('GET', '/namespaces'), deps)
		const listBody: { items: Array<{ id: string }> } = await listed.json()
		expect(listBody.items.map((item) => item.id)).toEqual(['apps-prod'])
		const got = await handleApi(request('GET', '/namespaces/apps-prod'), deps)
		expect(got.status).toBe(200)

		const adopted = await handleApi(
			request('POST', '/namespaces/legacy/adopt', { env: 'prod', target: target('existing') }),
			deps,
		)
		expect(adopted.status).toBe(201)
		expect(recording.reconciles).toEqual(['legacy'])

		const reconciled = await handleApi(request('POST', '/namespaces/apps-prod/reconcile'), deps)
		expect(reconciled.status).toBe(200)
		expect(recording.reconciles).toEqual(['legacy', 'apps-prod'])
		expect(audits.map((event) => event.action)).toEqual([
			'namespace.create',
			'namespace.adopt',
			'namespace.reconcile',
		])
	})

	test('reserves missing namespace-owned claims before reconciling a legacy namespace', async () => {
		const recording = providerRecording()
		const { deps } = makeDeps(namespacedProvider(recording))
		await deps.db.createDeploymentNamespace({
			id: 'legacy',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('legacy')),
			state: 'ready',
		})

		const reconciled = await handleApi(request('POST', '/namespaces/legacy/reconcile'), deps)

		expect(reconciled.status).toBe(200)
		expect(recording.reconciles).toEqual(['legacy'])
		expect((await deps.db.listNamespaceResourceClaims('legacy')).map((claim) => [
			claim.resource_key,
			claim.owner_app_id,
		])).toEqual([['service:proxy', null]])
	})

	test('preserves the last checkpoint and records a generic failure', async () => {
		const recording = providerRecording()
		recording.failProvision = true
		const { deps, audits } = makeDeps(namespacedProvider(recording))

		const response = await handleApi(request('POST', '/namespaces', namespaceBody('apps-prod')), deps)
		expect(response.status).toBe(502)
		const row = await deps.db.getDeploymentNamespace('apps-prod')
		expect(row?.state).toBe('failed')
		expect(row?.last_error).toBe('namespace provision failed')
		expect(JSON.parse(row?.provider_target_json ?? '{}')).toEqual(target('checkpoint'))
		expect(audits.map((event) => event.action)).toEqual(['namespace.create'])
	})

	test('rejects unsupported providers, duplicate ids, missing exclusive apps, and foreign targets', async () => {
		const recording = providerRecording()
		const provider = namespacedProvider(recording)
		const { deps } = makeDeps(provider)

		expect((await handleApi(request('POST', '/namespaces', namespaceBody('apps-prod')), deps)).status).toBe(201)
		expect((await handleApi(request('POST', '/namespaces', namespaceBody('apps-prod')), deps)).status).toBe(409)
		expect(
			(await handleApi(
				request('POST', '/namespaces', { ...namespaceBody('exclusive'), exclusiveAppId: 'missing' }),
				deps,
			)).status,
		).toBe(404)
		expect(
			(await handleApi(
				request('POST', '/namespaces', {
					...namespaceBody('foreign'),
					target: { provider: 'other', version: 1, payload: {} },
				}),
				deps,
			)).status,
		).toBe(400)

		const withoutNamespaces: ControlProvider = {
			id: 'harbor',
			normalizeRegistration: (input) => input,
			deploy: () => Promise.resolve({ state: 'succeeded' }),
		}
		const unsupported = makeDeps(withoutNamespaces)
		expect((await handleApi(request('POST', '/namespaces', namespaceBody('unsupported')), unsupported.deps)).status).toBe(409)
	})

	test('requires namespace.manage on every namespace route', async () => {
		const recording = providerRecording()
		const denied = makeDeps(namespacedProvider(recording), ['app.manage'])
		expect((await handleApi(request('GET', '/namespaces'), denied.deps)).status).toBe(403)
		expect((await handleApi(request('POST', '/namespaces', namespaceBody('apps-prod')), denied.deps)).status).toBe(403)

		const allowed = makeDeps(namespacedProvider(recording), ['namespace.manage'])
		expect((await handleApi(request('GET', '/namespaces'), allowed.deps)).status).toBe(200)
	})
})

describe('app environment namespace assignment', () => {
	test('assigns compatible shared and exclusive namespaces and passes them to the provider', async () => {
		const recording = providerRecording()
		const { deps, audits } = makeDeps(namespacedProvider(recording))
		await deps.db.createApp({ id: 'billing', repoUrl: 'github.com/acme/billing' })
		await deps.db.createApp({ id: 'other', repoUrl: 'github.com/acme/other' })
		await deps.db.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('namespace')),
			state: 'ready',
		})
		await deps.db.createDeploymentNamespace({
			id: 'billing-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: 'billing',
			providerTargetJson: JSON.stringify(target('exclusive')),
			state: 'ready',
		})

		const shared = await handleApi(
			request('PUT', '/apps/billing/envs/prod', registrationBody('apps-prod')),
			deps,
		)
		expect(shared.status).toBe(200)
		expect((await deps.db.getAppEnv('billing', 'prod'))?.namespace_id).toBe('apps-prod')
		expect(recording.registrations.at(-1)?.environment.namespace?.id).toBe('apps-prod')
		expect(audits.at(-1)).toEqual(expect.objectContaining({
			action: 'app.env.upsert',
			metadata: { triggerRef: null, namespaceId: 'apps-prod', previousNamespaceId: null },
		}))

		const exclusive = await handleApi(
			request('PUT', '/apps/billing/envs/prod', registrationBody('billing-prod')),
			deps,
		)
		expect(exclusive.status).toBe(200)
		expect((await deps.db.getAppEnv('billing', 'prod'))?.namespace_id).toBe('billing-prod')

		const wrongApp = await handleApi(
			request('PUT', '/apps/other/envs/prod', registrationBody('billing-prod')),
			deps,
		)
		expect(wrongApp.status).toBe(409)
	})

	test('rejects missing, unknown, wrong-environment, foreign-provider, and unready assignments', async () => {
		const recording = providerRecording()
		const { deps } = makeDeps(namespacedProvider(recording))
		await deps.db.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await deps.db.createDeploymentNamespace({
			id: 'apps-stage',
			env: 'stage',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('namespace')),
			state: 'ready',
		})
		await deps.db.createDeploymentNamespace({
			id: 'foreign-prod',
			env: 'prod',
			provider: 'other',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify({ provider: 'other', version: 1, payload: {} }),
			state: 'ready',
		})
		await deps.db.createDeploymentNamespace({
			id: 'pending-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('namespace')),
			state: 'pending',
		})

		expect((await handleApi(request('PUT', '/apps/app/envs/prod', registrationBody()), deps)).status).toBe(400)
		expect((await handleApi(request('PUT', '/apps/app/envs/prod', registrationBody('missing')), deps)).status).toBe(404)
		expect((await handleApi(request('PUT', '/apps/app/envs/prod', registrationBody('apps-stage')), deps)).status).toBe(409)
		expect((await handleApi(request('PUT', '/apps/app/envs/prod', registrationBody('foreign-prod')), deps)).status).toBe(409)
		expect((await handleApi(request('PUT', '/apps/app/envs/prod', registrationBody('pending-prod')), deps)).status).toBe(409)
	})

	test('keeps namespace-free providers working and rejects namespace ids they cannot interpret', async () => {
		const provider: ControlProvider = {
			id: 'harbor',
			normalizeRegistration: (input) => input,
			deploy: () => Promise.resolve({ state: 'succeeded' }),
		}
		const { deps } = makeDeps(provider)
		await deps.db.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		expect((await handleApi(request('PUT', '/apps/app/envs/prod', registrationBody()), deps)).status).toBe(200)
		expect((await handleApi(request('PUT', '/apps/app/envs/stage', registrationBody('unsupported')), deps)).status).toBe(409)
	})

	test('allows placement changes only before the first successful deploy', async () => {
		const recording = providerRecording()
		const { deps } = makeDeps(namespacedProvider(recording))
		await deps.db.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		for (const id of ['first', 'second']) {
			await deps.db.createDeploymentNamespace({
				id,
				env: 'prod',
				provider: 'harbor',
				exclusiveAppId: null,
				providerTargetJson: JSON.stringify(target(id)),
				state: 'ready',
			})
		}
		expect((await handleApi(request('PUT', '/apps/app/envs/prod', registrationBody('first')), deps)).status).toBe(200)
		expect((await handleApi(request('PUT', '/apps/app/envs/prod', registrationBody('second')), deps)).status).toBe(200)
		expect((await deps.db.listNamespaceResourceClaims('first')).map((claim) => claim.resource_key)).toEqual(['service:app'])
		expect((await deps.db.listNamespaceResourceClaims('second')).map((claim) => claim.resource_key)).toEqual(['service:app'])

		await deps.db.createRun({ id: 'successful-run', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		await deps.db.markRunFinished('successful-run', 'succeeded', 0)
		expect((await handleApi(request('PUT', '/apps/app/envs/prod', registrationBody('first')), deps)).status).toBe(409)
		expect((await handleApi(request('PUT', '/apps/app/envs/prod', registrationBody('second')), deps)).status).toBe(200)
	})

	test('onboards directly into a shared namespace and leaves no app after invalid assignment', async () => {
		const recording = providerRecording()
		const { deps } = makeDeps(namespacedProvider(recording))
		await deps.db.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('namespace')),
			state: 'ready',
		})
		const onboard = await handleApi(
			request('POST', '/register-app', {
				id: 'billing',
				repoUrl: 'github.com/acme/billing',
				env: 'prod',
				namespaceId: 'apps-prod',
				...registrationBody(),
			}),
			deps,
		)
		expect(onboard.status).toBe(201)
		expect((await deps.db.getAppEnv('billing', 'prod'))?.namespace_id).toBe('apps-prod')

		const invalid = await handleApi(
			request('POST', '/register-app', {
				id: 'broken',
				repoUrl: 'github.com/acme/broken',
				env: 'prod',
				namespaceId: 'missing',
				...registrationBody(),
			}),
			deps,
		)
		expect(invalid.status).toBe(404)
		expect(await deps.db.getApp('broken')).toBeNull()
	})

	test('claim collision leaves no orphan onboarding app', async () => {
		const recording = providerRecording()
		const provider = namespacedProvider(recording)
		if (provider.namespaces === undefined) {
			throw new Error('expected namespace capabilities')
		}
		const collidingProvider: ControlProvider = {
			...provider,
			namespaces: {
				...provider.namespaces,
				registrationResourceClaims: () => ['service:shared'],
			},
		}
		const { deps } = makeDeps(collidingProvider)
		await deps.db.createDeploymentNamespaceWithResourceClaims({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('namespace')),
			state: 'ready',
		}, ['service:proxy'])
		const body = (id: string): unknown => ({
			id,
			repoUrl: `github.com/acme/${id}`,
			env: 'prod',
			namespaceId: 'apps-prod',
			...registrationBody(),
		})

		const alpha = await handleApi(request('POST', '/register-app', body('alpha')), deps)
		const beta = await handleApi(request('POST', '/register-app', body('beta')), deps)

		expect([alpha.status, beta.status].sort()).toEqual([201, 409])
		const winner = (await deps.db.listAppEnvsByNamespace('apps-prod'))[0]?.app_id
		expect(winner === 'alpha' || winner === 'beta').toBe(true)
		const loser = winner === 'alpha' ? 'beta' : 'alpha'
		expect(await deps.db.getApp(loser)).toBeNull()
	})
})
