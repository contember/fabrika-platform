import { ReconcileSchemaError } from '@fabrika/auth'
import {
	FABRIKA_IAM_APP_ID,
	FABRIKA_IAM_ISSUER,
	FABRIKA_OPS_KEY_DIGESTS,
	FABRIKA_PROXY_SECRET,
	opsKeyDigest,
	parseOpsKeyDigests,
} from '@fabrika/auth-core'
import { CHECKER_VERSION } from '@fabrika/check/contract'
import { FABRIKA_APP_ID, FABRIKA_ENVIRONMENT, FABRIKA_OPERATIONS_DSN, FABRIKA_SERVICE_KEY } from '@fabrika/operations-contract/ingest'
import { FABRIKA_RELEASE, parseOperationsReleasePayload } from '@fabrika/operations-contract/releases'
import { type BlobStore, uuidv7 } from '@fabrika/platform'
import type {
	ControlProvider,
	ProviderApprovedAccess,
	ProviderDeployInput,
	ProviderEnvelope,
	ProviderManagedEnvironment,
	ProviderRegistration,
	ProviderRegistrationInput,
	ProviderSourceBinding,
} from '@fabrika/provider-contract'
import { describe, expect, spyOn, test } from 'bun:test'
import { type CloudflareRunnerJob, createCloudflareControlProvider } from '../../../provider-cloudflare/src/control'
import { readProviderEnvelope } from '../api/provider-envelope'
import { getRunLogUseCase } from '../api/runs'
import type { ControlRepositories, RunRow } from '../db'
import { OperationsReleaseRepository } from '../db'
import type { Env } from '../env'
import type { IamSchemaPort } from '../iam-schema'
import { opsKeyPurpose, VaultOpsKeys } from '../ops-key'
import { reconcileProviderRuns } from '../provider-reconcile'
import { cancelDeploy, type DeployJobMessage, executeDeploy, parseProviderEnvelope, type RunDeps, type RunOutcome } from '../run-lifecycle'
import { appSecretPurpose, type SecretResolver, VaultSecretResolver } from '../secret-resolver'
import { buildControlRpcDeps, buildRunDeps } from '../services'
import { contractCommits } from './helpers/commits'
import { createHarness, queryRows } from './helpers/harness'
import { allowAllAuth } from './helpers/iam'
import { fixtureCatalogApplied, fixtureProtect, fixtureRuns, heldLeases, makeFakeLock } from './helpers/lock'
import { createTestVault, fixedProxySecrets, testVaultKey } from './helpers/vault'

const vault = await createTestVault()
const vaultSecrets = new VaultSecretResolver({ vault })

/** Seal a value the way `apps.secrets.put` does and return the ref the registry row stores. */
const sealAppSecret = (env: string | null, name: string, value: string): Promise<string> => {
	const purpose = appSecretPurpose('app', env, name)
	return vault.putSecret(purpose.scope, purpose.label, value)
}

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
			? {}
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
		crossOrigins: ['https://partner.example.org'],
		namespaceId: null,
		provider,
		providerTargetJson: JSON.stringify(provider === 'cloudflare' ? { provider, version: 1, payload: {} } : envelope(provider, 'target')),
		providerArtifactJson: JSON.stringify(
			provider === 'cloudflare'
				? { provider, version: 1, payload: { configPath: 'fabrika.config.ts' } }
				: envelope(provider, 'artifact'),
		),
	})
	// Unprotected, so each test's first contract publishes without an approval (ADR-0050).
	await fixtureProtect(db.registry, makeFakeLock(db), { appId: 'app', env: 'prod' }, false)
	await db.registry.upsertAppSecret({
		appId: 'app',
		env: null,
		name: 'API_KEY',
		valueRef: await sealAppSecret(null, 'API_KEY', 'all-env'),
	})
	await db.registry.upsertAppSecret({ appId: 'app', env: 'prod', name: 'API_KEY', valueRef: await sealAppSecret('prod', 'API_KEY', 'prod') })
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
		actor: 'user:test',
	})
	if (options.externalId !== undefined) {
		const owned = fixtureRuns(db.runs, makeFakeLock(db))
		await owned.start(runId, `runs/${runId}/logs.ndjson`)
		await owned.externalId(runId, options.externalId)
	}
	return runId
}

function insertSourceConnection(
	sqlite: ReturnType<typeof createHarness>['sqlite'],
	input: { connectionId: string; installationId: number },
): void {
	sqlite.query(`INSERT INTO github_source_connections_keyed (
		connection_id, app_id, app_slug, app_html_url, app_owner, app_name, app_public,
		app_credential_ref, webhook_url, webhook_secret_ref, installation_id,
		installation_account_login, installation_selection, verified_repositories_json,
		requested_repositories_json, connected_by, connected_at, verified_at, version
	) VALUES (?, 'github-app', 'github-app', 'https://github.com/apps/github-app', 'acme', 'github-app', 0,
		?, 'https://control.example.test/webhooks/github', 'vault:webhook', ?,
		'acme', 'all', '[]', '[]', 'operator', 1, 1, 1)`)
		.run(input.connectionId, 'vault:credential', input.installationId)
}

async function activateOperationsIngest(db: ControlRepositories): Promise<string> {
	await db.operationsCatalog.markDirty()
	const snapshot = await db.operationsCatalog.snapshot()
	const source = snapshot.sources[0]
	if (source === undefined) throw new Error('missing Operations catalog source')
	const dsn = `https://${source.public_key}@errors.example.test/100000000000000001`
	await fixtureCatalogApplied(db, snapshot.revision, 'snapshot-hash', [{
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
	options: {
		id?: string
		managedSecrets?: boolean
		cancelled?: string[]
		cancelledNamespaces?: string[]
	} = {},
): ControlProvider {
	const id = options.id ?? 'memory'
	return {
		id,
		normalizeRegistration: (input) => normalize(id, input),
		source: { binding: 'connection' },
		// The commit is pinned, so a non-dry deploy publishes the contract and hands over its approved access.
		resolveSource: () => Promise.resolve({ commitSha: 'a'.repeat(40) }),
		deploy: async (input) => {
			inputs.push(input)
			await input.events.externalId(`${id}-run-1`)
			return outcome
		},
		cancel: async (input) => {
			options.cancelled?.push(input.externalId)
			options.cancelledNamespaces?.push(input.environment.namespace?.id ?? 'none')
			return { state: 'settled' }
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
	secrets: SecretResolver = vaultSecrets,
	lock = makeFakeLock(db),
): RunDeps {
	return { repositories: db, provider, secrets, lock, logs: { put: () => Promise.resolve() }, commits: contractCommits('app') }
}

/** A provider that accepts a deploy and leaves it in flight, for a later settlement to finish. */
function inFlight(): ControlProvider {
	const provider = makeProvider([], { state: 'succeeded' })
	provider.deploy = async (input) => {
		await input.events.externalId('memory-run-1')
		return { state: 'running' }
	}
	return provider
}

/** A run the provider accepted and left in flight, its contract published. */
async function seedInFlightRun(db: ControlRepositories): Promise<string> {
	const runId = await seedRun(db)
	expect(await executeDeploy(makeDeps(db, inFlight()), { runId })).toEqual({ runId, status: 'running' })
	return runId
}

/** The environment's next run, after `seedRun`'s. */
async function createNextRun(db: ControlRepositories): Promise<string> {
	const runId = uuidv7()
	await db.runs.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'refs/heads/deploy/prod', trigger: 'manual', actor: 'user:test' })
	return runId
}

type IamApply = Parameters<IamSchemaPort['apply']>[0]

/** Control's IAM port, recording every schema it is asked to write. */
const recordingIam = (applied: IamApply[], answer: (input: IamApply) => Promise<void> = () => Promise.resolve()): IamSchemaPort => ({
	apply: (input) => {
		applied.push(input)
		return answer(input)
	},
})

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

/** What a deploy was handed, without the credential flags. */
const managedValues = (managed: ProviderManagedEnvironment | undefined): Record<string, string | null> =>
	Object.fromEntries(Object.entries(managed ?? {}).map(([name, entry]) => [name, entry.value]))

const requireRun = async (db: ControlRepositories, id: string): Promise<RunRow> => {
	const run = await db.runs.getRun(id)
	if (run === null) {
		throw new Error(`missing run ${id}`)
	}
	return run
}

describe('provider-neutral run lifecycle', () => {
	test('loads and carries the exact keyed source binding through resolve and deploy', async () => {
		const { db, sqlite } = createHarness()
		insertSourceConnection(sqlite, { connectionId: 'connection-1', installationId: 42 })
		const runId = await seedRun(db, {
			provider: 'zerops',
			sourceBinding: { connectionId: 'connection-1', installationId: 42 },
		})
		const seen: Array<{ phase: string; binding: ProviderSourceBinding | undefined }> = []
		const provider: ControlProvider = {
			id: 'zerops',
			normalizeRegistration: (input) => normalize('zerops', input),
			source: { binding: 'connection' },
			resolveSource: (input) => {
				seen.push({ phase: 'resolve', binding: input.sourceBinding })
				return Promise.resolve({ commitSha: 'a'.repeat(40) })
			},
			deploy: async (input) => {
				seen.push({ phase: 'deploy', binding: input.sourceBinding })
				await input.events.externalId('version-1')
				return { state: 'succeeded' }
			},
		}

		expect((await executeDeploy(makeDeps(db, provider), { runId })).status).toBe('succeeded')
		expect(seen).toEqual([
			{ phase: 'resolve', binding: { connectionId: 'connection-1', installationId: 42 } },
			{ phase: 'deploy', binding: { connectionId: 'connection-1', installationId: 42 } },
		])
	})

	test('fails before provider source effects on partial, missing, stale, or swapped connection bindings', async () => {
		const cases: Array<{
			kind: string
			appBinding?: { connectionId: string; installationId: number }
			storedBinding?: { connectionId: string; installationId: number }
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
				storedBinding: { connectionId: 'connection-1', installationId: 42 },
			},
			{
				kind: 'swapped-connection',
				appBinding: { connectionId: 'connection-2', installationId: 42 },
				storedBinding: { connectionId: 'connection-1', installationId: 42 },
			},
		]
		for (const current of cases) {
			const { db, sqlite } = createHarness()
			if (current.storedBinding !== undefined) insertSourceConnection(sqlite, current.storedBinding)
			const runId = await seedRun(db, { provider: 'memory' })
			sqlite.query(`UPDATE app_envs SET provider = 'zerops' WHERE app_id = 'app' AND env = 'prod'`).run()
			// Written past the registry, which refuses an invalid binding at environment upsert.
			if (current.appBinding !== undefined) {
				sqlite.query(`UPDATE apps SET repo_url = 'github.com/acme/app', github_connection_id = ?, github_installation_id = ? WHERE id = 'app'`)
					.run(current.appBinding.connectionId, current.appBinding.installationId)
			}
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

	test('Cloudflare persists a manual commit before release projection and carries the keyed source binding', async () => {
		const { db, d1, sqlite } = createHarness()
		insertSourceConnection(sqlite, { connectionId: 'connection-1', installationId: 42 })
		const runId = await seedRun(db, { provider: 'cloudflare', sourceBinding: { connectionId: 'connection-1', installationId: 42 } })
		const commitSha = 'a'.repeat(40)
		const jobs: CloudflareRunnerJob[] = []
		const phases: string[] = []
		const persistedAtProjection: Array<string | null> = []
		const projectedCommits: Array<string | null> = []
		const releases = new class extends OperationsReleaseRepository {
			override async project(id: string, raw: string): Promise<number> {
				const payload = parseOperationsReleasePayload(JSON.parse(raw))
				phases.push(payload.phase)
				persistedAtProjection.push((await requireRun(db, id)).commit_sha)
				projectedCommits.push(payload.release.kind === 'available' ? payload.release.commitSha : null)
				return super.project(id, raw)
			}
		}(d1)
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			resolveSource: async (input) => {
				expect(input.expectedCommitSha).toBeUndefined()
				expect(input.app.source).toMatchObject({ ref: 'refs/heads/deploy/prod' })
				expect(input.sourceBinding).toEqual({ connectionId: 'connection-1', installationId: 42 })
				return { commitSha }
			},
			prepareClone: async (source, _signal, sourceBinding) => {
				expect(source.ref).toBe(commitSha)
				expect(sourceBinding).toEqual({ connectionId: 'connection-1', installationId: 42 })
				return { repoUrl: source.repoUrl }
			},
			startRun: async (job) => {
				jobs.push(job)
				return { state: 'succeeded' }
			},
			cancelRun: async () => {},
		})
		try {
			// The Cloudflare provider reads the snapshot at the app's `workerDir`.
			const deps = {
				...makeDeps(db, provider),
				proxySecrets: fixedProxySecrets,
				commits: contractCommits('app', 'worker'),
				operations: { repository: releases },
			}
			expect((await executeDeploy(deps, { runId })).status).toBe('succeeded')
			expect(phases).toEqual(['started', 'provider_accepted', 'terminal'])
			expect(persistedAtProjection).toEqual([commitSha, commitSha, commitSha])
			expect(projectedCommits).toEqual([commitSha, commitSha, commitSha])
			expect(jobs).toHaveLength(1)
			expect(jobs[0]?.ref).toBe(commitSha)
			expect(jobs[0]?.managedEnvironment?.[FABRIKA_RELEASE]).toContain(commitSha)
			expect((await requireRun(db, runId)).ref).toBe('refs/heads/deploy/prod')
		} finally {
			sqlite.close()
		}
	})

	test('Cloudflare refuses a resolved commit that differs from recorded history before clone, admission, or runner submission', async () => {
		const { db, d1, sqlite } = createHarness()
		const commitSha = 'a'.repeat(40)
		const runId = await seedRun(db, { provider: 'cloudflare', commitSha })
		const effects: string[] = []
		const phases: string[] = []
		const releases = new class extends OperationsReleaseRepository {
			override project(id: string, raw: string): Promise<number> {
				phases.push(parseOperationsReleasePayload(JSON.parse(raw)).phase)
				return super.project(id, raw)
			}
		}(d1)
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			resolveSource: async (input) => {
				expect(input.expectedCommitSha).toBe(commitSha)
				return { commitSha: 'b'.repeat(40) }
			},
			prepareClone: async (source) => {
				effects.push('clone')
				return { repoUrl: source.repoUrl }
			},
			startRun: async () => {
				effects.push('runner')
				return { state: 'succeeded' }
			},
			cancelRun: async () => {},
		})
		try {
			expect((await executeDeploy({ ...makeDeps(db, provider), operations: { repository: releases } }, { runId })).status).toBe('failed')
			expect(effects).toEqual([])
			expect(phases).toEqual(['terminal'])
			const failed = await requireRun(db, runId)
			expect(failed).toMatchObject({ status: 'failed', ref: 'refs/heads/deploy/prod', commit_sha: commitSha, external_run_id: null })
		} finally {
			sqlite.close()
		}
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

	test('records why a run failed in its run log, without a credential the cause carried', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		const provider = makeProvider([], { state: 'succeeded' })
		provider.resolveSource = () =>
			Promise.reject(new Error('source resolve failed (ref_not_found) at https://x-access-token:ghs_leaked@github.com/acme/notes.git'))
		const deps = makeDeps(db, provider)
		const stored = memoryLogs()
		deps.logs = stored.logs

		expect((await executeDeploy(deps, { runId })).status).toBe('failed')
		const response = await getRunLogUseCase({ repositories: db, logs: stored.logs, auth: allowAllAuth() }, runId)
		expect(response.status).toBe('failed')
		expect(response.lines.map((line) => line.text)).toEqual([
			'deploy failed: source resolve failed (ref_not_found) at https://github.com/acme/notes.git',
		])
		expect(stored.objects.get(`runs/${runId}/logs.ndjson`)).not.toContain('ghs_leaked')
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
		const owned = fixtureRuns(db.runs, makeFakeLock(db))
		await owned.start(runId, `runs/${runId}/logs.ndjson`)

		expect(await owned.checkpoint(runId, { phase: 'too-early' })).toBe(false)
		expect(await owned.externalId(runId, 'operation-1', { phase: 'accepted' })).toBe(true)
		expect(await owned.externalId(runId, 'operation-1', { phase: 'replayed' })).toBe(false)
		expect(await owned.externalId(runId, 'operation-2', { phase: 'wrong-owner' })).toBe(false)
		expect(JSON.parse((await requireRun(db, runId)).provider_state_json ?? '')).toEqual({ phase: 'accepted' })
		await expect(owned.checkpoint(runId, { payload: 'x'.repeat(17 * 1024) })).rejects.toThrow('16 KiB')

		const cancelling = await db.runs.requestRunCancellation(runId)
		expect(cancelling?.external_run_id).toBe('operation-1')
		expect(await owned.commit(runId, 'a'.repeat(40))).toBe(false)
		expect(await owned.externalId(runId, 'operation-1')).toBe(false)
		expect(await owned.checkpoint(runId, { phase: 'late' })).toBe(false)
		expect(await owned.finish(runId, 'succeeded', 0)).toBe(false)
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
		const lock = makeFakeLock(db)
		const deps = makeDeps(db, provider, vaultSecrets, lock)
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
			return Promise.resolve({ state: 'settled' })
		}
		const lock = makeFakeLock(db)
		const deps = makeDeps(db, provider, vaultSecrets, lock)
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
		const lock = makeFakeLock(db)
		const message: DeployJobMessage = { runId, dryRun: true }

		const result = await executeDeploy(
			makeDeps(db, makeProvider(inputs, { state: 'succeeded', exitCode: 0 }), vaultSecrets, lock),
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
			},
		})
		expect(input.sourceBinding).toBeUndefined()
		expect(input.environment.domain).toBe('app.example.com')
		expect(input.environment.publicOrigin).toBe('https://public.example.com')
		expect(input.environment.crossOrigins).toEqual(['https://partner.example.org'])
		expect(input.secrets).toEqual({ API_KEY: 'prod' })
		expect(input.vars).toEqual({ TEAM: 'prod' })
		expect(managedValues(input.managedEnvironment)).toEqual({
			[FABRIKA_OPERATIONS_DSN]: null,
			[FABRIKA_APP_ID]: null,
			[FABRIKA_ENVIRONMENT]: null,
			[FABRIKA_SERVICE_KEY]: null,
			[FABRIKA_RELEASE]: null,
			[FABRIKA_IAM_ISSUER]: null,
			[FABRIKA_IAM_APP_ID]: 'app@prod',
			[FABRIKA_PROXY_SECRET]: null,
			FABRIKA_IAM_RPC_URL: null,
			FABRIKA_IAM_RPC_KEY: null,
			// The environment's public origin is the canonical origin `ctx.url` builds links on.
			FABRIKA_APP_ORIGIN: 'https://public.example.com',
			FABRIKA_TOKEN_KEYS: null,
			FABRIKA_OPS_KEY_DIGESTS: null,
		})
		// Control marks each credential once, so a provider writes it as a secret without a rule of its own.
		expect(Object.keys(input.managedEnvironment).filter((name) => input.managedEnvironment[name]?.credential).sort()).toEqual([
			FABRIKA_OPERATIONS_DSN,
			FABRIKA_PROXY_SECRET,
			FABRIKA_SERVICE_KEY,
			'FABRIKA_IAM_RPC_KEY',
			'FABRIKA_TOKEN_KEYS',
		].sort())
		expect(input.dryRun).toBe(true)

		const run = await requireRun(db, runId)
		expect(run.status).toBe('succeeded')
		expect(run.exit_code).toBe(0)
		expect(run.external_run_id).toBe('memory-run-1')
		expect(run.log_key).toBe(`runs/${runId}/logs.ndjson`)
		expect(await heldLeases(db)).toEqual([])
	})

	test('deploys the stored registration unchanged when the provider does not normalize registrations', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		const inputs: ProviderDeployInput[] = []
		const { normalizeRegistration: _normalize, ...provider } = makeProvider(inputs, { state: 'succeeded', exitCode: 0 })

		expect(await executeDeploy(makeDeps(db, provider), { runId, dryRun: true })).toEqual({ runId, status: 'succeeded' })
		expect(inputs.map((input) => input.environment)).toEqual([{
			appId: 'app',
			env: 'prod',
			domain: 'app.example.com',
			publicOrigin: 'https://public.example.com',
			crossOrigins: ['https://partner.example.org'],
			target: envelope('memory', 'target'),
			artifact: envelope('memory', 'artifact'),
		}])
	})

	test('persists provider log lines as ordered NDJSON readable through the run log use case', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		// An active ingest config keeps the deploy from adding its own catalog-gap line, so the writes
		// this test choreographs are the provider's alone.
		await activateOperationsIngest(db)
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
		const response = await getRunLogUseCase({ repositories: db, logs: stored.logs, auth: allowAllAuth() }, runId)
		expect(response.status).toBe('succeeded')
		expect(response.lines.map(({ stream, text }) => ({ stream, text }))).toEqual([
			{
				stream: 'meta',
				text: 'access: access widens (3 changes, 3 widening, 0 narrowing, 0 unchanged, 0 needing closer review; against nothing published)',
			},
			{ stream: 'meta', text: 'access: published as generation 2 of `prod`' },
			{ stream: 'meta', text: 'checking source' },
			{ stream: 'meta', text: 'deploy complete' },
		])
		expect(response.lines.every((line) => Number.isFinite(line.ts))).toBe(true)
	})

	test('does not overwrite an existing runner log when the provider emits no control-side lines', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		await activateOperationsIngest(db)
		const key = `runs/${runId}/logs.ndjson`
		const runnerContents = '{"ts":1,"stream":"stdout","text":"runner-owned"}\n'
		const stored = memoryLogs({ [key]: runnerContents })
		const deps = makeDeps(db, makeProvider([], { state: 'succeeded' }))
		deps.logs = stored.logs

		// A dry run publishes nothing, so Control has no line of its own to write.
		expect((await executeDeploy(deps, { runId, dryRun: true })).status).toBe('succeeded')
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
		await activateOperationsIngest(db)
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
		// Each refused flush says so once, in the same words.
		expect(new Set(errors)).toEqual(new Set([`deploy run ${runId}: failed to persist log output`]))
		expect(errors.join('\n')).not.toContain('credential-must-not-leak')
	})

	test('injects only an active Operations configuration and leaves application vars separate', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		await db.operationsCatalog.markDirty()
		await db.operationsCatalog.snapshot()
		const pendingInputs: ProviderDeployInput[] = []
		expect((await executeDeploy(makeDeps(db, makeProvider(pendingInputs, { state: 'succeeded' })), { runId })).status).toBe('succeeded')
		expect(managedValues(pendingInputs[0]?.managedEnvironment)).toEqual({
			[FABRIKA_OPERATIONS_DSN]: null,
			[FABRIKA_APP_ID]: null,
			[FABRIKA_ENVIRONMENT]: null,
			[FABRIKA_SERVICE_KEY]: null,
			[FABRIKA_RELEASE]: null,
			[FABRIKA_IAM_ISSUER]: null,
			[FABRIKA_IAM_APP_ID]: 'app@prod',
			[FABRIKA_PROXY_SECRET]: null,
			FABRIKA_IAM_RPC_URL: null,
			FABRIKA_IAM_RPC_KEY: null,
			FABRIKA_APP_ORIGIN: 'https://public.example.com',
			FABRIKA_TOKEN_KEYS: null,
			FABRIKA_OPS_KEY_DIGESTS: null,
		})
		expect(pendingInputs[0]?.environment.operationsOrigin).toBeUndefined()

		const secondRunId = uuidv7()
		await db.runs.createRun({
			id: secondRunId,
			appId: 'app',
			env: 'prod',
			ref: 'refs/heads/deploy/prod',
			trigger: 'manual',
			actor: 'user:test',
		})
		const dsn = await activateOperationsIngest(db)
		const activeInputs: ProviderDeployInput[] = []
		expect((await executeDeploy(makeDeps(db, makeProvider(activeInputs, { state: 'succeeded' })), { runId: secondRunId })).status).toBe(
			'succeeded',
		)
		expect(activeInputs[0]?.vars).toEqual({ TEAM: 'prod' })
		expect(managedValues(activeInputs[0]?.managedEnvironment)).toEqual({
			[FABRIKA_OPERATIONS_DSN]: dsn,
			[FABRIKA_APP_ID]: 'app',
			[FABRIKA_ENVIRONMENT]: 'prod',
			[FABRIKA_SERVICE_KEY]: 'default',
			[FABRIKA_RELEASE]: null,
			[FABRIKA_IAM_ISSUER]: null,
			[FABRIKA_IAM_APP_ID]: 'app@prod',
			[FABRIKA_PROXY_SECRET]: null,
			FABRIKA_IAM_RPC_URL: null,
			FABRIKA_IAM_RPC_KEY: null,
			FABRIKA_APP_ORIGIN: 'https://public.example.com',
			FABRIKA_TOKEN_KEYS: null,
			FABRIKA_OPS_KEY_DIGESTS: null,
		})
		// The origin a proxy's `connect-src` admits, stated by Control so no provider parses the DSN for it.
		expect(activeInputs[0]?.environment.operationsOrigin).toBe(new URL(dsn).origin)
	})

	test('refuses a deploy without the access Control approved before the provider is asked', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		const inputs: ProviderDeployInput[] = []
		// A provider that resolves no source publishes no contract, so nothing is approved for its deploy.
		const { resolveSource: _resolve, ...unpinned } = makeProvider(inputs, { state: 'succeeded' })
		const stored = memoryLogs()
		const deps = { ...makeDeps(db, unpinned), logs: stored.logs }
		expect((await executeDeploy(deps, { runId })).status).toBe('failed')
		expect(inputs).toEqual([])
		expect(stored.objects.get(`runs/${runId}/logs.ndjson`)).toContain('a deploy needs the access Control approved for this environment')
		// A dry run deploys nothing, so it needs no approval.
		expect((await executeDeploy(deps, { runId: await createNextRun(db), dryRun: true })).status).toBe('succeeded')
	})

	test('delivers the proxy secret without a namespace proxy only to a provider whose own hop carries it', async () => {
		const secrets = { forAppEnv: (app: string, env: string) => Promise.resolve(`secret-of-${app}@${env}`) }
		for (const [hop, expected] of [[false, null], [true, 'secret-of-app@prod']] as const) {
			const { db } = createHarness()
			const runId = await seedRun(db)
			const inputs: ProviderDeployInput[] = []
			const provider = makeProvider(inputs, { state: 'succeeded' })
			const deps: RunDeps = { ...makeDeps(db, hop ? { ...provider, applicationHopSecret: true } : provider), proxySecrets: secrets }
			expect((await executeDeploy(deps, { runId })).status).toBe('succeeded')
			expect(inputs[0]?.managedEnvironment[FABRIKA_PROXY_SECRET]?.value).toBe(expected)
		}
	})

	test('refuses a deploy whose own hop needs a proxy secret when none is configured, and a dry run needs none', async () => {
		const { db } = createHarness()
		const inputs: ProviderDeployInput[] = []
		const stored = memoryLogs()
		const deps: RunDeps = { ...makeDeps(db, { ...makeProvider(inputs, { state: 'succeeded' }), applicationHopSecret: true }), logs: stored.logs }
		const runId = await seedRun(db)
		expect((await executeDeploy(deps, { runId })).status).toBe('failed')
		expect(inputs).toEqual([])
		expect(stored.objects.get(`runs/${runId}/logs.ndjson`)).toContain('needs its proxy secret')
		expect((await executeDeploy(deps, { runId: await createNextRun(db), dryRun: true })).status).toBe('succeeded')
		expect(inputs[0]?.managedEnvironment[FABRIKA_PROXY_SECRET]?.value).toBeNull()
	})

	test('hands the ops key digests only at a release the provider serves the ops channel at, and null otherwise', async () => {
		const { db } = createHarness()
		const opsKeys = new VaultOpsKeys(db.opsKeys, () => Promise.resolve(vault))
		const asked: string[] = []
		let handedInput: ProviderDeployInput | undefined
		const deploy = async (runId: string, serves: boolean | undefined, dryRun = false): Promise<string | null | undefined> => {
			const inputs: ProviderDeployInput[] = []
			const provider = makeProvider(inputs, { state: 'succeeded' })
			const opsChannel = (access: ProviderApprovedAccess): boolean => {
				asked.push(access.checker)
				return serves === true
			}
			const deps: RunDeps = { ...makeDeps(db, serves === undefined ? provider : { ...provider, opsChannel }), opsKeys }
			expect((await executeDeploy(deps, dryRun ? { runId, dryRun } : { runId })).status).toBe('succeeded')
			handedInput = inputs[0]
			return inputs[0]?.managedEnvironment[FABRIKA_OPS_KEY_DIGESTS]?.value
		}
		// A provider without the capability, and a release it does not serve, get no key.
		expect(await deploy(await seedRun(db), undefined)).toBeNull()
		expect(await deploy(await createNextRun(db), false)).toBeNull()
		expect(await db.opsKeys.list('app', 'prod')).toEqual([])
		// The provider judges the approved access, whose checker names the application's release.
		expect(asked).toEqual([CHECKER_VERSION])

		const gatedRun = await createNextRun(db)
		const digests = await deploy(gatedRun, true)
		const [issued] = await db.opsKeys.list('app', 'prod')
		expect(issued?.handed_by).toBe(gatedRun)
		expect(digests).toBe(issued?.digest)
		expect(parseOpsKeyDigests(digests ?? '')).toEqual([issued?.digest ?? ''])
		// The issuing deploy succeeded, so Control calls with the key whose digest it handed; a digest is no credential.
		expect((await opsKeys.opsKeysFor('app', 'prod')).map(opsKeyDigest)).toEqual([issued?.digest])
		expect(handedInput?.managedEnvironment[FABRIKA_OPS_KEY_DIGESTS]?.credential).toBe(false)

		// A dry run issues nothing and hands nothing.
		expect(await deploy(await createNextRun(db), true, true)).toBeNull()
		// A downgrade hands null, which removes the digests; the key stays for a later upgrade.
		expect(await deploy(await createNextRun(db), false)).toBeNull()
		expect(await db.opsKeys.list('app', 'prod')).toHaveLength(1)
	})

	test('an environment without a domain has no ops channel, so its deploy issues no key', async () => {
		const { db, sqlite } = createHarness()
		const runId = await seedRun(db)
		sqlite.query(`UPDATE app_envs SET domain = NULL WHERE app_id = 'app' AND env = 'prod'`).run()
		const inputs: ProviderDeployInput[] = []
		const opsKeys = new VaultOpsKeys(db.opsKeys, () => Promise.resolve(vault))
		const deps: RunDeps = { ...makeDeps(db, { ...makeProvider(inputs, { state: 'succeeded' }), opsChannel: () => true }), opsKeys }
		expect((await executeDeploy(deps, { runId })).status).toBe('succeeded')
		expect(inputs[0]?.managedEnvironment[FABRIKA_OPS_KEY_DIGESTS]?.value).toBeNull()
		expect(await db.opsKeys.list('app', 'prod')).toEqual([])
	})

	test("the composed run dependencies keep the ops key in the installation's vault", async () => {
		const harness = createHarness()
		const { db } = harness
		const runId = await seedRun(db)
		// `seedRun` seals the app secrets in another vault than the installation's this test composes.
		harness.sqlite.query('DELETE FROM app_secrets').run()
		const inputs: ProviderDeployInput[] = []
		const env: Env = {
			DB: harness.d1,
			REPOSITORIES: db,
			ASSETS: { fetch: () => Promise.reject(new Error('unexpected asset read')) },
			RUN_LOGS: memoryLogs().logs,
			COMMITS: contractCommits('app'),
			DEPLOY_QUEUE: { send: () => Promise.resolve() },
			WAIT_UNTIL: () => {},
			ENVIRONMENT: 'test',
			FABRIKA_CONTROL_VAULT_KEY: testVaultKey(),
		}
		const deps = await buildRunDeps(env, { ...makeProvider(inputs, { state: 'succeeded' }), opsChannel: () => true })
		expect((await executeDeploy(deps, { runId })).status).toBe('succeeded')
		const [issued] = await db.opsKeys.list('app', 'prod')
		expect(inputs[0]?.managedEnvironment[FABRIKA_OPS_KEY_DIGESTS]?.value).toBe(issued?.digest)
		expect(queryRows(harness.sqlite, 'SELECT label FROM vault WHERE id = ?', (issued?.value_ref ?? '').replace(/^vault:/, ''))).toEqual([
			{ label: opsKeyPurpose('app', 'prod', issued?.key_id ?? '').label },
		])

		// The composed RPC deps present that same key to the environment's domain.
		const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))
		let sent: { url: string; authorization: string | null }[] = []
		try {
			const transport = buildControlRpcDeps(env, makeProvider(inputs, { state: 'succeeded' }), allowAllAuth()).opsTransport
			const answer = await transport?.inspect({ appId: 'app', env: 'prod' }, { object: 'application', content: false }, new AbortController().signal)
			expect(answer).toEqual({ kind: 'unavailable', reason: 'unreachable' })
			sent = fetchSpy.mock.calls.map(([input, init]) => ({ url: String(input), authorization: new Headers(init?.headers).get('authorization') }))
		} finally {
			fetchSpy.mockRestore()
		}
		expect(sent.map(({ url }) => url)).toEqual(['https://app.example.com/__fabrika/ops/inspect'])
		expect(opsKeyDigest((sent[0]?.authorization ?? '').replace(/^Bearer /, ''))).toBe(issued?.digest ?? '')
	})

	test('refuses a gated deploy when Control can keep no ops key, and a dry run needs none', async () => {
		const { db } = createHarness()
		const inputs: ProviderDeployInput[] = []
		const stored = memoryLogs()
		const deps: RunDeps = { ...makeDeps(db, { ...makeProvider(inputs, { state: 'succeeded' }), opsChannel: () => true }), logs: stored.logs }
		const runId = await seedRun(db)
		expect((await executeDeploy(deps, { runId })).status).toBe('failed')
		expect(inputs).toEqual([])
		expect(stored.objects.get(`runs/${runId}/logs.ndjson`)).toContain('FABRIKA_CONTROL_VAULT_KEY')
		expect((await executeDeploy(deps, { runId: await createNextRun(db), dryRun: true })).status).toBe('succeeded')
		expect(inputs[0]?.managedEnvironment[FABRIKA_OPS_KEY_DIGESTS]?.value).toBeNull()
	})

	test('delivers the IAM application id of the deploying environment, <app>@<env>', async () => {
		// ADR-0022 rule 6: the proxy mints for `app@prod`, so the application must verify that audience.
		const { db } = createHarness()
		const runId = await seedRun(db)
		const inputs: ProviderDeployInput[] = []
		expect((await executeDeploy(makeDeps(db, makeProvider(inputs, { state: 'succeeded' })), { runId })).status).toBe('succeeded')
		expect(inputs[0]?.managedEnvironment[FABRIKA_IAM_APP_ID]?.value).toBe('app@prod')
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
		expect(inputs[0]?.managedEnvironment[FABRIKA_IAM_ISSUER]?.value).toBe('https://iam.example.test')

		const conflicting = uuidv7()
		await db.registry.upsertAppVar({ appId: 'app', env: 'prod', name: FABRIKA_IAM_ISSUER, value: 'https://attacker.example' })
		await db.runs.createRun({
			id: conflicting,
			appId: 'app',
			env: 'prod',
			ref: 'refs/heads/deploy/prod',
			trigger: 'manual',
			actor: 'user:test',
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

	test('refuses a reserved SECRET name before the provider is invoked, exactly as it refuses a variable', async () => {
		// The registry surface refuses these names too; this is the belt for a row that predates that check
		// or arrived through a provider-managed target.
		const { db } = createHarness()
		for (const name of [FABRIKA_IAM_ISSUER, FABRIKA_IAM_APP_ID, FABRIKA_RELEASE, FABRIKA_OPERATIONS_DSN]) {
			const runId = await seedRun(db)
			await db.registry.upsertAppSecret({ appId: 'app', env: 'prod', name, valueRef: await sealAppSecret('prod', name, 'attacker') })
			const refused: ProviderDeployInput[] = []
			const deps = makeDeps(db, makeProvider(refused, { state: 'succeeded' }))
			const stored = memoryLogs()
			deps.logs = stored.logs

			expect(`${name}: ${(await executeDeploy(deps, { runId })).status}`).toBe(`${name}: failed`)
			expect(refused).toEqual([])
			expect(stored.objects.get(`runs/${runId}/logs.ndjson`)).toContain(
				`delete it with \`fabrika control apps secrets delete --app=app --name=${name}\``,
			)
			await db.registry.deleteAppSecret('app', 'prod', name)
			await db.registry.deleteApp('app')
		}
	})

	test('removes a stale issuer when the installation cannot name its own', async () => {
		// `null` is REMOVE. An installation with no issuer configured must strip whatever the previous one
		// wrote rather than leave an app verifying against another installation's tokens.
		const { db } = createHarness()
		const runId = await seedRun(db)
		const inputs: ProviderDeployInput[] = []
		expect((await executeDeploy(makeDeps(db, makeProvider(inputs, { state: 'succeeded' })), { runId })).status).toBe('succeeded')
		expect(inputs[0]?.managedEnvironment[FABRIKA_IAM_ISSUER]?.value).toBeNull()
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

	// ── The approved IAM schema (ADR-0011) and its return origins (ADR-0022) ─────────
	//
	// Control writes a succeeded run's approved schema under `<app>@<env>`, with the deploying environment's own return
	// origin, before the row turns terminal, whichever provider ran it.

	test('a succeeded deploy writes the approved schema with only its own environment origin, before the row turns terminal', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		// A second environment of the SAME app, plus a third with no public origin at all. IAM's registry
		// is keyed by `<app>@<env>`, so `stage`'s origin registered under `app@prod` would hand it prod sessions.
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
		const applied: IamApply[] = []
		const statuses: string[] = []
		const iamSchema = recordingIam(applied, async (input) => {
			statuses.push((await requireRun(db, runId)).status)
			expect(input.signal.aborted).toBe(false)
		})

		expect((await executeDeploy({ ...makeDeps(db, makeProvider(inputs, { state: 'succeeded' })), iamSchema }, { runId })).status).toBe(
			'succeeded',
		)
		expect(applied).toHaveLength(1)
		expect(applied[0]).toMatchObject({ app: 'app@prod', returnOrigins: ['https://public.example.com'] })
		const access = inputs[0]?.environment.access
		if (access === undefined) throw new Error('expected the approved access to reach the provider')
		expect(applied[0]?.schema).toEqual(access.schema)
		expect(statuses).toEqual(['running'])

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
		const secondRunId = await createNextRun(db)
		const moved: IamApply[] = []
		expect(
			(await executeDeploy({ ...makeDeps(db, makeProvider([], { state: 'succeeded' })), iamSchema: recordingIam(moved) }, {
				runId: secondRunId,
			}))
				.status,
		).toBe('succeeded')
		expect(moved.map((input) => input.returnOrigins)).toEqual([['https://moved.example.com']])
	})

	test('leaves an environment with no public origin unregistered rather than guessing one', async () => {
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
		const applied: IamApply[] = []

		expect(
			(await executeDeploy({ ...makeDeps(db, makeProvider(inputs, { state: 'succeeded' })), iamSchema: recordingIam(applied) }, { runId }))
				.status,
		).toBe('succeeded')
		// Absent, not empty: an empty set is a caller error at the admin API and would read as "clear it".
		expect(applied).toHaveLength(1)
		expect(applied[0]).not.toHaveProperty('returnOrigins')
		expect(inputs[0]?.environment.domain).toBe('app.example.com')
	})

	test('an IAM that does not take the schema fails an awaited deploy, with the reason in its run log', async () => {
		for (const failure of [new Error('connect ECONNREFUSED'), new ReconcileSchemaError('unknown action notes.write', 400)]) {
			const { db } = createHarness()
			const runId = await seedRun(db)
			const stored = memoryLogs()
			const deps: RunDeps = {
				...makeDeps(db, makeProvider([], { state: 'succeeded' })),
				logs: stored.logs,
				iamSchema: recordingIam([], () => Promise.reject(failure)),
			}

			expect((await executeDeploy(deps, { runId })).status).toBe('failed')
			const failed = await requireRun(db, runId)
			expect(failed.status).toBe('failed')
			expect(failed.exit_code).toBeNull()
			const response = await getRunLogUseCase({ repositories: db, logs: stored.logs, auth: allowAllAuth() }, runId)
			expect(response.lines.map((line) => line.text)).toContain(`reconcile-schema failed: ${failure.message}`)
		}
	})

	test('a dry run writes no schema and says what it would write', async () => {
		const { db } = createHarness()
		const published = await seedRun(db)
		expect((await executeDeploy(makeDeps(db, makeProvider([], { state: 'succeeded' })), { runId: published })).status).toBe('succeeded')
		const runId = await createNextRun(db)
		const applied: IamApply[] = []
		const stored = memoryLogs()
		const deps: RunDeps = { ...makeDeps(db, makeProvider([], { state: 'succeeded' })), logs: stored.logs, iamSchema: recordingIam(applied) }

		expect(await executeDeploy(deps, { runId, dryRun: true })).toEqual({ runId, status: 'succeeded' })
		expect(applied).toEqual([])
		const response = await getRunLogUseCase({ repositories: db, logs: stored.logs, auth: allowAllAuth() }, runId)
		// `seedRun`'s secret value is `prod`, so the run log redacts the environment name in `app@prod`.
		expect(response.lines.map((line) => line.text)).toContain('[dry-run] would reconcile the authz schema of `app@[redacted]` with IAM')
	})

	test('a reconcile writes the schema before it settles the run; an unavailable IAM keeps it running for the next pass', async () => {
		const { db } = createHarness()
		const runId = await seedInFlightRun(db)
		const stored = memoryLogs()

		const provider = makeProvider([], { state: 'succeeded' })
		provider.reconcile = () => Promise.resolve({ state: 'succeeded', exitCode: 0 })
		const applied: IamApply[] = []
		const statuses: string[] = []
		let available = false
		const iamSchema = recordingIam(applied, async () => {
			statuses.push((await requireRun(db, runId)).status)
			if (!available) throw new ReconcileSchemaError('IAM is restarting', 503)
		})
		const settling = { repositories: db, provider, lock: makeFakeLock(db), runLogs: stored.logs, iamSchema }

		expect(await reconcileProviderRuns(settling)).toMatchObject({ checked: 1, inProgress: 1, succeeded: 0 })
		expect((await requireRun(db, runId)).status).toBe('running')
		const response = await getRunLogUseCase({ repositories: db, logs: stored.logs, auth: allowAllAuth() }, runId)
		expect(response.lines.map((line) => line.text)).toContain('reconcile-schema failed: IAM is restarting')

		available = true
		expect(await reconcileProviderRuns(settling)).toMatchObject({ checked: 1, succeeded: 1 })
		expect(await requireRun(db, runId)).toMatchObject({ status: 'succeeded', exit_code: 0 })
		expect(applied.map((input) => input.app)).toEqual(['app@prod', 'app@prod'])
		expect(statuses).toEqual(['running', 'running'])
	})

	test('an IAM refusal on reconcile fails the run instead of retrying it forever', async () => {
		const { db } = createHarness()
		const runId = await seedInFlightRun(db)

		const provider = makeProvider([], { state: 'succeeded' })
		provider.reconcile = () => Promise.resolve({ state: 'succeeded', exitCode: 0 })
		const iamSchema = recordingIam([], () => Promise.reject(new ReconcileSchemaError('unknown action notes.write', 400)))

		expect(await reconcileProviderRuns({ repositories: db, provider, lock: makeFakeLock(db), iamSchema })).toMatchObject({
			checked: 1,
			failed: 1,
		})
		expect(await requireRun(db, runId)).toMatchObject({ status: 'failed', exit_code: null })
	})

	test('a dry run that settles on reconcile writes no schema', async () => {
		const { db } = createHarness()
		const published = await seedRun(db)
		expect((await executeDeploy(makeDeps(db, makeProvider([], { state: 'succeeded' })), { runId: published })).status).toBe('succeeded')
		const runId = await createNextRun(db)
		expect(await executeDeploy(makeDeps(db, inFlight()), { runId, dryRun: true })).toEqual({ runId, status: 'running' })

		const provider = makeProvider([], { state: 'succeeded' })
		provider.reconcile = () => Promise.resolve({ state: 'succeeded', exitCode: 0, dryRun: true })
		const applied: IamApply[] = []

		expect(await reconcileProviderRuns({ repositories: db, provider, lock: makeFakeLock(db), iamSchema: recordingIam(applied) })).toMatchObject({
			checked: 1,
			succeeded: 1,
		})
		expect(applied).toEqual([])
	})

	test('a cancellation that finds the version live writes the schema and settles the run succeeded', async () => {
		const { db } = createHarness()
		const runId = await seedInFlightRun(db)

		const provider = makeProvider([], { state: 'succeeded' })
		provider.cancel = () => Promise.resolve({ state: 'settled', outcome: 'succeeded' })
		const applied: IamApply[] = []
		let available = false
		const iamSchema = recordingIam(applied, async () => {
			if (!available) throw new Error('connect ECONNREFUSED')
		})
		const deps = { ...makeDeps(db, provider), iamSchema }

		// IAM unavailable: the cancellation stays requested and the run unsettled.
		await cancelDeploy(deps, await requireRun(db, runId))
		expect(await requireRun(db, runId)).toMatchObject({ status: 'running' })
		expect((await requireRun(db, runId)).cancel_requested_at).not.toBeNull()

		available = true
		expect(await reconcileProviderRuns(deps)).toMatchObject({ checked: 1, succeeded: 1 })
		expect((await requireRun(db, runId)).status).toBe('succeeded')
		expect(applied.map((input) => input.app)).toEqual(['app@prod', 'app@prod'])
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
		// Unprotected, so the first contract publishes without an approval (ADR-0050).
		await fixtureProtect(db.registry, makeFakeLock(db), { appId: 'app', env: 'prod' }, false)
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
			await db.runs.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'main', trigger: 'manual', actor: 'user:test' })
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
		await db.runs.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'main', trigger: 'manual', actor: 'user:test' })
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
		await fixtureRuns(db.runs, makeFakeLock(db)).start(runningId, `runs/${runningId}/logs.ndjson`)
		const inputs: ProviderDeployInput[] = []
		expect(
			(await executeDeploy(makeDeps(db, makeProvider(inputs, { state: 'succeeded' })), { runId: runningId })).status,
		).toBe('skipped')

		const pendingId = uuidv7()
		await db.runs.createRun({ id: pendingId, appId: 'app', env: 'prod', ref: 'main', trigger: 'manual', actor: 'user:test' })
		const lock = makeFakeLock(db)
		await lock.acquire('app:prod', 'other-run', 60_000)
		expect(
			(await executeDeploy(makeDeps(db, makeProvider(inputs, { state: 'succeeded' }), vaultSecrets, lock), {
				runId: pendingId,
			})).status,
		).toBe('deferred')
		expect((await requireRun(db, pendingId)).status).toBe('pending')
		expect(inputs).toEqual([])
	})

	test('an older pending run fails as superseded once a newer run of its environment succeeded, and calls no provider', async () => {
		const { db } = createHarness()
		const olderId = await seedRun(db)
		const newerId = uuidv7()
		await db.runs.createRun({ id: newerId, appId: 'app', env: 'prod', ref: 'refs/heads/deploy/prod', trigger: 'webhook', actor: 'webhook:c' })
		const inputs: ProviderDeployInput[] = []
		const resolved: string[] = []
		const provider = makeProvider(inputs, { state: 'succeeded' })
		provider.resolveSource = (input) => {
			resolved.push(input.runId)
			return Promise.resolve({ commitSha: 'a'.repeat(40) })
		}
		const { logs, objects } = memoryLogs()
		const deps = { ...makeDeps(db, provider), logs, runLogs: logs }

		expect((await executeDeploy(deps, { runId: newerId })).status).toBe('succeeded')
		expect((await executeDeploy(deps, { runId: olderId })).status).toBe('failed')

		expect(resolved).toEqual([newerId])
		expect(inputs.map((input) => input.runId)).toEqual([newerId])
		const older = await requireRun(db, olderId)
		expect(older.status).toBe('failed')
		expect(older.started_at).toBeNull()
		expect(typeof older.finished_at).toBe('number')
		const lines = (objects.get(`runs/${olderId}/logs.ndjson`) ?? '').trim().split('\n').map((line) => JSON.parse(line).text)
		expect(lines).toEqual([`superseded by run ${newerId}`])
		expect(await heldLeases(db)).toEqual([])
	})

	test('an older pending run is superseded by a newer running run that its start settles to succeeded', async () => {
		const { db } = createHarness()
		const olderId = await seedRun(db)
		const newerId = uuidv7()
		await db.runs.createRun({ id: newerId, appId: 'app', env: 'prod', ref: 'refs/heads/deploy/prod', trigger: 'webhook', actor: 'webhook:c' })
		const deployed: string[] = []
		const provider = makeProvider([], { state: 'succeeded' })
		provider.deploy = async (input) => {
			deployed.push(input.runId)
			await input.events.externalId(`version-${input.runId}`)
			return input.runId === newerId ? { state: 'running' } : { state: 'succeeded' }
		}
		provider.reconcile = () => Promise.resolve({ state: 'succeeded' })
		const { logs, objects } = memoryLogs()
		const deps = { ...makeDeps(db, provider), logs, runLogs: logs }

		expect((await executeDeploy(deps, { runId: newerId })).status).toBe('running')
		expect((await executeDeploy(deps, { runId: olderId })).status).toBe('failed')

		expect(deployed).toEqual([newerId])
		expect((await requireRun(db, newerId)).status).toBe('succeeded')
		const older = await requireRun(db, olderId)
		expect(older.status).toBe('failed')
		expect(older.started_at).toBeNull()
		const lines = (objects.get(`runs/${olderId}/logs.ndjson`) ?? '').trim().split('\n').map((line) => JSON.parse(line).text)
		expect(lines).toEqual([`superseded by run ${newerId}`])
		expect(await heldLeases(db)).toEqual([])
	})

	test('a cancellation that wins over the supersede write leaves no superseded line', async () => {
		const { db } = createHarness()
		const olderId = await seedRun(db)
		const newerId = uuidv7()
		await db.runs.createRun({ id: newerId, appId: 'app', env: 'prod', ref: 'refs/heads/deploy/prod', trigger: 'webhook', actor: 'webhook:c' })
		await fixtureRuns(db.runs, makeFakeLock(db)).finish(newerId, 'succeeded', 0)
		const runs = db.runs
		const original = runs.markRunSuperseded.bind(runs)
		runs.markRunSuperseded = async (id, fence) => {
			await runs.requestRunCancellation(id)
			return original(id, fence)
		}
		const inputs: ProviderDeployInput[] = []
		const { logs, objects } = memoryLogs()

		await executeDeploy({ ...makeDeps(db, makeProvider(inputs, { state: 'succeeded' })), logs, runLogs: logs }, { runId: olderId })

		expect(inputs).toEqual([])
		expect((await requireRun(db, olderId)).status).toBe('failed')
		expect(objects.get(`runs/${olderId}/logs.ndjson`) ?? '').not.toContain('superseded')
	})

	test('a newer run that failed, or is still pending, supersedes nothing', async () => {
		const { db } = createHarness()
		const olderId = await seedRun(db)
		const failedId = uuidv7()
		await db.runs.createRun({ id: failedId, appId: 'app', env: 'prod', ref: 'refs/heads/deploy/prod', trigger: 'webhook', actor: 'webhook:c' })
		await fixtureRuns(db.runs, makeFakeLock(db)).finish(failedId, 'failed')
		const pendingId = uuidv7()
		await db.runs.createRun({ id: pendingId, appId: 'app', env: 'prod', ref: 'refs/heads/deploy/prod', trigger: 'webhook', actor: 'webhook:c' })
		const inputs: ProviderDeployInput[] = []

		expect((await executeDeploy(makeDeps(db, makeProvider(inputs, { state: 'succeeded' })), { runId: olderId })).status).toBe('succeeded')
		expect(inputs.map((input) => input.runId)).toEqual([olderId])
	})

	test('records resolution and provider failures without leaking the exception', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		// A row from before secrets were vault-only is refused, not migrated (D2).
		await db.registry.upsertAppSecret({ appId: 'app', env: 'prod', name: 'API_KEY', valueRef: 'literal:legacy-plaintext' })

		expect(
			(await executeDeploy(
				makeDeps(db, makeProvider([], { state: 'succeeded' }), vaultSecrets),
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
		const lock = makeFakeLock(db)
		await lock.acquire('app:prod', runId, 60_000)
		const deps = makeDeps(
			db,
			makeProvider([], { state: 'failed' }, { cancelled, cancelledNamespaces }),
			vaultSecrets,
			lock,
		)

		await cancelDeploy(deps, await requireRun(db, runId))

		expect(cancelled).toEqual([])
		expect((await requireRun(db, runId)).status).toBe('running')
		expect(await heldLeases(db)).toEqual([{ lock_key: 'app:prod', holder: runId }])
		await lock.release('app:prod', runId)
		await cancelDeploy(deps, await requireRun(db, runId))

		expect(cancelled).toEqual(['provider-operation-1'])
		expect(cancelledNamespaces).toEqual(['apps-prod'])
		expect((await requireRun(db, runId)).status).toBe('failed')
		expect(await heldLeases(db)).toEqual([])
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

	test('a persisted version 0 envelope is still read, while the API refuses one and an empty provider', () => {
		expect(parseProviderEnvelope('{"provider":"test","version":0,"payload":null,"extra":true}', 'target')).toEqual({
			provider: 'test',
			version: 0,
			payload: null,
		})
		expect(() => parseProviderEnvelope('{"provider":"","version":1,"payload":null}', 'target')).toThrow('target is not a provider envelope')
		expect(readProviderEnvelope({ provider: 'test', version: 0, payload: null })).toBeNull()
		expect(readProviderEnvelope({ provider: 'test', version: 1 })).toBeNull()
	})
})
