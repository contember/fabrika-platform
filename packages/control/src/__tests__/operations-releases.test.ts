import {
	FABRIKA_RELEASE,
	operationsReleaseName,
	type OperationsReleaseProjectionPayload,
	type OperationsReleaseReconcileRequest,
	parseOperationsReleaseRequest,
} from '@fabrika/operations-contract/releases'
import type { HttpService } from '@fabrika/platform'
import type { ControlProvider, ProviderDeployInput, ProviderEnvelope, ProviderRegistrationInput } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { replayOperationsReleases } from '../operations-releases'
import { executeDeploy, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { contractCommits } from './helpers/commits'
import { createHarness } from './helpers/harness'
import { fixtureProtect, makeFakeLock } from './helpers/lock'

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
	readonly requests: OperationsReleaseReconcileRequest[] = []
	readonly bodies: string[] = []

	async fetch(request: Request): Promise<Response> {
		if (!this.available) return new Response('unavailable', { status: 503 })
		const body = await request.text()
		this.bodies.push(body)
		const decoded: unknown = JSON.parse(body)
		const value = parseOperationsReleaseRequest(decoded)
		this.requests.push(value)
		return Response.json({ revision: value.revision, outcome: 'applied' })
	}
}

function storedPayload(runId: string): OperationsReleaseProjectionPayload {
	return {
		runId,
		coordinate: { appId: 'notes', environment: 'prod' },
		phase: 'started',
		providerRunId: null,
		outcome: null,
		artifactState: 'pending',
		release: {
			kind: 'available',
			name: operationsReleaseName({ appId: 'notes', environment: 'prod', commitSha: COMMIT }),
			commitSha: COMMIT,
		},
		observedAt: NOW_MS,
	}
}

async function queuePayload(harness: ReturnType<typeof createHarness>, runId: string, raw: string): Promise<void> {
	await harness.repositories.runs.createRun({
		id: runId,
		appId: 'notes',
		env: 'prod',
		ref: 'refs/heads/main',
		commitSha: COMMIT,
		trigger: 'manual',
		actor: 'user:test',
	})
	await harness.repositories.operationsReleases.project(runId, raw)
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
	// Unprotected, so the first contract publishes without an approval (ADR-0050).
	await fixtureProtect(harness.repositories.registry, makeFakeLock(harness.repositories), { appId: 'notes', env: 'prod' }, false)
	const run = await harness.repositories.runs.createRun({
		id: 'run-release',
		appId: 'notes',
		env: 'prod',
		ref: 'refs/heads/main',
		commitSha,
		trigger: 'webhook',
		actor: 'user:test',
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
	test('a delayed HTTP failure cannot replace the diagnostic of newer payload bytes or revision', async () => {
		for (const advanceRevision of [false, true]) {
			const harness = createHarness(() => NOW_S)
			await seed(harness)
			await queuePayload(harness, 'delayed', JSON.stringify(storedPayload('delayed')))
			const entered = Promise.withResolvers<void>()
			const response = Promise.withResolvers<Response>()
			const replay = replayOperationsReleases({
				repository: harness.repositories.operationsReleases,
				syncKey: SYNC_KEY,
				service: {
					fetch: () => {
						entered.resolve()
						return response.promise
					},
				},
			})
			await entered.promise
			const replacement = JSON.stringify({ ...storedPayload('delayed'), artifactState: 'complete' })
			if (advanceRevision) await harness.repositories.operationsReleases.project('delayed', replacement)
			else harness.sqlite.query('UPDATE operations_release_sync SET payload_json = ? WHERE run_id = ?').run(replacement, 'delayed')
			harness.sqlite.query('UPDATE operations_release_sync SET last_error = ? WHERE run_id = ?').run('newer diagnostic', 'delayed')
			response.resolve(new Response(null, { status: 503 }))
			await replay
			expect(await harness.repositories.operationsReleases.get('delayed')).toMatchObject({
				payload_json: replacement,
				desired_revision: advanceRevision ? 2 : 1,
				last_error: 'newer diagnostic',
			})
		}
	})

	test('rejects corrupt stored JSON and structures per row while valid peers replay', async () => {
		const harness = createHarness(() => NOW_S)
		await seed(harness)
		const payload = storedPayload('corrupt')
		const credential = { verifier: 'c'.repeat(64), expiresAt: NOW_MS + 1 }
		const corrupt: unknown[] = [
			null,
			[],
			true,
			{},
			{ ...payload, runId: 'other-run' },
			{ ...payload, runId: 'invalid run' },
			{ ...payload, coordinate: null },
			{ ...payload, coordinate: [] },
			{ ...payload, coordinate: {} },
			{ ...payload, coordinate: { ...payload.coordinate, serviceKey: null } },
			{ ...payload, coordinate: { ...payload.coordinate, serviceKey: 'UPPERCASE' } },
			{ ...payload, phase: 'unknown' },
			{ ...payload, providerRunId: undefined },
			{ ...payload, providerRunId: 42 },
			{ ...payload, outcome: undefined },
			{ ...payload, outcome: 'succeeded' },
			{ ...payload, phase: 'terminal' },
			{ ...payload, artifactState: 'unknown' },
			{ ...payload, release: null },
			{ ...payload, release: { kind: 'available', name: 'release', commitSha: 'main' } },
			{ ...payload, release: { kind: 'unavailable', reason: 'unknown' } },
			{ ...payload, release: { kind: 'unknown' } },
			{ ...payload, observedAt: -1 },
			{ ...payload, observedAt: '1700000000000' },
			{ ...payload, uploadCredential: null },
			{ ...payload, uploadCredential: [] },
			{ ...payload, uploadCredential: { ...credential, verifier: 'bad' } },
			{ ...payload, uploadCredential: { ...credential, expiresAt: NOW_MS } },
			{ ...payload, release: { kind: 'unavailable', reason: 'dry_run' }, uploadCredential: credential },
		]
		for (const [index, value] of corrupt.entries()) {
			const runId = `a-corrupt-${index}`
			const raw = typeof value === 'object' && value !== null && 'runId' in value && value.runId === 'corrupt'
				? JSON.stringify({ ...value, runId })
				: JSON.stringify(value)
			await queuePayload(harness, runId, raw)
		}
		await queuePayload(harness, 'a-invalid-json', '{')
		await queuePayload(harness, 'z-valid', JSON.stringify(storedPayload('z-valid')))
		const service = new ReleaseService()
		service.available = true
		expect(await replayOperationsReleases({ repository: harness.repositories.operationsReleases, service, syncKey: SYNC_KEY })).toEqual({
			applied: 1,
			failed: corrupt.length + 1,
			pending: corrupt.length + 1,
		})
		expect(service.requests.map((request) => request.runId)).toEqual(['z-valid'])
		for (const row of await harness.repositories.operationsReleases.listPending()) {
			expect(Number(row.applied_revision)).toBe(0)
			expect(row.last_attempt_at).toBeNull()
			expect(row.last_error).not.toBeNull()
		}
	})

	test('contains invalid stored revisions within their rows', async () => {
		const harness = createHarness(() => NOW_S)
		await seed(harness)
		const revisions = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'not-a-number', Infinity]
		for (const [index, revision] of revisions.entries()) {
			const runId = `a-invalid-revision-${index}`
			await queuePayload(harness, runId, JSON.stringify(storedPayload(runId)))
			harness.sqlite.query('UPDATE operations_release_sync SET desired_revision = ?, applied_revision = -2 WHERE run_id = ?').run(revision, runId)
		}
		await queuePayload(harness, 'z-valid', JSON.stringify(storedPayload('z-valid')))
		const service = new ReleaseService()
		service.available = true
		expect(await replayOperationsReleases({ repository: harness.repositories.operationsReleases, service, syncKey: SYNC_KEY })).toEqual({
			applied: 1,
			failed: revisions.length,
			pending: revisions.length,
		})
		expect(service.requests.map((request) => request.runId)).toEqual(['z-valid'])
		for (const row of await harness.repositories.operationsReleases.listPending()) {
			expect(Number(row.applied_revision)).toBe(-2)
			expect(row.last_attempt_at).toBeNull()
			expect(row.last_error).toBe('operations release request failed')
		}
	})

	test('uses trusted envelope fields and strips unrelated stored extras without defaulting the service key', async () => {
		const harness = createHarness(() => NOW_S)
		const runId = await seed(harness)
		const payload = storedPayload(runId)
		if (payload.release.kind !== 'available') throw new Error('expected available release')
		const raw = JSON.stringify({
			observedAt: payload.observedAt,
			uploadCredential: { expiresAt: NOW_MS + 1, verifier: 'c'.repeat(64), extra: 'ignored' },
			release: { commitSha: COMMIT.toUpperCase(), name: payload.release.name, kind: 'available', extra: 'ignored' },
			artifactState: payload.artifactState,
			outcome: payload.outcome,
			providerRunId: payload.providerRunId,
			phase: payload.phase,
			coordinate: { environment: 'prod', appId: 'notes', extra: 'ignored' },
			runId,
			revision: 999,
			extra: 'ignored',
		})
		await harness.repositories.operationsReleases.project(runId, raw)
		const service = new ReleaseService()
		service.available = true
		expect(await replayOperationsReleases({ repository: harness.repositories.operationsReleases, service, syncKey: SYNC_KEY })).toEqual({
			applied: 1,
			failed: 0,
			pending: 0,
		})
		expect(service.bodies).toEqual([JSON.stringify({
			revision: 1,
			runId,
			coordinate: payload.coordinate,
			phase: payload.phase,
			providerRunId: null,
			outcome: null,
			artifactState: payload.artifactState,
			release: payload.release,
			uploadCredential: { verifier: 'c'.repeat(64), expiresAt: NOW_MS + 1 },
			observedAt: NOW_MS,
		})])
		expect(service.requests[0]?.coordinate).not.toHaveProperty('serviceKey')
	})

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
				expect(input.managedEnvironment[FABRIKA_RELEASE]?.value).toContain(exactCommit)
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
			secrets: new VaultSecretResolver({}),
			lock: makeFakeLock(harness.repositories),
			logs: { put: () => Promise.resolve() },
			commits: contractCommits('notes'),
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
			secrets: new VaultSecretResolver({}),
			lock: makeFakeLock(harness.repositories),
			logs: { put: () => Promise.resolve() },
			commits: contractCommits('notes'),
			operations,
		}

		expect(await executeDeploy(deps, { runId })).toEqual({ runId, status: 'succeeded' })
		expect((await harness.repositories.runs.getRun(runId))?.status).toBe('succeeded')
		const release = inputs[0]?.managedEnvironment?.[FABRIKA_RELEASE]?.value
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

	test('a provider line that carries the source-map bearer reaches the run log redacted', async () => {
		const harness = createHarness(() => NOW_S)
		const runId = await seed(harness)
		const stored: string[] = []
		const echoing: ControlProvider = {
			id: 'memory',
			normalizeRegistration: (input: ProviderRegistrationInput) => input,
			async deploy(input) {
				input.events.log(`build: uploading with ${input.artifactUpload?.bearer ?? 'no bearer'}`)
				return { state: 'succeeded', exitCode: 0 }
			},
		}
		const deps: RunDeps = {
			repositories: harness.repositories,
			provider: echoing,
			secrets: new VaultSecretResolver({}),
			lock: makeFakeLock(harness.repositories),
			logs: {
				put: (_key, value) => {
					if (typeof value === 'string') stored.push(value)
					return Promise.resolve()
				},
			},
			commits: contractCommits('notes'),
			operations: {
				repository: harness.repositories.operationsReleases,
				service: new ReleaseService(),
				syncKey: SYNC_KEY,
				artifactOrigin: 'https://operations.test',
				now: () => NOW_MS,
			},
		}

		expect(await executeDeploy(deps, { runId })).toEqual({ runId, status: 'succeeded' })
		const log = stored.at(-1) ?? ''
		expect(log).toContain('build: uploading with')
		expect(log).not.toMatch(/build: uploading with [0-9a-f]{64}/)
		expect(log).not.toContain('no bearer')
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
			secrets: new VaultSecretResolver({}),
			lock: makeFakeLock(harness.repositories),
			logs: { put: () => Promise.resolve() },
			commits: contractCommits('notes'),
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
				secrets: new VaultSecretResolver({}),
				lock: makeFakeLock(harness.repositories),
				logs: { put: () => Promise.resolve() },
				commits: contractCommits('notes'),
				operations: {
					repository: harness.repositories.operationsReleases,
					syncKey: SYNC_KEY,
					artifactOrigin,
					now: () => NOW_MS,
				},
			}
			expect((await executeDeploy(deps, { runId })).status).toBe('succeeded')
			expect(inputs[0]?.managedEnvironment?.[FABRIKA_RELEASE]?.value).toContain(COMMIT)
			expect(inputs[0]?.artifactUpload).toBeUndefined()
		}
	})
})
