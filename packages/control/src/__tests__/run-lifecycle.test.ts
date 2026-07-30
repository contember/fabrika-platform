import type {
	ControlProvider,
	ProviderDeployInput,
	ProviderEnvelope,
	ProviderRegistration,
	ProviderRegistrationInput,
} from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import type { ControlRepositories, RunRow } from '../db'
import { uuidv7 } from '../db'
import { cancelDeploy, type DeployJobMessage, executeDeploy, parseProviderEnvelope, type RunDeps, type RunOutcome } from '../run-lifecycle'
import { EnvSecretResolver, type SecretResolver } from '../secret-resolver'
import { createHarness } from './helpers/harness'
import { makeFakeLock } from './helpers/lock'

const envelope = (provider: string, payload: string): ProviderEnvelope => ({
	provider,
	version: 1,
	payload,
})

const normalize = (provider: string, input: ProviderRegistrationInput): ProviderRegistration => {
	if (
		input.app.id !== input.environment.appId
		|| input.environment.target.provider !== provider
		|| input.environment.artifact.provider !== provider
	) {
		throw new Error('foreign provider registration')
	}
	return input
}

async function seedRun(
	db: ControlRepositories,
	options: { provider?: string; secretRef?: string; externalId?: string } = {},
): Promise<string> {
	const provider = options.provider ?? 'memory'
	await db.registry.createApp({
		id: 'app',
		repoUrl: 'https://github.com/acme/app.git',
		workerDir: 'worker',
		configPath: 'fabrika.config.ts',
		githubInstallationId: 42,
	})
	await db.registry.upsertAppEnv({
		appId: 'app',
		env: 'prod',
		domain: 'app.example.com',
		namespaceId: null,
		provider,
		providerTargetJson: JSON.stringify(envelope(provider, 'target')),
		providerArtifactJson: JSON.stringify(envelope(provider, 'artifact')),
	})
	await db.registry.upsertAppSecret({
		appId: 'app',
		env: null,
		name: 'API_KEY',
		valueRef: options.secretRef ?? 'literal:all-env',
	})
	await db.registry.upsertAppSecret({ appId: 'app', env: 'prod', name: 'API_KEY', valueRef: 'literal:prod' })
	await db.registry.upsertAppVar({ appId: 'app', env: null, name: 'TEAM', value: 'all-env' })
	await db.registry.upsertAppVar({ appId: 'app', env: 'prod', name: 'TEAM', value: 'prod' })
	const runId = uuidv7()
	await db.runs.createRun({
		id: runId,
		appId: 'app',
		env: 'prod',
		ref: 'refs/heads/deploy/prod',
		trigger: 'manual',
	})
	if (options.externalId !== undefined) {
		await db.runs.markRunStarted(runId, `runs/${runId}/logs.ndjson`)
		await db.runs.setRunExternalId(runId, options.externalId)
	}
	return runId
}

function makeProvider(
	inputs: ProviderDeployInput[],
	outcome: RunOutcome,
	options: { id?: string; managedSecrets?: boolean; cancelled?: string[]; cancelledNamespaces?: string[] } = {},
): ControlProvider {
	const id = options.id ?? 'memory'
	return {
		id,
		normalizeRegistration: (input) => normalize(id, input),
		deploy: async (input) => {
			inputs.push(input)
			await input.events.externalId(`${id}-run-1`)
			return outcome
		},
		cancel: async (input) => {
			options.cancelled?.push(input.externalId)
			options.cancelledNamespaces?.push(input.environment.namespace?.id ?? 'none')
		},
		...(options.managedSecrets
			? {
				secrets: {
					put: async () => ({ valueRef: `${id}:secret` }),
					delete: async () => {},
				},
			}
			: {}),
	}
}

function makeDeps(
	db: ControlRepositories,
	provider: ControlProvider,
	secrets: SecretResolver = new EnvSecretResolver({}),
	lock = makeFakeLock(),
): RunDeps {
	return { repositories: db, provider, secrets, lock }
}

const requireRun = async (db: ControlRepositories, id: string): Promise<RunRow> => {
	const run = await db.runs.getRun(id)
	if (run === null) {
		throw new Error(`missing run ${id}`)
	}
	return run
}

describe('provider-neutral run lifecycle', () => {
	test('resolves layered values and records a successful provider run', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		const inputs: ProviderDeployInput[] = []
		const lock = makeFakeLock()
		const message: DeployJobMessage = { runId, dryRun: true }

		const result = await executeDeploy(
			makeDeps(db, makeProvider(inputs, { state: 'succeeded', exitCode: 0 }), new EnvSecretResolver({}), lock),
			message,
		)

		expect(result).toEqual({ runId, status: 'succeeded' })
		expect(inputs).toHaveLength(1)
		const input = inputs[0]
		if (input === undefined) throw new Error('expected provider input')
		expect(input.app).toEqual({
			id: 'app',
			source: {
				repoUrl: 'https://github.com/acme/app.git',
				ref: 'refs/heads/deploy/prod',
				workerDir: 'worker',
				configPath: 'fabrika.config.ts',
				githubInstallationId: 42,
			},
		})
		expect(input.environment.domain).toBe('app.example.com')
		expect(input.secrets).toEqual({ API_KEY: 'prod' })
		expect(input.vars).toEqual({ TEAM: 'prod' })
		expect(input.dryRun).toBe(true)

		const run = await requireRun(db, runId)
		expect(run.status).toBe('succeeded')
		expect(run.exit_code).toBe(0)
		expect(run.external_run_id).toBe('memory-run-1')
		expect(run.log_key).toBe(`runs/${runId}/logs.ndjson`)
		expect(lock.held.size).toBe(0)
	})

	test('provider-managed secrets remain at the provider and are not resolved into a run', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		const inputs: ProviderDeployInput[] = []
		const resolver: SecretResolver = {
			resolveSecret: async () => {
				throw new Error('must not resolve provider-managed refs')
			},
		}
		const provider = makeProvider(inputs, { state: 'succeeded' }, { managedSecrets: true })

		expect((await executeDeploy(makeDeps(db, provider, resolver), { runId })).status).toBe('succeeded')
		expect(inputs[0]?.secrets).toEqual({})
	})

	test('fails closed when persisted data belongs to another provider', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db, { provider: 'other' })
		const inputs: ProviderDeployInput[] = []

		expect((await executeDeploy(makeDeps(db, makeProvider(inputs, { state: 'succeeded' })), { runId })).status).toBe('failed')
		expect(inputs).toEqual([])
		expect((await requireRun(db, runId)).status).toBe('failed')
	})

	test('verifies namespace and app resource claims before calling the provider', async () => {
		const { db, sqlite } = createHarness()
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await db.registry.createDeploymentNamespaceWithResourceClaims({
			id: 'apps-prod',
			env: 'prod',
			provider: 'memory',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(envelope('memory', 'namespace')),
			state: 'ready',
		}, ['service:proxy'])
		await db.registry.upsertAppEnvWithNamespaceResourceClaims({
			appId: 'app',
			env: 'prod',
			namespaceId: 'apps-prod',
			provider: 'memory',
			providerTargetJson: JSON.stringify(envelope('memory', 'target')),
			providerArtifactJson: JSON.stringify(envelope('memory', 'artifact')),
		}, ['service:app'])
		const inputs: ProviderDeployInput[] = []
		const provider: ControlProvider = {
			...makeProvider(inputs, { state: 'succeeded' }),
			namespaces: {
				normalize: (namespace) => namespace,
				namespaceResourceClaims: () => ['service:proxy'],
				registrationResourceClaims: () => ['service:app'],
				provision: async (input) => input.namespace,
				reconcile: async (input) => input.namespace,
			},
		}
		const deploy = async (): Promise<string> => {
			const runId = uuidv7()
			await db.runs.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
			return (await executeDeploy(makeDeps(db, provider), { runId })).status
		}

		expect(await deploy()).toBe('succeeded')
		expect(inputs[0]?.environment.namespace?.id).toBe('apps-prod')

		sqlite.query(`DELETE FROM namespace_resource_claims WHERE namespace_id = ? AND resource_key = ?`).run('apps-prod', 'service:app')
		expect(await deploy()).toBe('failed')
		expect(inputs).toHaveLength(1)
	})

	test('rejects namespace coordinate drift before calling the provider', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app' })
		await db.registry.createApp({ id: 'other', repoUrl: 'github.com/acme/other' })
		await db.registry.createDeploymentNamespaceWithResourceClaims({
			id: 'exclusive',
			env: 'prod',
			provider: 'memory',
			exclusiveAppId: 'other',
			providerTargetJson: JSON.stringify(envelope('memory', 'namespace')),
			state: 'ready',
		}, ['service:proxy'])
		await db.registry.upsertAppEnv({
			appId: 'app',
			env: 'prod',
			namespaceId: 'exclusive',
			provider: 'memory',
			providerTargetJson: JSON.stringify(envelope('memory', 'target')),
			providerArtifactJson: JSON.stringify(envelope('memory', 'artifact')),
		})
		const runId = uuidv7()
		await db.runs.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		const inputs: ProviderDeployInput[] = []
		const provider: ControlProvider = {
			...makeProvider(inputs, { state: 'succeeded' }),
			namespaces: {
				normalize: (namespace) => namespace,
				namespaceResourceClaims: () => ['service:proxy'],
				registrationResourceClaims: () => [],
				provision: async (input) => input.namespace,
				reconcile: async (input) => input.namespace,
			},
		}

		expect((await executeDeploy(makeDeps(db, provider), { runId })).status).toBe('failed')
		expect(inputs).toEqual([])
	})

	test('skips redelivery and defers while another run owns the lock', async () => {
		const { db } = createHarness()
		const runningId = await seedRun(db)
		await db.runs.markRunStarted(runningId, `runs/${runningId}/logs.ndjson`)
		const inputs: ProviderDeployInput[] = []
		expect(
			(await executeDeploy(makeDeps(db, makeProvider(inputs, { state: 'succeeded' })), { runId: runningId })).status,
		).toBe('skipped')

		const pendingId = uuidv7()
		await db.runs.createRun({ id: pendingId, appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		const lock = makeFakeLock()
		await lock.acquire('app:prod', 'other-run')
		expect(
			(await executeDeploy(makeDeps(db, makeProvider(inputs, { state: 'succeeded' }), new EnvSecretResolver({}), lock), {
				runId: pendingId,
			})).status,
		).toBe('deferred')
		expect((await requireRun(db, pendingId)).status).toBe('pending')
		expect(inputs).toEqual([])
	})

	test('records resolution and provider failures without leaking the exception', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		await db.registry.upsertAppSecret({ appId: 'app', env: 'prod', name: 'API_KEY', valueRef: 'env:MISSING' })

		expect(
			(await executeDeploy(
				makeDeps(db, makeProvider([], { state: 'succeeded' }), new EnvSecretResolver({})),
				{ runId },
			)).status,
		).toBe('failed')
		expect((await requireRun(db, runId)).exit_code).toBeNull()
	})

	test('cancels provider work by generic external id and releases the lock', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db, { externalId: 'provider-operation-1' })
		const cancelled: string[] = []
		const cancelledNamespaces: string[] = []
		await db.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'memory',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(envelope('memory', 'namespace-target')),
			state: 'failed',
		})
		const appEnv = await db.registry.getAppEnv('app', 'prod')
		if (appEnv === null) throw new Error('expected app environment')
		await db.registry.upsertAppEnv({
			appId: appEnv.app_id,
			env: appEnv.env,
			domain: appEnv.domain,
			triggerRef: appEnv.trigger_ref,
			namespaceId: 'apps-prod',
			provider: appEnv.provider,
			providerTargetJson: appEnv.provider_target_json,
			providerArtifactJson: appEnv.provider_artifact_json,
		})
		const lock = makeFakeLock()
		await lock.acquire('app:prod', runId)
		const deps = makeDeps(
			db,
			makeProvider([], { state: 'failed' }, { cancelled, cancelledNamespaces }),
			new EnvSecretResolver({}),
			lock,
		)

		await cancelDeploy(deps, await requireRun(db, runId))

		expect(cancelled).toEqual(['provider-operation-1'])
		expect(cancelledNamespaces).toEqual(['apps-prod'])
		expect((await requireRun(db, runId)).status).toBe('failed')
		expect(lock.held.size).toBe(0)
	})
})

describe('parseProviderEnvelope', () => {
	test('accepts arbitrary provider ids and rejects invalid persisted data', () => {
		expect(parseProviderEnvelope('{"provider":"third","version":1,"payload":{"region":"eu"}}', 'target')).toEqual({
			provider: 'third',
			version: 1,
			payload: { region: 'eu' },
		})
		expect(() => parseProviderEnvelope('{"provider":"third","version":1}', 'target')).toThrow('provider envelope')
		expect(() => parseProviderEnvelope('{', 'target')).toThrow('valid JSON')
	})
})
