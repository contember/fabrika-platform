import { ConflictError } from '@fabrika/app'
import type { AuthContext } from '@fabrika/auth'
import { FABRIKA_PROXY_SECRET } from '@fabrika/auth-core'
import type {
	ControlProvider,
	ProviderDeploymentNamespace,
	ProviderEnvelope,
	ProviderNamespaceRepublishInput,
	ProviderRegistrationInput,
} from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import {
	enqueueUnsettledNamespaces,
	type NamespaceJobResult,
	type NamespaceUseCaseContext,
	reconcileNamespaceUseCase,
	republishNamespace,
	runNamespaceJob,
} from '../api/namespaces'
import { acquireLease, namespaceLeaseKey } from '../lease'
import { proxySecretPurpose, VaultProxySecrets } from '../proxy-secret'
import { type ControlJobMessage, executeDeploy } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import type { ControlRpcDeps } from '../services'
import { Vault } from '../vault'
import { createHarness, harnessDatabase } from './helpers/harness'
import { fixtureNamespaceWrite, fixtureRuns, heldLeases, makeFakeLock } from './helpers/lock'
import { rpcRequest, rpcResult } from './helpers/rpc'

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
	deps: ControlRpcDeps
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
	const lock = makeFakeLock(db)
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

		const listed = await rpcResult(rpcRequest('namespaces.list'), deps)
		const listBody: { operator: { presets: Array<{ id: string }> } } = await listed.json()
		expect(listBody.operator.presets.map((preset) => preset.id)).toEqual(['shared'])

		const planned = await rpcResult(
			rpcRequest('namespaces.plan', { id: 'apps-prod', env: 'prod', preset: 'shared' }),
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

		const created = await rpcResult(rpcRequest('namespaces.create', namespaceBody('apps-prod')), deps)
		expect(created.status).toBe(200)
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

		const listed = await rpcResult(rpcRequest('namespaces.list'), deps)
		const listBody: { items: Array<{ id: string }>; operator: { presets: Array<{ id: string }> } } = await listed.json()
		expect(listBody.items.map((item) => item.id)).toEqual(['apps-prod'])
		expect(listBody.operator.presets.map((preset) => preset.id)).toEqual(['shared'])
		const got = await rpcResult(rpcRequest('namespaces.get', { namespaceId: 'apps-prod' }), deps)
		expect(got.status).toBe(200)
		const gotBody: { presentation: { title: string } } = await got.json()
		expect(gotBody.presentation.title).toBe('Test namespace')

		const adopted = await rpcResult(
			rpcRequest('namespaces.adopt', { namespaceId: 'legacy', namespace: { env: 'prod', target: target('existing') } }),
			deps,
		)
		expect(adopted.status).toBe(200)
		expect(recording.reconciles).toEqual([])
		expect(await drain()).toEqual([{ namespaceId: 'legacy', status: 'ready' }])
		expect(recording.reconciles).toEqual(['legacy'])

		const reconciled = await rpcResult(rpcRequest('namespaces.reconcile', { namespaceId: 'apps-prod' }), deps)
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

		const reconciled = await rpcResult(rpcRequest('namespaces.reconcile', { namespaceId: 'legacy' }), deps)

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

		const response = await rpcResult(rpcRequest('namespaces.create', namespaceBody('apps-prod')), deps)
		// The caller is answered before the provider is asked, so a refusal is the JOB's outcome, not the
		// request's — and it is a handled one, which is why the job returns rather than throwing.
		expect(response.status).toBe(200)
		expect(await drain()).toEqual([{ namespaceId: 'apps-prod', status: 'failed' }])
		const row = await deps.repositories.registry.getDeploymentNamespace('apps-prod')
		expect(row?.state).toBe('failed')
		// An untyped provider throw has no class to record: the row gets `internal` and a generic message,
		// and what the cause actually said reaches the LOG instead of the row.
		expect(row?.last_error).toBe('internal: namespace provision failed')
		expect(JSON.parse(row?.provider_target_json ?? '{}')).toEqual(target('checkpoint'))
		expect(audits.map((event) => event.action)).toEqual(['namespace.create'])
	})

	test('rejects unsupported providers, duplicate ids, missing exclusive apps, and foreign targets', async () => {
		const recording = providerRecording()
		const provider = namespacedProvider(recording)
		const { deps } = makeDeps(provider)

		expect((await rpcResult(rpcRequest('namespaces.create', namespaceBody('apps-prod')), deps)).status).toBe(200)
		expect((await rpcResult(rpcRequest('namespaces.create', namespaceBody('apps-prod')), deps)).status).toBe(409)
		expect(
			(await rpcResult(
				rpcRequest('namespaces.create', { ...namespaceBody('exclusive'), exclusiveAppId: 'missing' }),
				deps,
			)).status,
		).toBe(404)
		expect(
			(await rpcResult(
				rpcRequest('namespaces.create', {
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
		expect((await rpcResult(rpcRequest('namespaces.create', namespaceBody('unsupported')), unsupported.deps)).status).toBe(409)
		expect(
			(await rpcResult(
				rpcRequest('namespaces.plan', { id: 'unsupported', env: 'prod', preset: 'shared' }),
				unsupported.deps,
			)).status,
		).toBe(409)
	})

	test('requires namespace.manage on every namespace route', async () => {
		const recording = providerRecording()
		const denied = makeDeps(namespacedProvider(recording), ['app.manage'])
		expect((await rpcResult(rpcRequest('namespaces.list'), denied.deps)).status).toBe(403)
		expect((await rpcResult(rpcRequest('namespaces.create', namespaceBody('apps-prod')), denied.deps)).status).toBe(403)

		const allowed = makeDeps(namespacedProvider(recording), ['namespace.manage'])
		expect((await rpcResult(rpcRequest('namespaces.list'), allowed.deps)).status).toBe(200)
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

		const shared = await rpcResult(
			rpcRequest('apps.environments.put', { appId: 'billing', env: 'prod', environment: registrationBody('apps-prod') }),
			deps,
		)
		expect(shared.status).toBe(200)
		expect((await deps.repositories.registry.getAppEnv('billing', 'prod'))?.namespace_id).toBe('apps-prod')
		expect(recording.registrations.at(-1)?.environment.namespace?.id).toBe('apps-prod')
		expect(audits.at(-1)).toEqual(expect.objectContaining({
			action: 'app.env.upsert',
			metadata: { triggerRef: null, namespaceId: 'apps-prod', previousNamespaceId: null },
		}))

		const exclusive = await rpcResult(
			rpcRequest('apps.environments.put', { appId: 'billing', env: 'prod', environment: registrationBody('billing-prod') }),
			deps,
		)
		expect(exclusive.status).toBe(200)
		expect((await deps.repositories.registry.getAppEnv('billing', 'prod'))?.namespace_id).toBe('billing-prod')

		const wrongApp = await rpcResult(
			rpcRequest('apps.environments.put', { appId: 'other', env: 'prod', environment: registrationBody('billing-prod') }),
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

		expect((await rpcResult(rpcRequest('apps.environments.put', { appId: 'app', env: 'prod', environment: registrationBody() }), deps)).status).toBe(
			400,
		)
		expect((await rpcResult(rpcRequest('apps.environments.put', { appId: 'app', env: 'prod', environment: registrationBody('missing') }), deps)).status)
			.toBe(404)
		expect(
			(await rpcResult(rpcRequest('apps.environments.put', { appId: 'app', env: 'prod', environment: registrationBody('apps-stage') }), deps)).status,
		).toBe(409)
		expect(
			(await rpcResult(rpcRequest('apps.environments.put', { appId: 'app', env: 'prod', environment: registrationBody('foreign-prod') }), deps)).status,
		).toBe(409)
		expect(
			(await rpcResult(rpcRequest('apps.environments.put', { appId: 'app', env: 'prod', environment: registrationBody('pending-prod') }), deps)).status,
		).toBe(409)
	})

	test('keeps namespace-free providers working and rejects namespace ids they cannot interpret', async () => {
		const provider: ControlProvider = {
			id: 'harbor',
			normalizeRegistration: (input) => input,
			deploy: () => Promise.resolve({ state: 'succeeded' }),
		}
		const { deps } = makeDeps(provider)
		await deps.repositories.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		expect((await rpcResult(rpcRequest('apps.environments.put', { appId: 'app', env: 'prod', environment: registrationBody() }), deps)).status).toBe(
			200,
		)
		expect(
			(await rpcResult(rpcRequest('apps.environments.put', { appId: 'app', env: 'stage', environment: registrationBody('unsupported') }), deps)).status,
		).toBe(409)
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
		expect((await rpcResult(rpcRequest('apps.environments.put', { appId: 'app', env: 'prod', environment: registrationBody('first') }), deps)).status)
			.toBe(200)
		expect((await rpcResult(rpcRequest('apps.environments.put', { appId: 'app', env: 'prod', environment: registrationBody('second') }), deps)).status)
			.toBe(200)
		expect((await deps.repositories.registry.listNamespaceResourceClaims('first')).map((claim) => claim.resource_key)).toEqual(['service:app'])
		expect((await deps.repositories.registry.listNamespaceResourceClaims('second')).map((claim) => claim.resource_key)).toEqual(['service:app'])

		await deps.repositories.runs.createRun({ id: 'pending-run', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		expect((await rpcResult(rpcRequest('apps.environments.put', { appId: 'app', env: 'prod', environment: registrationBody('first') }), deps)).status)
			.toBe(409)
		await fixtureRuns(deps.repositories.runs, makeFakeLock(deps.repositories)).finish('pending-run', 'failed')
		expect((await rpcResult(rpcRequest('apps.environments.put', { appId: 'app', env: 'prod', environment: registrationBody('first') }), deps)).status)
			.toBe(200)

		await deps.repositories.runs.createRun({ id: 'successful-run', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		await fixtureRuns(deps.repositories.runs, makeFakeLock(deps.repositories)).finish('successful-run', 'succeeded', 0)
		expect((await rpcResult(rpcRequest('apps.environments.put', { appId: 'app', env: 'prod', environment: registrationBody('second') }), deps)).status)
			.toBe(409)
		expect((await rpcResult(rpcRequest('apps.environments.put', { appId: 'app', env: 'prod', environment: registrationBody('first') }), deps)).status)
			.toBe(200)
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
		const onboard = await rpcResult(
			rpcRequest('register', {
				id: 'billing',
				repoUrl: 'github.com/acme/billing',
				env: 'prod',
				namespaceId: 'apps-prod',
				...registrationBody(),
			}),
			deps,
		)
		expect(onboard.status).toBe(200)
		expect((await deps.repositories.registry.getAppEnv('billing', 'prod'))?.namespace_id).toBe('apps-prod')

		const invalid = await rpcResult(
			rpcRequest('register', {
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

		const response = await rpcResult(
			rpcRequest('register', {
				id: 'billing',
				repoUrl: 'github.com/acme/billing',
				env: 'prod',
				namespaceId: 'apps-prod',
				...registrationBody(),
			}),
			deps,
		)

		expect(response.status).toBe(200)
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
		const registered = await rpcResult(
			rpcRequest('register', {
				id: 'billing',
				repoUrl: 'github.com/acme/billing',
				env: 'prod',
				namespaceId: 'apps-prod',
				...registrationBody(),
			}),
			deps,
		)
		expect(registered.status).toBe(200)

		const updated = await rpcResult(
			rpcRequest('apps.environments.put', { appId: 'billing', env: 'prod', environment: { namespaceId: 'apps-prod', ...registrationBody() } }),
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

		const response = await rpcResult(
			rpcRequest('register', {
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

		const alpha = await rpcResult(rpcRequest('register', body('alpha')), deps)
		const beta = await rpcResult(rpcRequest('register', body('beta')), deps)

		expect([alpha.status, beta.status].sort()).toEqual([200, 409])
		const winner = (await deps.repositories.registry.listAppEnvsByNamespace('apps-prod'))[0]?.app_id
		expect(winner === 'alpha' || winner === 'beta').toBe(true)
		const loser = winner === 'alpha' ? 'beta' : 'alpha'
		expect(await deps.repositories.registry.getApp(loser)).toBeNull()
	})
})

describe('reconcile is the operator’s repair verb for a stale proxy manifest', () => {
	function context(harness: NamespaceHarness, synced: string[], fail = false): NamespaceUseCaseContext {
		return {
			repositories: harness.deps.repositories,
			provider: harness.deps.provider,
			auth: harness.deps.auth,
			signal: new AbortController().signal,
			queue: harness.deps.queue,
			namespaceProxyChanged: (namespaceId) => {
				synced.push(namespaceId)
				return fail ? Promise.reject(new Error('platform said no')) : Promise.resolve()
			},
		}
	}

	async function readyNamespace(harness: NamespaceHarness, state: 'ready' | 'failed'): Promise<void> {
		await harness.deps.repositories.registry.createDeploymentNamespaceWithResourceClaims({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('ready')),
			state,
		}, ['service:proxy'])
	}

	test('republishes a ready namespace before requeueing it, and still enqueues the provider reconcile', async () => {
		const harness = makeDeps(namespacedProvider(providerRecording()))
		await readyNamespace(harness, 'ready')
		const synced: string[] = []

		const reconciled = await reconcileNamespaceUseCase(context(harness, synced), 'apps-prod')

		expect(synced).toEqual(['apps-prod'])
		expect(reconciled.state).toBe('pending')
		expect(harness.sent).toEqual([{ kind: 'namespace', namespaceId: 'apps-prod', mutation: 'reconcile' }])
	})

	test('a namespace that never became ready has no manifest to republish', async () => {
		const harness = makeDeps(namespacedProvider(providerRecording()))
		await readyNamespace(harness, 'failed')
		const synced: string[] = []

		await reconcileNamespaceUseCase(context(harness, synced), 'apps-prod')

		expect(synced).toEqual([])
	})

	test('a failed republish is reported, but the provider reconcile is still queued', async () => {
		// The one verb an operator has for a stale manifest must not stop working because the proxy is the
		// thing that is unreachable — the reported 502 says the republish has to be retried, not that
		// nothing happened.
		const harness = makeDeps(namespacedProvider(providerRecording()))
		await readyNamespace(harness, 'ready')
		const synced: string[] = []

		await expect(reconcileNamespaceUseCase(context(harness, synced, true), 'apps-prod')).rejects.toMatchObject({ httpStatus: 502 })
		expect(synced).toEqual(['apps-prod'])
		expect(harness.sent).toEqual([{ kind: 'namespace', namespaceId: 'apps-prod', mutation: 'reconcile' }])
		expect(harness.audits.map((audit) => audit.action)).toContain('namespace.reconcile')
		expect((await harness.deps.repositories.registry.getDeploymentNamespace('apps-prod'))?.state).toBe('pending')
	})
})

describe('a namespace republish rebuilds the entry point from the registry under the namespace lease', () => {
	interface Republishing {
		calls: Array<{ wait: ProviderNamespaceRepublishInput['wait']; members: string[] }>
		/** Held open to keep a republish in flight while the test looks at the world around it. */
		gate: Promise<void> | null
		entered: () => void
		fail: boolean
		/** A `started` rebuild that finds nothing left in flight. */
		settledWhenStarted: boolean
		deploys: string[]
		/** The proxy secret each republish handed each member, and the one each deploy handed its application. */
		memberSecrets: (string | undefined)[][]
		deploySecrets: (string | null | undefined)[]
		/** Held open inside source resolution, while the deploy holds the namespace lease but has not republished. */
		resolving: Promise<void> | null
	}

	function republishingProvider(record: Republishing): ControlProvider {
		const provider = namespacedProvider(providerRecording())
		const namespaces = provider.namespaces
		if (namespaces === undefined) throw new Error('test provider must support namespaces')
		return {
			...provider,
			async resolveSource() {
				if (record.resolving !== null) await record.resolving
				return { commitSha: 'a'.repeat(40) }
			},
			async deploy(input) {
				record.deploys.push(input.runId)
				record.deploySecrets.push(input.managedEnvironment[FABRIKA_PROXY_SECRET])
				return { state: 'succeeded' }
			},
			namespaces: {
				...namespaces,
				async republish(input) {
					record.calls.push({ wait: input.wait, members: input.members.map((member) => `${member.appId}/${member.env}@${member.domain ?? '-'}`) })
					record.memberSecrets.push(input.members.map((member) => member.proxySecret))
					record.entered()
					const checkpoint = withTarget(input.namespace, target('rebuilding'))
					await input.events.checkpoint(checkpoint)
					if (record.gate !== null) await record.gate
					await input.events.boundary()
					if (record.fail) throw new Error('platform said no')
					return { namespace: withTarget(checkpoint, target('rebuilt')), settled: input.wait === 'active' || record.settledWhenStarted }
				},
			},
		}
	}

	function republishing(): Republishing {
		return {
			calls: [],
			gate: null,
			entered: () => {},
			fail: false,
			settledWhenStarted: false,
			deploys: [],
			memberSecrets: [],
			deploySecrets: [],
			resolving: null,
		}
	}

	async function seed(harness: NamespaceHarness, apps: string[] = ['alpha']): Promise<void> {
		await harness.deps.repositories.registry.createDeploymentNamespaceWithResourceClaims({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('ready')),
			state: 'ready',
		}, ['service:proxy'])
		for (const app of apps) await register(harness, app)
	}

	async function register(harness: NamespaceHarness, app: string): Promise<void> {
		await harness.deps.repositories.registry.createApp({ id: app, repoUrl: `github.com/acme/${app}` })
		const put = await rpcResult(
			rpcRequest('apps.environments.put', { appId: app, env: 'prod', environment: { ...registrationBody('apps-prod'), domain: `${app}.example.test` } }),
			harness.deps,
		)
		expect(put.status).toBe(200)
	}

	const republishDeps = (harness: NamespaceHarness) => ({
		repositories: harness.deps.repositories,
		provider: harness.deps.provider,
		lock: makeFakeLock(harness.deps.repositories),
		queue: harness.deps.queue,
	})

	const state = async (harness: NamespaceHarness) => (await harness.deps.repositories.registry.getDeploymentNamespace('apps-prod'))?.state

	test('hands the provider every member as the registry holds it now', async () => {
		const record = republishing()
		const harness = makeDeps(republishingProvider(record))
		await seed(harness, ['alpha'])
		await republishNamespace(republishDeps(harness), 'apps-prod', { wait: 'active' })
		await register(harness, 'beta')
		await republishNamespace(republishDeps(harness), 'apps-prod', { wait: 'active' })

		expect(record.calls.map((call) => call.members)).toEqual([
			['alpha/prod@alpha.example.test'],
			['alpha/prod@alpha.example.test', 'beta/prod@beta.example.test'],
		])
		expect(await state(harness)).toBe('ready')
		expect(harness.sent).toEqual([])
	})

	test('a started rebuild stays provisioning and is settled by a reconcile job, even across a lost enqueue', async () => {
		const record = republishing()
		const harness = makeDeps(republishingProvider(record))
		await seed(harness)
		await republishNamespace(republishDeps(harness), 'apps-prod', { wait: 'started' })
		expect(await state(harness)).toBe('provisioning')
		expect(harness.sent).toEqual([{ kind: 'namespace', namespaceId: 'apps-prod', mutation: 'reconcile' }])

		harness.sent.splice(0)
		await enqueueUnsettledNamespaces(harness.deps.repositories.registry, harness.deps.queue)
		expect(await harness.drain()).toEqual([{ namespaceId: 'apps-prod', status: 'ready' }])
		expect(await state(harness)).toBe('ready')
	})

	test('a failed rebuild keeps the registry change, leaves the namespace provisioning and queues a reconcile', async () => {
		const record = republishing()
		record.fail = true
		const harness = makeDeps(republishingProvider(record))
		await seed(harness)
		await expect(republishNamespace(republishDeps(harness), 'apps-prod', { wait: 'started' })).rejects.toThrow('platform said no')
		expect(await state(harness)).toBe('provisioning')
		expect(harness.sent).toEqual([{ kind: 'namespace', namespaceId: 'apps-prod', mutation: 'reconcile' }])
		expect((await harness.deps.repositories.registry.listAppEnvsByNamespace('apps-prod')).map((row) => row.app_id)).toEqual(['alpha'])
	})

	test('refuses an unknown or failed namespace before the provider is asked', async () => {
		const record = republishing()
		const harness = makeDeps(republishingProvider(record))
		await expect(republishNamespace(republishDeps(harness), 'apps-prod', { wait: 'started' })).rejects.toThrow('not found')
		await seed(harness)
		await fixtureNamespaceWrite(harness.deps.repositories, 'apps-prod', 'failed')
		await expect(republishNamespace(republishDeps(harness), 'apps-prod', { wait: 'started' })).rejects.toThrow('not ready')
		expect(record.calls).toEqual([])
	})

	test('a rebuild, a namespace job and an app deploy serialize on the namespace lease', async () => {
		const record = republishing()
		const harness = makeDeps(republishingProvider(record))
		await seed(harness)
		const run = 'run-alpha'
		await harness.deps.repositories.runs.createRun({ id: run, appId: 'alpha', env: 'prod', ref: 'main', trigger: 'manual' })
		const runDeps = {
			...republishDeps(harness),
			secrets: new VaultSecretResolver({}),
			logs: { put: () => Promise.resolve() },
		}
		const release = Promise.withResolvers<void>()
		const entered = Promise.withResolvers<void>()
		record.gate = release.promise
		record.entered = entered.resolve
		const registryChange = republishNamespace(republishDeps(harness), 'apps-prod', { wait: 'started' })
		await entered.promise

		await expect(republishNamespace(republishDeps(harness), 'apps-prod', { wait: 'started' })).rejects.toThrow('busy')
		expect(await runNamespaceJob(republishDeps(harness), { kind: 'namespace', namespaceId: 'apps-prod', mutation: 'reconcile' })).toEqual({
			namespaceId: 'apps-prod',
			status: 'deferred',
		})
		expect(await executeDeploy(runDeps, { runId: run })).toEqual({ runId: run, status: 'deferred' })
		expect((await harness.deps.repositories.runs.getRun(run))?.status).toBe('pending')

		release.resolve()
		record.gate = null
		await registryChange
		await harness.drain()
		expect(await executeDeploy(runDeps, { runId: run })).toEqual({ runId: run, status: 'succeeded' })
		expect(record.calls.map((call) => call.wait)).toEqual(['started', 'active'])
		expect(await state(harness)).toBe('ready')
		expect(await heldLeases(harness.deps.repositories)).toEqual([])
	})

	test('a deploy cancelled during its rebuild leaves the rebuild to a reconcile job and settles the run', async () => {
		const record = republishing()
		const harness = makeDeps(republishingProvider(record))
		await seed(harness)
		const run = 'run-alpha'
		await harness.deps.repositories.runs.createRun({ id: run, appId: 'alpha', env: 'prod', ref: 'main', trigger: 'manual' })
		record.entered = () => {
			void harness.deps.repositories.runs.requestRunCancellation(run)
		}
		const result = await executeDeploy({
			...republishDeps(harness),
			secrets: new VaultSecretResolver({}),
			logs: { put: () => Promise.resolve() },
		}, { runId: run })

		expect(result).toEqual({ runId: run, status: 'skipped' })
		expect((await harness.deps.repositories.runs.getRun(run))?.status).toBe('failed')
		expect(await state(harness)).toBe('provisioning')
		expect(harness.sent).toEqual([{ kind: 'namespace', namespaceId: 'apps-prod', mutation: 'reconcile' }])
	})

	const runDepsOf = (harness: NamespaceHarness) => ({
		...republishDeps(harness),
		secrets: new VaultSecretResolver({}),
		logs: { put: () => Promise.resolve() },
	})

	test('a deploy hands the proxy and the application the same proxy secret, generated once per environment (ADR-0022 rule 5)', async () => {
		const record = republishing()
		const harness = makeDeps(republishingProvider(record))
		await seed(harness, ['alpha', 'beta'])
		const vault = await Vault.create(harnessDatabase(harness.deps.repositories), btoa(String.fromCharCode(...new Uint8Array(32).fill(7))))
		const proxySecrets = new VaultProxySecrets(harness.deps.repositories.registry, () => Promise.resolve(vault))
		const deps = { ...runDepsOf(harness), proxySecrets }
		for (const run of ['run-1', 'run-2']) {
			await harness.deps.repositories.runs.createRun({ id: run, appId: 'alpha', env: 'prod', ref: 'main', trigger: 'manual' })
			expect(await executeDeploy(deps, { runId: run })).toEqual({ runId: run, status: 'succeeded' })
		}

		const [alpha, beta] = record.memberSecrets[0] ?? []
		expect(alpha).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(beta).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(beta).not.toBe(alpha)
		expect(record.memberSecrets[1]).toEqual([alpha, beta])
		expect(record.deploySecrets).toEqual([alpha, alpha])
		const stored = await harness.deps.repositories.registry.getAppEnvProxySecretRef('alpha', 'prod')
		expect(stored === null ? null : await vault.getSecretForPurpose(stored, proxySecretPurpose('alpha', 'prod'))).toBe(alpha ?? '')
	})

	test('without a vault no member carries a proxy secret and the application gets none', async () => {
		const record = republishing()
		const harness = makeDeps(republishingProvider(record))
		await seed(harness)
		await harness.deps.repositories.runs.createRun({ id: 'run-1', appId: 'alpha', env: 'prod', ref: 'main', trigger: 'manual' })
		expect(await executeDeploy(runDepsOf(harness), { runId: 'run-1' })).toEqual({ runId: 'run-1', status: 'succeeded' })
		expect(record.memberSecrets).toEqual([[undefined]])
		expect(record.deploySecrets).toEqual([null])
	})

	test('a started rebuild that leaves nothing in flight ends ready without a reconcile job', async () => {
		const record = republishing()
		record.settledWhenStarted = true
		const harness = makeDeps(republishingProvider(record))
		await seed(harness)
		await republishNamespace(republishDeps(harness), 'apps-prod', { wait: 'started' })
		expect(await state(harness)).toBe('ready')
		expect(harness.sent).toEqual([])
	})

	test('a registry change that finds the namespace busy requeues it and queues a reconcile', async () => {
		const record = republishing()
		const harness = makeDeps(republishingProvider(record))
		await seed(harness)
		const holder = await acquireLease(makeFakeLock(harness.deps.repositories), namespaceLeaseKey('apps-prod'))
		if (holder === null) throw new Error('lease missing')
		await expect(republishNamespace(republishDeps(harness), 'apps-prod', { wait: 'started' })).rejects.toThrow('busy')
		await holder.release()
		expect(await state(harness)).toBe('pending')
		expect(harness.sent).toEqual([{ kind: 'namespace', namespaceId: 'apps-prod', mutation: 'reconcile' }])
		expect(await harness.drain()).toEqual([{ namespaceId: 'apps-prod', status: 'ready' }])
		expect(record.calls).toEqual([])
	})

	test('a registry change while a namespace job runs is published by the reconcile queued after it', async () => {
		const record = republishing()
		const base = republishingProvider(record)
		const namespaces = base.namespaces
		if (namespaces === undefined) throw new Error('test provider must support namespaces')
		const reconciled: string[][] = []
		const inJob = Promise.withResolvers<void>()
		const finish = Promise.withResolvers<void>()
		let first = true
		const harness = makeDeps({
			...base,
			namespaces: {
				...namespaces,
				async reconcile(input) {
					reconciled.push(input.members.map((member) => member.appId))
					if (first) {
						first = false
						inJob.resolve()
						await finish.promise
					}
					return withTarget(input.namespace, target('reconciled'))
				},
			},
		})
		await seed(harness)
		await fixtureNamespaceWrite(harness.deps.repositories, 'apps-prod', 'provisioning')
		const job = runNamespaceJob(republishDeps(harness), { kind: 'namespace', namespaceId: 'apps-prod', mutation: 'reconcile' })
		await inJob.promise

		// The registry write itself, as a delete or a domain change makes it, while the job holds the lease.
		await harness.deps.repositories.registry.createApp({ id: 'beta', repoUrl: 'github.com/acme/beta' })
		await harness.deps.repositories.registry.upsertAppEnv({
			appId: 'beta',
			env: 'prod',
			namespaceId: 'apps-prod',
			provider: 'harbor',
			providerTargetJson: JSON.stringify(target('app')),
			providerArtifactJson: JSON.stringify(artifact()),
		})
		await expect(republishNamespace(republishDeps(harness), 'apps-prod', { wait: 'started' })).rejects.toThrow('busy')
		finish.resolve()

		expect(await job).toEqual({ namespaceId: 'apps-prod', status: 'ready' })
		expect(await state(harness)).toBe('pending')
		expect(await harness.drain()).toEqual([{ namespaceId: 'apps-prod', status: 'ready' }])
		expect(reconciled).toEqual([['alpha'], ['alpha', 'beta']])
		expect(await state(harness)).toBe('ready')
	})

	test('a reconcile requested while a deploy holds the namespace lease still runs after the deploy', async () => {
		const record = republishing()
		const harness = makeDeps(republishingProvider(record))
		await seed(harness)
		await harness.deps.repositories.runs.createRun({ id: 'run-alpha', appId: 'alpha', env: 'prod', ref: 'main', trigger: 'manual' })
		const resolving = Promise.withResolvers<void>()
		record.resolving = resolving.promise
		const deploy = executeDeploy(runDepsOf(harness), { runId: 'run-alpha' })
		for (let i = 0; i < 100 && (await heldLeases(harness.deps.repositories)).length < 2; i++) await Bun.sleep(1)

		await reconcileNamespaceUseCase(
			{
				repositories: harness.deps.repositories,
				provider: harness.deps.provider,
				auth: harness.deps.auth,
				signal: new AbortController().signal,
				queue: harness.deps.queue,
			},
			'apps-prod',
		)
		resolving.resolve()

		expect(await deploy).toEqual({ runId: 'run-alpha', status: 'succeeded' })
		expect(await state(harness)).toBe('pending')
		expect(await harness.drain()).toEqual([{ namespaceId: 'apps-prod', status: 'ready' }])
	})

	test('a failed active rebuild stops the deploy before the provider deploys, fails the run and queues a reconcile', async () => {
		const record = republishing()
		record.fail = true
		const harness = makeDeps(republishingProvider(record))
		await seed(harness)
		await harness.deps.repositories.runs.createRun({ id: 'run-alpha', appId: 'alpha', env: 'prod', ref: 'main', trigger: 'manual' })

		expect(await executeDeploy(runDepsOf(harness), { runId: 'run-alpha' })).toEqual({ runId: 'run-alpha', status: 'failed' })
		expect(record.deploys).toEqual([])
		expect((await harness.deps.repositories.runs.getRun('run-alpha'))?.status).toBe('failed')
		expect(harness.sent).toEqual([{ kind: 'namespace', namespaceId: 'apps-prod', mutation: 'reconcile' }])
	})

	test('a deploy into a republishing namespace without the control queue fails closed', async () => {
		const record = republishing()
		const harness = makeDeps(republishingProvider(record))
		await seed(harness)
		await harness.deps.repositories.runs.createRun({ id: 'run-alpha', appId: 'alpha', env: 'prod', ref: 'main', trigger: 'manual' })
		const { queue: _unused, ...withoutQueue } = runDepsOf(harness)

		expect(await executeDeploy(withoutQueue, { runId: 'run-alpha' })).toEqual({ runId: 'run-alpha', status: 'failed' })
		expect(record.calls).toEqual([])
		expect(record.deploys).toEqual([])
	})
})

describe('provider namespace errors', () => {
	function failingOperator(cause: unknown): ControlProvider {
		const provider = namespacedProvider(providerRecording())
		const namespaces = provider.namespaces
		const operator = namespaces?.operator
		if (namespaces === undefined || operator === undefined) throw new Error('test provider must support namespace planning')
		return {
			...provider,
			namespaces: {
				...namespaces,
				normalize: () => {
					throw cause
				},
				operator: {
					...operator,
					plan: () => {
						throw cause
					},
				},
			},
		}
	}

	async function errorOf(response: Response): Promise<{ status: number; error: unknown }> {
		const body: { error: unknown } = await response.json()
		return { status: response.status, error: body.error }
	}

	test('a structural provider error keeps its own status on plan and create', async () => {
		const { deps } = makeDeps(failingOperator(new ConflictError('preset retired')))
		const expected = { status: 409, error: 'preset retired' }
		expect(await errorOf(await rpcResult(rpcRequest('namespaces.plan', { id: 'apps-prod', env: 'prod', preset: 'shared' }), deps))).toEqual(expected)
		expect(await errorOf(await rpcResult(rpcRequest('namespaces.create', namespaceBody('apps-prod')), deps))).toEqual(expected)
	})

	test('any other provider error becomes a 400 with its message on plan and create', async () => {
		const { deps } = makeDeps(failingOperator(new Error('unknown preset')))
		const expected = { status: 400, error: 'unknown preset' }
		expect(await errorOf(await rpcResult(rpcRequest('namespaces.plan', { id: 'apps-prod', env: 'prod', preset: 'shared' }), deps))).toEqual(expected)
		expect(await errorOf(await rpcResult(rpcRequest('namespaces.create', namespaceBody('apps-prod')), deps))).toEqual(expected)
	})
})
