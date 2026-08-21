import { FABRIKA_IAM_ISSUER } from '@fabrika/auth-core'
import { FABRIKA_APP_ID, FABRIKA_ENVIRONMENT, FABRIKA_OPERATIONS_DSN, FABRIKA_SERVICE_KEY } from '@fabrika/operations-contract/ingest'
import { FABRIKA_RELEASE } from '@fabrika/operations-contract/releases'
import type { BlobStore } from '@fabrika/platform'
import type {
	ControlProvider,
	ProviderDeployInput,
	ProviderEnvelope,
	ProviderRegistration,
	ProviderRegistrationInput,
	ProviderSourceResolution,
	ProviderSourceResolutionInput,
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
	options: {
		provider?: string
		secretRef?: string
		externalId?: string
		commitSha?: string
		sourceBinding?: { connectionId: string; installationId: number }
	} = {},
): Promise<string> {
	const provider = options.provider ?? 'memory'
	await db.registry.createApp({
		id: 'app',
		repoUrl: options.sourceBinding === undefined ? 'https://github.com/acme/app.git' : 'github.com/acme/app',
		workerDir: 'worker',
		configPath: 'fabrika.config.ts',
		...(options.sourceBinding === undefined
			? { githubInstallationId: 42 }
			: {
				githubConnectionId: options.sourceBinding.connectionId,
				githubInstallationId: options.sourceBinding.installationId,
			}),
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
		...(options.commitSha === undefined ? {} : { commitSha: options.commitSha }),
		trigger: 'manual',
	})
	if (options.externalId !== undefined) {
		await db.runs.markRunStarted(runId, `runs/${runId}/logs.ndjson`)
		await db.runs.setRunExternalId(runId, options.externalId)
	}
	return runId
}

function insertSourceConnection(
	sqlite: ReturnType<typeof createHarness>['sqlite'],
	input: { connectionId: string; installationId: number; transportKind: 'keyed-v2' },
): void {
	sqlite.query(`INSERT INTO github_source_connections_keyed (
		connection_id, transport_kind, app_id, app_slug, app_html_url, app_owner, app_name, app_public,
		credential_sha256, webhook_url, webhook_secret_ref, installation_id,
		installation_account_login, installation_selection, verified_repositories_json,
		requested_repositories_json, connected_by, connected_at, verified_at, version
	) VALUES (?, ?, 'github-app', 'github-app', 'https://github.com/apps/github-app', 'acme', 'github-app', 0,
		?, 'https://control.example.test/webhooks/github', 'vault:webhook', ?,
		'acme', 'all', '[]', '[]', 'operator', 1, 1, 1)`)
		.run(input.connectionId, input.transportKind, 'c'.repeat(64), input.installationId)
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

interface TestSourceBinding {
	readonly connectionId: string
	readonly installationId: number
	readonly transportKind: 'keyed-v2'
}

interface TestBoundProvider extends ControlProvider {
	resolveSourceWithBinding(input: ProviderSourceResolutionInput & { readonly sourceBinding: TestSourceBinding }): Promise<ProviderSourceResolution>
	deployWithBinding(input: ProviderDeployInput & { readonly sourceBinding: TestSourceBinding }): Promise<RunOutcome>
}

describe('provider-neutral run lifecycle', () => {
	test('loads and carries the exact keyed source binding through resolve and deploy', async () => {
		const { db, sqlite } = createHarness()
		insertSourceConnection(sqlite, { connectionId: 'connection-1', installationId: 42, transportKind: 'keyed-v2' })
		const runId = await seedRun(db, {
			provider: 'zerops',
			sourceBinding: { connectionId: 'connection-1', installationId: 42 },
		})
		const seen: Array<{ phase: string; binding: TestSourceBinding; connectionId?: string; installationId?: number }> = []
		const provider: TestBoundProvider = {
			id: 'zerops',
			normalizeRegistration: (input) => normalize('zerops', input),
			resolveSource: () => Promise.reject(new Error('unbound resolution must not run')),
			resolveSourceWithBinding: (input) => {
				seen.push({
					phase: 'resolve',
					binding: input.sourceBinding,
					...(input.app.source.githubConnectionId === undefined ? {} : { connectionId: input.app.source.githubConnectionId }),
					...(input.app.source.githubInstallationId === undefined ? {} : { installationId: input.app.source.githubInstallationId }),
				})
				return Promise.resolve({ commitSha: 'a'.repeat(40) })
			},
			deploy: () => Promise.reject(new Error('unbound deploy must not run')),
			deployWithBinding: async (input) => {
				seen.push({
					phase: 'deploy',
					binding: input.sourceBinding,
					...(input.app.source.githubConnectionId === undefined ? {} : { connectionId: input.app.source.githubConnectionId }),
					...(input.app.source.githubInstallationId === undefined ? {} : { installationId: input.app.source.githubInstallationId }),
				})
				await input.events.externalId('version-1')
				return { state: 'succeeded' }
			},
		}

		expect((await executeDeploy(makeDeps(db, provider), { runId })).status).toBe('succeeded')
		expect(seen).toEqual([
			{
				phase: 'resolve',
				binding: { connectionId: 'connection-1', installationId: 42, transportKind: 'keyed-v2' },
				connectionId: 'connection-1',
				installationId: 42,
			},
			{
				phase: 'deploy',
				binding: { connectionId: 'connection-1', installationId: 42, transportKind: 'keyed-v2' },
				connectionId: 'connection-1',
				installationId: 42,
			},
		])
	})

	test('fails before provider source effects on partial, missing, stale, or swapped Zerops bindings', async () => {
		const cases: Array<{
			kind: string
			appBinding?: { connectionId: string; installationId: number }
			storedBinding?: { connectionId: string; installationId: number; transportKind: 'keyed-v2' }
		}> = [
			{ kind: 'partial', appBinding: undefined, storedBinding: undefined },
			{
				kind: 'missing',
				appBinding: { connectionId: 'missing-connection', installationId: 42 },
				storedBinding: undefined,
			},
			{
				kind: 'stale-installation',
				appBinding: { connectionId: 'connection-1', installationId: 84 },
				storedBinding: { connectionId: 'connection-1', installationId: 42, transportKind: 'keyed-v2' },
			},
			{
				kind: 'swapped-connection',
				appBinding: { connectionId: 'connection-2', installationId: 42 },
				storedBinding: { connectionId: 'connection-1', installationId: 42, transportKind: 'keyed-v2' },
			},
		]
		for (const current of cases) {
			const { db, sqlite } = createHarness()
			if (current.storedBinding !== undefined) insertSourceConnection(sqlite, current.storedBinding)
			const runId = await seedRun(db, {
				provider: 'memory',
				...(current.appBinding === undefined ? {} : { sourceBinding: current.appBinding }),
			})
			sqlite.query(`UPDATE app_envs SET provider = 'zerops' WHERE app_id = 'app' AND env = 'prod'`).run()
			let calls = 0
			const provider = makeProvider([], { state: 'succeeded' }, { id: 'zerops' })
			provider.resolveSource = () => {
				calls++
				return Promise.resolve({ commitSha: 'a'.repeat(40) })
			}
			expect((await executeDeploy(makeDeps(db, provider), { runId })).status, current.kind).toBe('failed')
			expect(calls, current.kind).toBe(0)
		}
	})

	test('preserves Cloudflare installation-only source coordinates', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db, { provider: 'cloudflare' })
		const inputs: ProviderDeployInput[] = []
		const provider = makeProvider(inputs, { state: 'succeeded' }, { id: 'cloudflare' })
		expect((await executeDeploy(makeDeps(db, provider), { runId })).status).toBe('succeeded')
		expect(inputs[0]?.app.source).toMatchObject({ githubInstallationId: 42 })
		expect(inputs[0]?.app.source.githubConnectionId).toBeUndefined()
	})

	test('resolves and persists an exact source revision before provider deploy', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		const calls: string[] = []
		let resolutionSignal: AbortSignal | undefined
		const inputs: ProviderDeployInput[] = []
		const provider = makeProvider(inputs, { state: 'succeeded' })
		provider.resolveSource = (input) => {
			calls.push(`resolve:${input.app.source.ref}:${input.expectedCommitSha ?? 'none'}`)
			resolutionSignal = input.signal
			return Promise.resolve({ commitSha: 'A'.repeat(40) })
		}
		provider.deploy = async (input) => {
			calls.push(`deploy:${input.app.source.ref}`)
			if (resolutionSignal === undefined) throw new Error('source was not resolved')
			expect(input.signal).toBe(resolutionSignal)
			inputs.push(input)
			return { state: 'succeeded' }
		}

		expect((await executeDeploy(makeDeps(db, provider), { runId })).status).toBe('succeeded')
		expect(calls).toEqual([
			'resolve:refs/heads/deploy/prod:none',
			`deploy:${'a'.repeat(40)}`,
		])
		expect((await requireRun(db, runId)).commit_sha).toBe('a'.repeat(40))
	})

	test('verifies an existing trigger commit and deploys that exact revision', async () => {
		const { db } = createHarness()
		const expected = 'b'.repeat(40)
		const runId = await seedRun(db, { commitSha: expected.toUpperCase() })
		const inputs: ProviderDeployInput[] = []
		const provider = makeProvider(inputs, { state: 'succeeded' })
		provider.resolveSource = (input) => {
			expect(input.expectedCommitSha).toBe(expected)
			return Promise.resolve({ commitSha: expected })
		}

		expect((await executeDeploy(makeDeps(db, provider), { runId })).status).toBe('succeeded')
		expect(inputs[0]?.app.source.ref).toBe(expected)
		expect((await requireRun(db, runId)).commit_sha).toBe(expected)
	})

	test('fails before deploy when source resolution returns an invalid or mismatched commit', async () => {
		for (const resolution of ['not-a-commit', 'c'.repeat(40)]) {
			const { db } = createHarness()
			const runId = await seedRun(db, { commitSha: 'b'.repeat(40) })
			const inputs: ProviderDeployInput[] = []
			const provider = makeProvider(inputs, { state: 'succeeded' })
			provider.resolveSource = () => Promise.resolve({ commitSha: resolution })

			expect((await executeDeploy(makeDeps(db, provider), { runId })).status).toBe('failed')
			expect(inputs).toEqual([])
			const failed = await requireRun(db, runId)
			expect(failed.status).toBe('failed')
			expect(failed.commit_sha).toBe('b'.repeat(40))
		}
	})

	test('does not resolve source during a dry run', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		const inputs: ProviderDeployInput[] = []
		const provider = makeProvider(inputs, { state: 'succeeded' })
		provider.resolveSource = () => Promise.reject(new Error('dry run must not resolve source'))

		expect((await executeDeploy(makeDeps(db, provider), { runId, dryRun: true })).status).toBe('succeeded')
		expect(inputs[0]?.app.source.ref).toBe('refs/heads/deploy/prod')
		expect((await requireRun(db, runId)).commit_sha).toBeNull()
	})

	test('atomically persists provider acceptance state and later checkpoints', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		const provider = makeProvider([], { state: 'succeeded' })
		provider.deploy = async (input) => {
			await input.events.externalId('operation-1', { phase: 'accepted', version: 7 })
			const accepted = await requireRun(db, runId)
			expect(accepted.external_run_id).toBe('operation-1')
			expect(JSON.parse(accepted.provider_state_json ?? '')).toEqual({ phase: 'accepted', version: 7 })
			await input.events.checkpoint({ phase: 'deployed', version: 7 })
			return { state: 'succeeded' }
		}

		expect((await executeDeploy(makeDeps(db, provider), { runId })).status).toBe('succeeded')
		expect(JSON.parse((await requireRun(db, runId)).provider_state_json ?? '')).toEqual({ phase: 'deployed', version: 7 })
	})

	test('guards provider acceptance identity, checkpoint order, size, and cancellation freeze', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		await db.runs.markRunStarted(runId, `runs/${runId}/logs.ndjson`)

		expect(await db.runs.checkpointRunProviderState(runId, { phase: 'too-early' })).toBe(false)
		expect(await db.runs.setRunExternalId(runId, 'operation-1', { phase: 'accepted' })).toBe(true)
		expect(await db.runs.setRunExternalId(runId, 'operation-1', { phase: 'replayed' })).toBe(true)
		expect(await db.runs.setRunExternalId(runId, 'operation-2', { phase: 'wrong-owner' })).toBe(false)
		expect(JSON.parse((await requireRun(db, runId)).provider_state_json ?? '')).toEqual({ phase: 'replayed' })
		await expect(db.runs.checkpointRunProviderState(runId, { payload: 'x'.repeat(17 * 1024) })).rejects.toThrow('16 KiB')

		const cancelling = await db.runs.beginRunCancellation(runId)
		expect(cancelling?.external_run_id).toBe('operation-1')
		expect(await db.runs.setRunCommit(runId, 'a'.repeat(40))).toBe(false)
		expect(await db.runs.setRunExternalId(runId, 'operation-1')).toBe(false)
		expect(await db.runs.checkpointRunProviderState(runId, { phase: 'late' })).toBe(false)
		expect(await db.runs.markRunFinished(runId, 'succeeded', 0)).toBe(false)
	})

	test('a cancellation during source resolution prevents provider deploy and Operations projection', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		const staleRun = await requireRun(db, runId)
		let enteredResolution = () => {}
		const resolutionEntered = new Promise<void>((resolve) => {
			enteredResolution = resolve
		})
		let finishResolution = () => {}
		const resolutionFinished = new Promise<void>((resolve) => {
			finishResolution = resolve
		})
		const inputs: ProviderDeployInput[] = []
		const provider = makeProvider(inputs, { state: 'succeeded' })
		provider.resolveSource = async () => {
			enteredResolution()
			await resolutionFinished
			return { commitSha: 'a'.repeat(40) }
		}
		const lock = makeFakeLock()
		const deps = makeDeps(db, provider, new EnvSecretResolver({}), lock)
		deps.operations = { repository: db.operationsReleases }

		const deploying = executeDeploy(deps, { runId })
		await resolutionEntered
		await cancelDeploy(deps, staleRun)
		finishResolution()

		expect(await deploying).toEqual({ runId, status: 'skipped' })
		expect(inputs).toEqual([])
		expect((await requireRun(db, runId)).status).toBe('failed')
		expect(await db.operationsReleases.get(runId)).toBeNull()
	})

	test('cancellation uses the latest checkpoint and suppresses a late provider success', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db, { commitSha: 'a'.repeat(40) })
		const staleRun = await requireRun(db, runId)
		let checkpointReady = () => {}
		const checkpointed = new Promise<void>((resolve) => {
			checkpointReady = resolve
		})
		let finishProvider = () => {}
		const providerFinished = new Promise<void>((resolve) => {
			finishProvider = resolve
		})
		const cancelledStates: unknown[] = []
		const provider = makeProvider([], { state: 'succeeded' })
		provider.deploy = async (input) => {
			await input.events.externalId('operation-1', { phase: 'accepted' })
			await input.events.checkpoint({ phase: 'uploaded', version: 3 })
			checkpointReady()
			await providerFinished
			return { state: 'succeeded' }
		}
		provider.cancel = (input) => {
			cancelledStates.push(input.providerState)
			return Promise.resolve()
		}
		const lock = makeFakeLock()
		const deps = makeDeps(db, provider, new EnvSecretResolver({}), lock)
		deps.operations = { repository: db.operationsReleases }

		const deploying = executeDeploy(deps, { runId })
		await checkpointed
		await cancelDeploy(deps, staleRun)
		finishProvider()

		expect(await deploying).toEqual({ runId, status: 'skipped' })
		expect(cancelledStates).toEqual([{ phase: 'uploaded', version: 3 }])
		expect((await requireRun(db, runId)).status).toBe('failed')
		const projection = await db.operationsReleases.get(runId)
		expect(projection?.payload_json).toContain('"phase":"provider_accepted"')
		expect(projection?.payload_json).not.toContain('"outcome":"succeeded"')
	})

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
			[FABRIKA_IAM_ISSUER]: null,
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
			[FABRIKA_IAM_ISSUER]: null,
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
			[FABRIKA_IAM_ISSUER]: null,
		})
	})

	test('delivers the installation issuer and refuses an application that names its own', async () => {
		// ADR-0035: the issuer is the `iss` of every token this app verifies and the platform is the only
		// thing that knows it, so it travels in `managedEnvironment` and an app variable of that name is a
		// deploy failure rather than a value that quietly wins or quietly loses.
		const { db } = createHarness()
		const runId = await seedRun(db)
		const inputs: ProviderDeployInput[] = []
		const deps = { ...makeDeps(db, makeProvider(inputs, { state: 'succeeded' })), iamIssuer: 'https://iam.example.test' }
		expect((await executeDeploy(deps, { runId })).status).toBe('succeeded')
		expect(inputs[0]?.managedEnvironment[FABRIKA_IAM_ISSUER]).toBe('https://iam.example.test')

		const conflicting = uuidv7()
		await db.registry.upsertAppVar({ appId: 'app', env: 'prod', name: FABRIKA_IAM_ISSUER, value: 'https://attacker.example' })
		await db.runs.createRun({
			id: conflicting,
			appId: 'app',
			env: 'prod',
			ref: 'refs/heads/deploy/prod',
			trigger: 'manual',
			commitSha: null,
		})
		const refused: ProviderDeployInput[] = []
		expect(
			(await executeDeploy({ ...makeDeps(db, makeProvider(refused, { state: 'succeeded' })), iamIssuer: 'https://iam.example.test' }, {
				runId: conflicting,
			})).status,
		).toBe('failed')
		expect(refused).toEqual([])
	})

	test('removes a stale issuer when the installation cannot name its own', async () => {
		// `null` is REMOVE. An installation with no issuer configured must strip whatever the previous one
		// wrote rather than leave an app verifying against another installation's tokens.
		const { db } = createHarness()
		const runId = await seedRun(db)
		const inputs: ProviderDeployInput[] = []
		expect((await executeDeploy(makeDeps(db, makeProvider(inputs, { state: 'succeeded' })), { runId })).status).toBe('succeeded')
		expect(inputs[0]?.managedEnvironment[FABRIKA_IAM_ISSUER]).toBeNull()
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
