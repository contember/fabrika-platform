import { FABRIKA_RELEASE, OPERATIONS_RELEASE_PROTOCOL_VERSION, type OperationsReleaseReconcileRequestV1 } from '@fabrika/operations-contract/releases'
import type { HttpService } from '@fabrika/platform'
import type { ControlProvider, ProviderDeployInput, ProviderEnvelope, ProviderRegistrationInput } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { replayOperationsReleases } from '../operations-releases'
import { executeDeploy, type RunDeps } from '../run-lifecycle'
import { EnvSecretResolver } from '../secret-resolver'
import { createHarness } from './helpers/harness'
import { makeFakeLock } from './helpers/lock'

const SYNC_KEY = 'release-sync-key-that-is-at-least-32-bytes'
const COMMIT = 'a'.repeat(40)
const NOW_S = 1_700_000_000
const NOW_MS = NOW_S * 1_000

const envelope = (payload: string): ProviderEnvelope => ({
	provider: 'memory',
	version: 1,
	payload,
})

class ReleaseService implements HttpService {
	available = false
	readonly requests: OperationsReleaseReconcileRequestV1[] = []

	async fetch(request: Request): Promise<Response> {
		if (!this.available) return new Response('unavailable', { status: 503 })
		const decoded: { value: OperationsReleaseReconcileRequestV1 } = JSON.parse(JSON.stringify({
			value: await request.json(),
		}))
		this.requests.push(decoded.value)
		return Response.json({
			protocolVersion: OPERATIONS_RELEASE_PROTOCOL_VERSION,
			revision: decoded.value.revision,
			outcome: 'applied',
			releaseId: `release-${decoded.value.runId}`,
		})
	}
}

async function seed(harness: ReturnType<typeof createHarness>, commitSha: string | null = COMMIT): Promise<string> {
	await harness.repositories.registry.createApp({ id: 'notes', repoUrl: 'https://github.com/acme/notes' })
	await harness.repositories.registry.upsertAppEnv({
		appId: 'notes',
		env: 'prod',
		namespaceId: null,
		provider: 'memory',
		providerTargetJson: JSON.stringify(envelope('target')),
		providerArtifactJson: JSON.stringify(envelope('artifact')),
	})
	const run = await harness.repositories.runs.createRun({
		id: 'run-release',
		appId: 'notes',
		env: 'prod',
		ref: 'refs/heads/main',
		commitSha,
		trigger: 'webhook',
	})
	return run.id
}

function provider(inputs: ProviderDeployInput[]): ControlProvider {
	return {
		id: 'memory',
		normalizeRegistration(input: ProviderRegistrationInput) {
			return input
		},
		async deploy(input) {
			inputs.push(input)
			await input.events.externalId('provider-operation')
			return { state: 'succeeded', exitCode: 0 }
		},
	}
}

describe('Control release projection', () => {
	test('resolves the exact commit before the first Operations projection and provider deploy', async () => {
		const harness = createHarness(() => NOW_S)
		const runId = await seed(harness, null)
		const calls: string[] = []
		const exactCommit = 'b'.repeat(40)
		const controlProvider: ControlProvider = {
			id: 'memory',
			normalizeRegistration: (input) => input,
			resolveSource: async () => {
				calls.push('resolve')
				expect(await harness.repositories.operationsReleases.get(runId)).toBeNull()
				return { commitSha: exactCommit }
			},
			deploy: async (input) => {
				calls.push('deploy')
				expect(input.app.source.ref).toBe(exactCommit)
				expect(input.managedEnvironment[FABRIKA_RELEASE]).toContain(exactCommit)
				expect(Number((await harness.repositories.operationsReleases.get(runId))?.desired_revision)).toBe(1)
				await input.events.externalId('provider-operation')
				const acceptedProjection = await harness.repositories.operationsReleases.get(runId)
				expect(Number(acceptedProjection?.desired_revision)).toBe(2)
				expect(acceptedProjection?.payload_json).toContain('"phase":"provider_accepted"')
				expect(acceptedProjection?.payload_json).toContain(`"commitSha":"${exactCommit}"`)
				return { state: 'succeeded' }
			},
		}
		const deps: RunDeps = {
			repositories: harness.repositories,
			provider: controlProvider,
			secrets: new EnvSecretResolver({}),
			lock: makeFakeLock(),
			logs: { put: () => Promise.resolve() },
			operations: { repository: harness.repositories.operationsReleases },
		}

		expect((await executeDeploy(deps, { runId })).status).toBe('succeeded')
		expect(calls).toEqual(['resolve', 'deploy'])
		expect((await harness.repositories.runs.getRun(runId))?.commit_sha).toBe(exactCommit)
	})

	test('keeps deploy success independent from Operations and replays every lifecycle projection', async () => {
		const harness = createHarness(() => NOW_S)
		const runId = await seed(harness)
		const service = new ReleaseService()
		const inputs: ProviderDeployInput[] = []
		const operations = {
			repository: harness.repositories.operationsReleases,
			service,
			syncKey: SYNC_KEY,
			artifactOrigin: 'https://operations.test',
			now: () => NOW_MS,
		}
		const deps: RunDeps = {
			repositories: harness.repositories,
			provider: provider(inputs),
			secrets: new EnvSecretResolver({}),
			lock: makeFakeLock(),
			logs: { put: () => Promise.resolve() },
			operations,
		}

		expect(await executeDeploy(deps, { runId })).toEqual({ runId, status: 'succeeded' })
		expect((await harness.repositories.runs.getRun(runId))?.status).toBe('succeeded')
		const release = inputs[0]?.managedEnvironment?.[FABRIKA_RELEASE]
		expect(release).toContain(`/notes/prod/default/${COMMIT}`)
		const pending = await harness.repositories.operationsReleases.get(runId)
		expect(Number(pending?.desired_revision)).toBe(3)
		expect(Number(pending?.applied_revision)).toBe(0)
		expect(pending?.last_error).toContain('status 503')

		service.available = true
		expect(await replayOperationsReleases(operations)).toEqual({ applied: 1, failed: 0, pending: 0 })
		expect(service.requests).toHaveLength(1)
		expect(service.requests[0]?.phase).toBe('terminal')
		expect(service.requests[0]?.outcome).toBe('succeeded')
		expect(service.requests[0]?.artifactState).toBe('incomplete')
		expect(service.requests[0]?.uploadCredential?.verifier).toMatch(/^[0-9a-f]{64}$/)
		expect(service.requests[0]?.observedAt).toBe(NOW_MS)
		expect(service.requests[0]?.uploadCredential?.expiresAt).toBe(NOW_MS + 2 * 60 * 60 * 1_000)
		const storedProjection = JSON.stringify(await harness.repositories.operationsReleases.get(runId))
		expect(storedProjection).not.toContain(operations.syncKey)
		const rawUploadBearer = inputs[0]?.artifactUpload?.bearer
		if (rawUploadBearer === undefined) throw new Error('expected artifact upload bearer')
		expect(storedProjection).not.toContain(rawUploadBearer)
	})

	test('rejects a user collision with the managed release stamp', async () => {
		const harness = createHarness()
		const runId = await seed(harness)
		await harness.repositories.registry.upsertAppVar({
			appId: 'notes',
			env: 'prod',
			name: FABRIKA_RELEASE,
			value: 'user-owned',
		})
		const inputs: ProviderDeployInput[] = []
		const deps: RunDeps = {
			repositories: harness.repositories,
			provider: provider(inputs),
			secrets: new EnvSecretResolver({}),
			lock: makeFakeLock(),
			logs: { put: () => Promise.resolve() },
			operations: {
				repository: harness.repositories.operationsReleases,
				syncKey: SYNC_KEY,
				now: () => 2_000,
			},
		}
		expect((await executeDeploy(deps, { runId })).status).toBe('failed')
		expect(inputs).toEqual([])
	})

	test('a blank or invalid artifact origin never blocks release stamping or delivery', async () => {
		for (const artifactOrigin of ['', 'not a URL']) {
			const harness = createHarness(() => NOW_S)
			const runId = await seed(harness)
			const inputs: ProviderDeployInput[] = []
			const deps: RunDeps = {
				repositories: harness.repositories,
				provider: provider(inputs),
				secrets: new EnvSecretResolver({}),
				lock: makeFakeLock(),
				logs: { put: () => Promise.resolve() },
				operations: {
					repository: harness.repositories.operationsReleases,
					syncKey: SYNC_KEY,
					artifactOrigin,
					now: () => NOW_MS,
				},
			}
			expect((await executeDeploy(deps, { runId })).status).toBe('succeeded')
			expect(inputs[0]?.managedEnvironment?.[FABRIKA_RELEASE]).toContain(COMMIT)
			expect(inputs[0]?.artifactUpload).toBeUndefined()
		}
	})
})
