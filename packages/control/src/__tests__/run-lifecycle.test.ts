import { FABRIKA_APP_ID, FABRIKA_ENVIRONMENT, FABRIKA_OPERATIONS_DSN, FABRIKA_SERVICE_KEY } from '@fabrika/operations-contract/ingest'
import { FABRIKA_RELEASE } from '@fabrika/operations-contract/releases'
import type { BlobStore } from '@fabrika/platform'
import type {
	ControlProvider,
	ProviderDeployInput,
	ProviderEnvelope,
	ProviderRegistration,
	ProviderRegistrationInput,
} from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { getRunLogUseCase } from '../api/runs'
import type { ControlRepositories, RunRow } from '../db'
import { uuidv7 } from '../db'
import { cancelDeploy, type DeployJobMessage, executeDeploy, parseProviderEnvelope, type RunDeps, type RunOutcome } from '../run-lifecycle'
import { EnvSecretResolver, type SecretResolver } from '../secret-resolver'
import { createHarness } from './helpers/harness'
import { allowAllAuth } from './helpers/iam'
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
		publicOrigin: 'https://public.example.com',
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

async function activateOperationsIngest(db: ControlRepositories): Promise<string> {
	await db.operationsCatalog.markDirty()
	const snapshot = await db.operationsCatalog.snapshot()
	const source = snapshot.sources[0]
	if (source === undefined) throw new Error('missing Operations catalog source')
	const dsn = `https://${source.public_key}@errors.example.test/100000000000000001`
	await db.operationsCatalog.markApplied(snapshot.revision, 'snapshot-hash', [{
		appId: source.app_id,
		environment: source.env,
		serviceKey: source.service_key,
		credentialId: source.credential_id,
		ingestProjectId: '100000000000000001',
		dsn,
	}])
	return dsn
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
	return { repositories: db, provider, secrets, lock, logs: { put: () => Promise.resolve() } }
}

function memoryLogs(
	initial: Readonly<Record<string, string>> = {},
	beforePut: (putNumber: number) => Promise<void> = () => Promise.resolve(),
): { logs: BlobStore; objects: Map<string, string>; puts: string[] } {
	const objects = new Map(Object.entries(initial))
	const puts: string[] = []
	const logs: BlobStore = {
		put: async (key, value) => {
			if (typeof value !== 'string') throw new Error('test log store accepts strings only')
			puts.push(key)
			await beforePut(puts.length)
			objects.set(key, value)
		},
		get: (key) => {
			const value = objects.get(key)
			return Promise.resolve(value === undefined ? null : { body: new Blob([value]).stream(), text: () => Promise.resolve(value) })
		},
		delete: (key) => {
			objects.delete(key)
			return Promise.resolve()
		},
	}
	return { logs, objects, puts }
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
		expect(input.environment.publicOrigin).toBe('https://public.example.com')
		expect(input.secrets).toEqual({ API_KEY: 'prod' })
		expect(input.vars).toEqual({ TEAM: 'prod' })
		expect(input.managedEnvironment).toEqual({
			[FABRIKA_OPERATIONS_DSN]: null,
			[FABRIKA_APP_ID]: null,
			[FABRIKA_ENVIRONMENT]: null,
			[FABRIKA_SERVICE_KEY]: null,
			[FABRIKA_RELEASE]: null,
		})
		expect(input.dryRun).toBe(true)

		const run = await requireRun(db, runId)
		expect(run.status).toBe('succeeded')
		expect(run.exit_code).toBe(0)
		expect(run.external_run_id).toBe('memory-run-1')
		expect(run.log_key).toBe(`runs/${runId}/logs.ndjson`)
		expect(lock.held.size).toBe(0)
	})

	test('persists provider log lines as ordered NDJSON readable through the run log use case', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		let markFirstStarted = () => {}
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve
		})
		let finishFirst = () => {}
		const firstFinished = new Promise<void>((resolve) => {
			finishFirst = resolve
		})
		let markSecondStarted = () => {}
		const secondStarted = new Promise<void>((resolve) => {
			markSecondStarted = resolve
		})
		let finishSecond = () => {}
		const secondFinished = new Promise<void>((resolve) => {
			finishSecond = resolve
		})
		const stored = memoryLogs({}, async (putNumber) => {
			if (putNumber === 1) {
				markFirstStarted()
				await firstFinished
			}
			if (putNumber === 2) {
				markSecondStarted()
				await secondFinished
			}
		})
		const provider = makeProvider([], { state: 'succeeded', exitCode: 0 })
		provider.deploy = async (input) => {
			input.events.log('checking source')
			input.events.log('deploy complete')
			return { state: 'succeeded', exitCode: 0 }
		}
		const deps = makeDeps(db, provider)
		deps.logs = stored.logs

		const deploy = executeDeploy(deps, { runId })
		await firstStarted
		expect(stored.puts).toEqual([`runs/${runId}/logs.ndjson`])
		expect((await requireRun(db, runId)).status).toBe('running')
		finishFirst()
		await secondStarted
		expect(stored.puts).toEqual([`runs/${runId}/logs.ndjson`, `runs/${runId}/logs.ndjson`])
		expect((await requireRun(db, runId)).status).toBe('running')
		finishSecond()
		expect(await deploy).toEqual({ runId, status: 'succeeded' })
		const response = await getRunLogUseCase({
			repositories: db,
			queue: { send: () => Promise.resolve() },
			logs: stored.logs,
			cancel: () => Promise.resolve(),
			auth: allowAllAuth(),
		}, runId)
		expect(response.status).toBe('succeeded')
		expect(response.lines.map(({ stream, text }) => ({ stream, text }))).toEqual([
			{ stream: 'meta', text: 'checking source' },
			{ stream: 'meta', text: 'deploy complete' },
		])
		expect(response.lines.every((line) => Number.isFinite(line.ts))).toBe(true)
	})

	test('does not overwrite an existing runner log when the provider emits no control-side lines', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		const key = `runs/${runId}/logs.ndjson`
		const runnerContents = '{"ts":1,"stream":"stdout","text":"runner-owned"}\n'
		const stored = memoryLogs({ [key]: runnerContents })
		const deps = makeDeps(db, makeProvider([], { state: 'succeeded' }))
		deps.logs = stored.logs

		expect((await executeDeploy(deps, { runId })).status).toBe('succeeded')
		expect(stored.puts).toEqual([])
		expect(stored.objects.get(key)).toBe(runnerContents)
	})

	test('waits for queued log writes after a provider throw before recording failure', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		let startWrite = () => {}
		const writeStarted = new Promise<void>((resolve) => {
			startWrite = resolve
		})
		let finishWrite = () => {}
		const writeFinished = new Promise<void>((resolve) => {
			finishWrite = resolve
		})
		const provider = makeProvider([], { state: 'succeeded' })
		provider.deploy = async (input) => {
			input.events.log('provider started')
			throw new Error('provider failed')
		}
		const deps = makeDeps(db, provider)
		deps.logs = {
			put: async () => {
				startWrite()
				await writeFinished
			},
		}

		const deploy = executeDeploy(deps, { runId })
		await writeStarted
		expect((await requireRun(db, runId)).status).toBe('running')
		finishWrite()
		expect((await deploy).status).toBe('failed')
		expect((await requireRun(db, runId)).status).toBe('failed')
	})

	test('keeps provider success when blob persistence fails and does not log storage error details', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		const provider = makeProvider([], { state: 'succeeded' })
		provider.deploy = async (input) => {
			input.events.log('safe provider output')
			return { state: 'succeeded' }
		}
		const deps = makeDeps(db, provider)
		deps.logs = { put: () => Promise.reject(new Error('credential-must-not-leak')) }
		const errors: string[] = []
		const originalError = console.error
		console.error = (...values) => errors.push(values.map(String).join(' '))
		try {
			expect((await executeDeploy(deps, { runId })).status).toBe('succeeded')
		} finally {
			console.error = originalError
		}
		expect(errors).toEqual([`deploy run ${runId}: failed to persist log output`])
		expect(errors.join('\n')).not.toContain('credential-must-not-leak')
	})

	test('injects only an active Operations configuration and leaves application vars separate', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		await db.operationsCatalog.markDirty()
		await db.operationsCatalog.snapshot()
		const pendingInputs: ProviderDeployInput[] = []
		expect((await executeDeploy(makeDeps(db, makeProvider(pendingInputs, { state: 'succeeded' })), { runId })).status).toBe('succeeded')
		expect(pendingInputs[0]?.managedEnvironment).toEqual({
			[FABRIKA_OPERATIONS_DSN]: null,
			[FABRIKA_APP_ID]: null,
			[FABRIKA_ENVIRONMENT]: null,
			[FABRIKA_SERVICE_KEY]: null,
			[FABRIKA_RELEASE]: null,
		})

		const secondRunId = uuidv7()
		await db.runs.createRun({
			id: secondRunId,
			appId: 'app',
			env: 'prod',
			ref: 'refs/heads/deploy/prod',
			trigger: 'manual',
		})
		const dsn = await activateOperationsIngest(db)
		const activeInputs: ProviderDeployInput[] = []
		expect((await executeDeploy(makeDeps(db, makeProvider(activeInputs, { state: 'succeeded' })), { runId: secondRunId })).status).toBe(
			'succeeded',
		)
		expect(activeInputs[0]?.vars).toEqual({ TEAM: 'prod' })
		expect(activeInputs[0]?.managedEnvironment).toEqual({
			[FABRIKA_OPERATIONS_DSN]: dsn,
			[FABRIKA_APP_ID]: 'app',
			[FABRIKA_ENVIRONMENT]: 'prod',
			[FABRIKA_SERVICE_KEY]: 'default',
			[FABRIKA_RELEASE]: null,
		})
	})

	test('rejects legacy user values under reserved Operations names without logging their value', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		await db.registry.upsertAppVar({
			appId: 'app',
			env: 'prod',
			name: FABRIKA_OPERATIONS_DSN,
			value: 'must-not-reach-provider',
		})
		const inputs: ProviderDeployInput[] = []
		const logged: string[] = []
		const originalError = console.error
		console.error = (...values) => {
			logged.push(values.map(String).join(' '))
		}
		try {
			expect((await executeDeploy(makeDeps(db, makeProvider(inputs, { state: 'succeeded' })), { runId })).status).toBe('failed')
		} finally {
			console.error = originalError
		}
		expect(inputs).toEqual([])
		expect(logged.join('\n')).not.toContain('must-not-reach-provider')
	})

	// ── ADR-0021 return origins (backlog 51) ────────────────────────────────────
	//
	// The registration is a fact the CONTROL PLANE knows, so this is the layer that decides it: what
	// reaches the provider here is what the deploy step hands to IAM's registry. All three acceptance
	// clauses of backlog 51 are decided by these two tests.

	test('projects every environment public origin of the app, not just the one being deployed', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		// A second environment of the SAME app, plus a third with no public origin at all. IAM's registry
		// is keyed by app id, so deploying `prod` must not un-register `stage`.
		await db.registry.upsertAppEnv({
			appId: 'app',
			env: 'stage',
			domain: 'stage.example.com',
			publicOrigin: 'https://stage.example.com',
			namespaceId: null,
			provider: 'memory',
			providerTargetJson: JSON.stringify(envelope('memory', 'target')),
			providerArtifactJson: JSON.stringify(envelope('memory', 'artifact')),
		})
		await db.registry.upsertAppEnv({
			appId: 'app',
			env: 'preview',
			domain: 'preview.example.com',
			publicOrigin: null,
			namespaceId: null,
			provider: 'memory',
			providerTargetJson: JSON.stringify(envelope('memory', 'target')),
			providerArtifactJson: JSON.stringify(envelope('memory', 'artifact')),
		})
		const inputs: ProviderDeployInput[] = []

		expect((await executeDeploy(makeDeps(db, makeProvider(inputs, { state: 'succeeded' })), { runId })).status).toBe('succeeded')
		expect(inputs[0]?.returnOrigins).toEqual(['https://public.example.com', 'https://stage.example.com'])

		// Re-pointing an environment REPLACES its origin rather than adding one: the old address stops
		// being handed a session on the next deploy.
		await db.registry.upsertAppEnv({
			appId: 'app',
			env: 'prod',
			domain: 'app.example.com',
			publicOrigin: 'https://moved.example.com',
			namespaceId: null,
			provider: 'memory',
			providerTargetJson: JSON.stringify(envelope('memory', 'target')),
			providerArtifactJson: JSON.stringify(envelope('memory', 'artifact')),
		})
		const secondRunId = uuidv7()
		await db.runs.createRun({ id: secondRunId, appId: 'app', env: 'prod', ref: 'refs/heads/deploy/prod', trigger: 'manual' })
		const moved: ProviderDeployInput[] = []
		expect((await executeDeploy(makeDeps(db, makeProvider(moved, { state: 'succeeded' })), { runId: secondRunId })).status).toBe(
			'succeeded',
		)
		expect(moved[0]?.returnOrigins).toEqual(['https://moved.example.com', 'https://stage.example.com'])
	})

	test('leaves an app with no public origin unregistered rather than guessing one', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		await db.registry.upsertAppEnv({
			appId: 'app',
			env: 'prod',
			domain: 'app.example.com',
			publicOrigin: null,
			namespaceId: null,
			provider: 'memory',
			providerTargetJson: JSON.stringify(envelope('memory', 'target')),
			providerArtifactJson: JSON.stringify(envelope('memory', 'artifact')),
		})
		const inputs: ProviderDeployInput[] = []

		expect((await executeDeploy(makeDeps(db, makeProvider(inputs, { state: 'succeeded' })), { runId })).status).toBe('succeeded')
		// Absent, not empty: an empty set is a caller error at the admin API and would read as "clear it".
		expect(inputs[0]?.returnOrigins).toBeUndefined()
		expect(inputs[0]?.environment.domain).toBe('app.example.com')
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
			publicOrigin: appEnv.public_origin,
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
