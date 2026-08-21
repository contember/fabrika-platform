import type { AuthContext } from '@fabrika/auth'
import type { ControlProvider, ProviderDeploymentNamespace, ProviderEnvelope, ProviderRegistrationInput } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { type NamespaceJobResult, runNamespaceJob } from '../api/namespaces'
import type { ApiDeps } from '../api/router'
import { handleApi } from '../api/router'
import { FakeRepoSource } from '../repo-source'
import type { ControlJobMessage } from '../run-lifecycle'
import { createHarness } from './helpers/harness'
import { makeFakeLock } from './helpers/lock'

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
			operator: {
				presets: [{
					id: 'shared',
					label: 'Shared',
					description: 'Shared test namespace.',
					requiresExclusiveApp: false,
				}],
				plan(input) {
					const namespace: ProviderDeploymentNamespace = {
						id: input.id,
						env: input.env,
						...(input.exclusiveAppId === undefined ? {} : { exclusiveAppId: input.exclusiveAppId }),
						target: target(`planned-${input.preset}`),
					}
					return {
						namespace,
						presentation: {
							preset: input.preset,
							title: 'Planned namespace',
							facts: [{ label: 'Environment', value: input.env }],
							instructions: ['Review the plan.'],
						},
					}
				},
				present(namespace) {
					return {
						preset: namespace.exclusiveAppId === undefined ? 'shared' : 'exclusive',
						title: 'Test namespace',
						facts: [{ label: 'Environment', value: namespace.env }],
						instructions: [],
					}
				},
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

function authContext(actions: string[], audits: AuditRecord[]): AuthContext {
	return {
		ok: true,
		principal: { id: 'operator', type: 'user', label: 'operator@test' },
		can: (action) => actions.includes('*') || actions.includes(action),
		scopedTo: () => null,
		audit: (event) => {
			audits.push(event)
			return Promise.resolve()
		},
	}
}

interface NamespaceHarness {
	deps: ApiDeps
	audits: AuditRecord[]
	/** Everything the request path enqueued, in order. */
	sent: ControlJobMessage[]
	/** Run every enqueued namespace job exactly as a consumer would, and forget the messages. */
	drain(): Promise<NamespaceJobResult[]>
}

function makeDeps(
	provider: ControlProvider,
	actions: string[] = ['*'],
): NamespaceHarness {
	const { db } = createHarness()
	const audits: AuditRecord[] = []
	const sent: ControlJobMessage[] = []
	const lock = makeFakeLock()
	return {
		deps: {
			repositories: db,
			auth: authContext(actions, audits),
			queue: {
				send(message) {
					sent.push(message)
					return Promise.resolve()
				},
			},
			logs: { get: () => Promise.resolve(null) },
			repoSource: new FakeRepoSource(),
			provider,
			cancelRun: () => Promise.resolve(),
		},
		audits,
		sent,
		async drain(): Promise<NamespaceJobResult[]> {
			const results: NamespaceJobResult[] = []
			for (const message of sent.splice(0)) {
				if (message.kind !== 'namespace') continue
				results.push(await runNamespaceJob({ repositories: db, provider, lock }, message))
			}
			return results
		},
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
	test('publishes provider presets and plans without persistence or provider mutation', async () => {
		const recording = providerRecording()
		const { deps } = makeDeps(namespacedProvider(recording))

		const listed = await handleApi(request('GET', '/namespaces'), deps)
		const listBody: { operator: { presets: Array<{ id: string }> } } = await listed.json()
		expect(listBody.operator.presets.map((preset) => preset.id)).toEqual(['shared'])

		const planned = await handleApi(
			request('POST', '/namespaces/plan', { id: 'apps-prod', env: 'prod', preset: 'shared' }),
			deps,
		)
		expect(planned.status).toBe(200)
		const planBody: {
			namespace: { id: string; env: string; target: ProviderEnvelope }
			presentation: { preset: string; facts: Array<{ label: string; value: string }> }
		} = await planned.json()
		expect(planBody.namespace).toEqual({
			id: 'apps-prod',
			env: 'prod',
			target: target('planned-shared'),
		})
		expect(planBody.presentation).toMatchObject({
			preset: 'shared',
			facts: [{ label: 'Environment', value: 'prod' }],
		})
		expect(await deps.repositories.registry.getDeploymentNamespace('apps-prod')).toBeNull()
		expect(recording.provisions).toEqual([])
	})

	test('creates, lists, gets, adopts, and reconciles namespaces with audit events', async () => {
		const recording = providerRecording()
		const { deps, audits, sent, drain } = makeDeps(namespacedProvider(recording))

		const created = await handleApi(request('POST', '/namespaces', namespaceBody('apps-prod')), deps)
		expect(created.status).toBe(201)
		const createdBody: { id: string; state: string; target: ProviderEnvelope } = await created.json()
		// The request records the placement and returns; the provider is not touched inside it.
		expect(createdBody).toEqual(expect.objectContaining({ id: 'apps-prod', state: 'pending', target: target('requested') }))
		expect(recording.provisions).toEqual([])
		expect(sent).toEqual([{ kind: 'namespace', namespaceId: 'apps-prod', mutation: 'provision' }])
		expect(audits.at(-1)).toEqual(expect.objectContaining({ action: 'namespace.create', metadata: expect.objectContaining({ state: 'pending' }) }))
		expect((await deps.repositories.registry.listNamespaceResourceClaims('apps-prod')).map((claim) => claim.resource_key)).toEqual(['service:proxy'])
		expect(await drain()).toEqual([{ namespaceId: 'apps-prod', status: 'ready' }])
		expect(recording.provisions).toEqual(['apps-prod'])
		expect((await deps.repositories.registry.getDeploymentNamespace('apps-prod'))?.state).toBe('ready')

		const listed = await handleApi(request('GET', '/namespaces'), deps)
		const listBody: { items: Array<{ id: string }>; operator: { presets: Array<{ id: string }> } } = await listed.json()
		expect(listBody.items.map((item) => item.id)).toEqual(['apps-prod'])
		expect(listBody.operator.presets.map((preset) => preset.id)).toEqual(['shared'])
		const got = await handleApi(request('GET', '/namespaces/apps-prod'), deps)
		expect(got.status).toBe(200)
		const gotBody: { presentation: { title: string } } = await got.json()
		expect(gotBody.presentation.title).toBe('Test namespace')

		const adopted = await handleApi(
			request('POST', '/namespaces/legacy/adopt', { env: 'prod', target: target('existing') }),
			deps,
		)
		expect(adopted.status).toBe(201)
		expect(recording.reconciles).toEqual([])
		expect(await drain()).toEqual([{ namespaceId: 'legacy', status: 'ready' }])
		expect(recording.reconciles).toEqual(['legacy'])

		const reconciled = await handleApi(request('POST', '/namespaces/apps-prod/reconcile'), deps)
		expect(reconciled.status).toBe(200)
		const reconciledBody: { state: string } = await reconciled.json()
		// A reconcile of a READY namespace goes back to `pending` so the worker's claim still means something.
		expect(reconciledBody.state).toBe('pending')
		expect(await drain()).toEqual([{ namespaceId: 'apps-prod', status: 'ready' }])
		expect(recording.reconciles).toEqual(['legacy', 'apps-prod'])
		expect(audits.map((event) => event.action)).toEqual([
			'namespace.create',
			'namespace.adopt',
			'namespace.reconcile',
		])
	})

	test('reserves missing namespace-owned claims before reconciling a legacy namespace', async () => {
		const recording = providerRecording()
		const { deps, drain } = makeDeps(namespacedProvider(recording))
		await deps.repositories.registry.createDeploymentNamespace({
			id: 'legacy',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('legacy')),
			state: 'ready',
		})

		const reconciled = await handleApi(request('POST', '/namespaces/legacy/reconcile'), deps)

		expect(reconciled.status).toBe(200)
		// Claims are reserved in the REQUEST, before the job the request enqueued has run.
		expect(recording.reconciles).toEqual([])
		expect((await deps.repositories.registry.listNamespaceResourceClaims('legacy')).map((claim) => [
			claim.resource_key,
			claim.owner_app_id,
		])).toEqual([['service:proxy', null]])
		expect(await drain()).toEqual([{ namespaceId: 'legacy', status: 'ready' }])
		expect(recording.reconciles).toEqual(['legacy'])
	})

	test('preserves the last checkpoint and records a generic failure', async () => {
		const recording = providerRecording()
		recording.failProvision = true
		const { deps, audits, drain } = makeDeps(namespacedProvider(recording))

		const response = await handleApi(request('POST', '/namespaces', namespaceBody('apps-prod')), deps)
		// The caller is answered before the provider is asked, so a refusal is the JOB's outcome, not the
		// request's — and it is a handled one, which is why the job returns rather than throwing.
		expect(response.status).toBe(201)
		expect(await drain()).toEqual([{ namespaceId: 'apps-prod', status: 'failed' }])
		const row = await deps.repositories.registry.getDeploymentNamespace('apps-prod')
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
		expect(
			(await handleApi(
				request('POST', '/namespaces/plan', { id: 'unsupported', env: 'prod', preset: 'shared' }),
				unsupported.deps,
			)).status,
		).toBe(409)
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
		await deps.repositories.registry.createApp({ id: 'billing', repoUrl: 'github.com/acme/billing' })
		await deps.repositories.registry.createApp({ id: 'other', repoUrl: 'github.com/acme/other' })
		await deps.repositories.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('namespace')),
			state: 'ready',
		})
		await deps.repositories.registry.createDeploymentNamespace({
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
		expect((await deps.repositories.registry.getAppEnv('billing', 'prod'))?.namespace_id).toBe('apps-prod')
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
		expect((await deps.repositories.registry.getAppEnv('billing', 'prod'))?.namespace_id).toBe('billing-prod')

		const wrongApp = await handleApi(
			request('PUT', '/apps/other/envs/prod', registrationBody('billing-prod')),
			deps,
		)
		expect(wrongApp.status).toBe(409)
	})

	test('rejects missing, unknown, wrong-environment, foreign-provider, and unready assignments', async () => {
		const recording = providerRecording()
		const { deps } = makeDeps(namespacedProvider(recording))
		await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await deps.repositories.registry.createDeploymentNamespace({
			id: 'apps-stage',
			env: 'stage',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('namespace')),
			state: 'ready',
		})
		await deps.repositories.registry.createDeploymentNamespace({
			id: 'foreign-prod',
			env: 'prod',
			provider: 'other',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify({ provider: 'other', version: 1, payload: {} }),
			state: 'ready',
		})
		await deps.repositories.registry.createDeploymentNamespace({
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
		await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		expect((await handleApi(request('PUT', '/apps/app/envs/prod', registrationBody()), deps)).status).toBe(200)
		expect((await handleApi(request('PUT', '/apps/app/envs/stage', registrationBody('unsupported')), deps)).status).toBe(409)
	})

	test('allows placement changes only without in-flight or successful deploys', async () => {
		const recording = providerRecording()
		const { deps } = makeDeps(namespacedProvider(recording))
		await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		for (const id of ['first', 'second']) {
			await deps.repositories.registry.createDeploymentNamespace({
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
		expect((await deps.repositories.registry.listNamespaceResourceClaims('first')).map((claim) => claim.resource_key)).toEqual(['service:app'])
		expect((await deps.repositories.registry.listNamespaceResourceClaims('second')).map((claim) => claim.resource_key)).toEqual(['service:app'])

		await deps.repositories.runs.createRun({ id: 'pending-run', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		expect((await handleApi(request('PUT', '/apps/app/envs/prod', registrationBody('first')), deps)).status).toBe(409)
		await deps.repositories.runs.markRunFinished('pending-run', 'failed', null)
		expect((await handleApi(request('PUT', '/apps/app/envs/prod', registrationBody('first')), deps)).status).toBe(200)

		await deps.repositories.runs.createRun({ id: 'successful-run', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		await deps.repositories.runs.markRunFinished('successful-run', 'succeeded', 0)
		expect((await handleApi(request('PUT', '/apps/app/envs/prod', registrationBody('second')), deps)).status).toBe(409)
		expect((await handleApi(request('PUT', '/apps/app/envs/prod', registrationBody('first')), deps)).status).toBe(200)
	})

	test('onboards directly into a shared namespace and leaves no app after invalid assignment', async () => {
		const recording = providerRecording()
		const { deps } = makeDeps(namespacedProvider(recording))
		await deps.repositories.registry.createDeploymentNamespace({
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
		expect((await deps.repositories.registry.getAppEnv('billing', 'prod'))?.namespace_id).toBe('apps-prod')

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
		expect(await deps.repositories.registry.getApp('broken')).toBeNull()
	})

	test('claims service names before provider preparation and persists discovered coordinates', async () => {
		const recording = providerRecording()
		const base = namespacedProvider(recording)
		if (base.namespaces === undefined) {
			throw new Error('expected namespace capabilities')
		}
		let inspectClaims: (() => Promise<void>) | undefined
		let claimsPresentDuringPreparation = false
		const provider: ControlProvider = {
			...base,
			namespaces: {
				...base.namespaces,
				async prepareRegistration(input) {
					await inspectClaims?.()
					return {
						app: input.registration.app,
						environment: {
							...input.registration.environment,
							target: target('discovered'),
						},
					}
				},
			},
		}
		const { deps } = makeDeps(provider)
		inspectClaims = async () => {
			const claims = await deps.repositories.registry.listNamespaceResourceClaims('apps-prod')
			claimsPresentDuringPreparation = claims.some((claim) =>
				claim.resource_key === 'service:billing'
				&& claim.owner_app_id === 'billing'
				&& claim.owner_env === 'prod'
			)
		}
		await deps.repositories.registry.createDeploymentNamespaceWithResourceClaims({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('namespace')),
			state: 'ready',
		}, ['service:proxy'])

		const response = await handleApi(
			request('POST', '/register-app', {
				id: 'billing',
				repoUrl: 'github.com/acme/billing',
				env: 'prod',
				namespaceId: 'apps-prod',
				...registrationBody(),
			}),
			deps,
		)

		expect(response.status).toBe(201)
		expect(claimsPresentDuringPreparation).toBe(true)
		expect((await deps.repositories.registry.getAppEnv('billing', 'prod'))?.provider_target_json).toBe(JSON.stringify(target('discovered')))
	})

	test('an environment update goes through the same provider preparation the registration did', async () => {
		// `apps.environments.put` used to normalise the caller's envelope directly, so a provider that
		// OWNS its target — every namespaced one — could never take a changed manifest through it.
		const recording = providerRecording()
		const base = namespacedProvider(recording)
		if (base.namespaces === undefined) {
			throw new Error('expected namespace capabilities')
		}
		let prepared = 0
		const provider: ControlProvider = {
			...base,
			namespaces: {
				...base.namespaces,
				prepareRegistration: (input) => {
					prepared += 1
					return Promise.resolve({
						app: input.registration.app,
						environment: { ...input.registration.environment, target: target(`discovered-${prepared}`) },
					})
				},
			},
		}
		const { deps } = makeDeps(provider)
		await deps.repositories.registry.createDeploymentNamespaceWithResourceClaims({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('namespace')),
			state: 'ready',
		}, ['service:proxy'])
		const registered = await handleApi(
			request('POST', '/register-app', {
				id: 'billing',
				repoUrl: 'github.com/acme/billing',
				env: 'prod',
				namespaceId: 'apps-prod',
				...registrationBody(),
			}),
			deps,
		)
		expect(registered.status).toBe(201)

		const updated = await handleApi(
			request('PUT', '/apps/billing/envs/prod', { namespaceId: 'apps-prod', ...registrationBody() }),
			deps,
		)

		expect(updated.status).toBe(200)
		expect(prepared).toBe(2)
		expect((await deps.repositories.registry.getAppEnv('billing', 'prod'))?.provider_target_json).toBe(JSON.stringify(target('discovered-2')))
	})

	test('removes the provisional app and claims when provider preparation fails', async () => {
		const recording = providerRecording()
		const base = namespacedProvider(recording)
		if (base.namespaces === undefined) {
			throw new Error('expected namespace capabilities')
		}
		const provider: ControlProvider = {
			...base,
			namespaces: {
				...base.namespaces,
				prepareRegistration: () => Promise.reject(new Error('provider detail must not escape')),
			},
		}
		const { deps } = makeDeps(provider)
		await deps.repositories.registry.createDeploymentNamespaceWithResourceClaims({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('namespace')),
			state: 'ready',
		}, ['service:proxy'])

		const response = await handleApi(
			request('POST', '/register-app', {
				id: 'broken',
				repoUrl: 'github.com/acme/broken',
				env: 'prod',
				namespaceId: 'apps-prod',
				...registrationBody(),
			}),
			deps,
		)

		expect(response.status).toBe(502)
		const failure: { error: string } = await response.json()
		expect(failure).toEqual({ error: 'provider registration preparation failed' })
		expect(await deps.repositories.registry.getApp('broken')).toBeNull()
		expect((await deps.repositories.registry.listNamespaceResourceClaims('apps-prod')).map((claim) => claim.resource_key)).toEqual(['service:proxy'])
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
		await deps.repositories.registry.createDeploymentNamespaceWithResourceClaims({
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
		const winner = (await deps.repositories.registry.listAppEnvsByNamespace('apps-prod'))[0]?.app_id
		expect(winner === 'alpha' || winner === 'beta').toBe(true)
		const loser = winner === 'alpha' ? 'beta' : 'alpha'
		expect(await deps.repositories.registry.getApp(loser)).toBeNull()
	})
})
