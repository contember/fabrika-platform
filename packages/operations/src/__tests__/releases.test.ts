import {
	OPERATIONS_ARTIFACT_HEADERS,
	OPERATIONS_RELEASE_PROTOCOL_VERSION,
	type OperationsArtifactState,
	type OperationsReleaseAvailabilityV1,
	operationsReleaseName,
	type OperationsReleaseReconcileRequestV1,
} from '@fabrika/operations-contract'
import type { BlobStore } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { handleSourceMapUploadRequest, operationsSourceMapReader } from '../artifact-upload.js'
import { sha256Hex } from '../ingest.js'
import { handleOperationsReleaseRequest, parseReleaseRequest, reconcileOperationsRelease } from '../releases.js'
import { logicalAssetPath, resolveFrames } from '../source-maps.js'
import { createHarness } from './helpers/sqlite.js'

const SYNC_KEY = 'release-sync-key-that-is-at-least-32-bytes'
const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)
const BEARER = 'c'.repeat(64)
const NOW_MS = 1_700_000_000_000
const SOURCE_MAP = JSON.stringify({
	version: 3,
	file: 'app.js',
	sources: ['src/app.ts'],
	names: [],
	mappings: 'AAAA',
	sourcesContent: ['throw new Error()'],
})

class MemoryBlobs implements BlobStore {
	readonly values = new Map<string, ArrayBuffer>()
	puts = 0
	failNext = false

	put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<void> {
		this.puts++
		if (this.failNext) {
			this.failNext = false
			return Promise.reject(new Error('blob unavailable'))
		}
		if (!(value instanceof ArrayBuffer)) return Promise.reject(new Error('expected bytes'))
		this.values.set(key, value)
		return Promise.resolve()
	}

	get(key: string): Promise<{ body: ReadableStream; text(): Promise<string> } | null> {
		const value = this.values.get(key)
		if (value === undefined) return Promise.resolve(null)
		return Promise.resolve({
			body: new Blob([value]).stream(),
			text: () => Promise.resolve(new TextDecoder().decode(value)),
		})
	}

	delete(key: string): Promise<void> {
		this.values.delete(key)
		return Promise.resolve()
	}
}

async function seedSource(
	harness: ReturnType<typeof createHarness>,
	id: string,
	appId: string,
	environment = 'prod',
): Promise<void> {
	await harness.repositories.sources.upsert({
		id,
		appId,
		environment,
		displayName: `${appId} / ${environment}`,
		enabled: true,
	})
}

function projection(input: {
	runId: string
	appId?: string
	commit?: string | null
	revision?: number
	phase?: 'started' | 'provider_accepted' | 'terminal'
	outcome?: 'succeeded' | 'failed' | null
	artifactState?: OperationsArtifactState
	dryRun?: boolean
	verifier?: string
	observedAt?: number
}): OperationsReleaseReconcileRequestV1 {
	const appId = input.appId ?? 'notes'
	const phase = input.phase ?? 'started'
	const commit = input.commit === undefined ? COMMIT_A : input.commit
	let release: OperationsReleaseAvailabilityV1
	if (input.dryRun === true) {
		release = { kind: 'unavailable', reason: 'dry_run' }
	} else if (commit === null) {
		release = { kind: 'unavailable', reason: 'missing_commit' }
	} else {
		release = {
			kind: 'available',
			name: operationsReleaseName({ appId, environment: 'prod', commitSha: commit }),
			commitSha: commit,
		}
	}
	return {
		protocolVersion: OPERATIONS_RELEASE_PROTOCOL_VERSION,
		revision: input.revision ?? 1,
		runId: input.runId,
		coordinate: { appId, environment: 'prod' },
		phase,
		providerRunId: phase === 'started' ? null : `provider-${input.runId}`,
		outcome: input.outcome === undefined ? (phase === 'terminal' ? 'succeeded' : null) : input.outcome,
		artifactState: input.artifactState ?? (release.kind === 'available' ? (phase === 'terminal' ? 'incomplete' : 'pending') : 'not_applicable'),
		release,
		...(release.kind === 'available' && input.verifier !== undefined
			? { uploadCredential: { verifier: input.verifier, expiresAt: NOW_MS + 2 * 60 * 60 * 1_000 } }
			: {}),
		observedAt: input.observedAt ?? NOW_MS + (input.revision ?? 1),
	}
}

function rows(harness: ReturnType<typeof createHarness>, sql: string): Record<string, unknown>[] {
	const decoded: { rows: Record<string, unknown>[] } = JSON.parse(JSON.stringify({
		rows: harness.sqlite.query(sql).all(),
	}))
	return decoded.rows
}

function uploadRequest(input: {
	release: string
	body?: string
	bearer?: string
	appId?: string
	environment?: string
	path?: string
	digest: string
}): Request {
	return new Request('https://operations.test/api/artifacts/source-maps/', {
		method: 'POST',
		headers: {
			authorization: `Bearer ${input.bearer ?? BEARER}`,
			'content-type': 'application/json',
			[OPERATIONS_ARTIFACT_HEADERS.appId]: input.appId ?? 'notes',
			[OPERATIONS_ARTIFACT_HEADERS.environment]: input.environment ?? 'prod',
			[OPERATIONS_ARTIFACT_HEADERS.serviceKey]: 'default',
			[OPERATIONS_ARTIFACT_HEADERS.release]: input.release,
			[OPERATIONS_ARTIFACT_HEADERS.runId]: 'run-upload',
			[OPERATIONS_ARTIFACT_HEADERS.logicalPath]: input.path ?? 'https://cdn.test/assets/admin/app.js?v=1',
			[OPERATIONS_ARTIFACT_HEADERS.digest]: input.digest,
		},
		body: input.body ?? SOURCE_MAP,
	})
}

describe('Operations release projection', () => {
	test.each([
		{ serviceKey: false, credential: false, hash: '21a7302bc8f15805f2cf22fa68457d1cf8a2bdf6e6d95f00d59fb2938abe038e' },
		{ serviceKey: false, credential: true, hash: 'bbf7537f3d4e440a198d670f9b692debbb9a74824bbde6cf343600d70a54f92e' },
		{ serviceKey: true, credential: false, hash: '1e544bd700d46e40342624ec5c68f2629fb55fbfbdd46473e360a069446964e3' },
		{ serviceKey: true, credential: true, hash: 'eff82a75ea4af653512e8e54df2057ec560202ad34e4d5a605807c9e76170a2a' },
	])('preserves historical bytes and HTTP revision reuse: serviceKey=$serviceKey credential=$credential', async (fixture) => {
		const harness = createHarness(() => NOW_MS)
		await seedSource(harness, 'source-notes', 'notes')
		const original = projection({
			runId: 'historical-run',
			revision: 7,
			observedAt: NOW_MS,
			...(fixture.credential ? { verifier: BEARER } : {}),
		})
		if (fixture.serviceKey) original.coordinate.serviceKey = 'default'
		const credentialJson = fixture.credential
			? ',"uploadCredential":{"verifier":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","expiresAt":1700007200000}'
			: ''
		const serviceKeyJson = fixture.serviceKey ? ',"serviceKey":"default"' : ''
		const historicalJson = '{"protocolVersion":1,"revision":7,"runId":"historical-run","coordinate":{"appId":"notes","environment":"prod"'
			+ serviceKeyJson
			+ '},"phase":"started","providerRunId":null,"outcome":null,"artifactState":"pending","release":{"kind":"available","name":"fabrika/notes/prod/default/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","commitSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
			+ credentialJson + ',"observedAt":1700000000000}'
		expect(JSON.stringify(original)).toBe(historicalJson)
		expect(await sha256Hex(historicalJson)).toBe(fixture.hash)
		const prior = await reconcileOperationsRelease(harness.repositories, original)
		expect(rows(harness, 'SELECT projection_hash FROM deploy_run_links')).toEqual([{ projection_hash: fixture.hash }])
		const raw = {
			observedAt: NOW_MS,
			uploadCredential: fixture.credential ? { expiresAt: NOW_MS + 7_200_000, verifier: BEARER, extra: 'ignored' } : undefined,
			release: { commitSha: COMMIT_A.toUpperCase(), name: `fabrika/notes/prod/default/${COMMIT_A}`, kind: 'available', extra: 'ignored' },
			artifactState: 'pending',
			outcome: null,
			providerRunId: null,
			phase: 'started',
			coordinate: { environment: 'prod', serviceKey: fixture.serviceKey ? 'default' : undefined, appId: 'notes', extra: 'ignored' },
			runId: 'historical-run',
			revision: 7,
			protocolVersion: 1,
			extra: 'ignored',
		}
		const parsed = parseReleaseRequest(raw)
		expect(JSON.stringify(parsed)).toBe(historicalJson)
		expect(Object.hasOwn(parsed.coordinate, 'serviceKey')).toBe(fixture.serviceKey)
		expect(Object.hasOwn(parsed, 'uploadCredential')).toBe(fixture.credential)
		const send = (value: unknown): Promise<Response> =>
			handleOperationsReleaseRequest(
				new Request('https://operations.test/private/releases/reconcile', {
					method: 'POST',
					headers: { authorization: `Bearer ${SYNC_KEY}` },
					body: JSON.stringify(value),
				}),
				{ repositories: harness.repositories, syncKey: SYNC_KEY },
			)
		const replay = await send(raw)
		expect(replay.status).toBe(200)
		const replayBody: unknown = await replay.json()
		expect(replayBody).toEqual({ protocolVersion: 1, revision: 7, outcome: 'unchanged', releaseId: prior.releaseId })
		const conflict = await send({ ...raw, artifactState: 'complete' })
		expect(conflict.status).toBe(409)
		const conflictBody: unknown = await conflict.json()
		expect(conflictBody).toEqual({ error: 'deploy run revision was reused with different content' })
		const newer = await send({ ...raw, revision: 8 })
		expect(newer.status).toBe(200)
		const newerBody: unknown = await newer.json()
		expect(newerBody).toEqual({ protocolVersion: 1, revision: 8, outcome: 'applied', releaseId: prior.releaseId })
		expect(rows(harness, 'SELECT projection_hash FROM deploy_run_links')).not.toEqual([{ projection_hash: fixture.hash }])
		const stale = await send({ ...raw, revision: 6 })
		expect(stale.status).toBe(200)
		const staleBody: unknown = await stale.json()
		expect(staleBody).toEqual({ protocolVersion: 1, revision: 6, outcome: 'stale', releaseId: null })
	})

	test('preserves public parser and HTTP structural error messages', async () => {
		const harness = createHarness(() => NOW_MS)
		const base = projection({ runId: 'invalid' })
		const credential = { verifier: BEARER, expiresAt: NOW_MS + 7_200_000 }
		const cases = [
			{ value: null, message: 'invalid release request' },
			{ value: [], message: 'invalid release request' },
			{ value: { ...base, protocolVersion: 2 }, message: 'invalid release request' },
			{ value: { ...base, revision: '1' }, message: 'invalid release request' },
			{ value: { ...base, revision: 0 }, message: 'invalid release request' },
			{ value: { ...base, providerRunId: undefined }, message: 'invalid release request' },
			{ value: { ...base, outcome: undefined }, message: 'invalid release request' },
			{ value: { ...base, coordinate: { appId: 'invalid app', environment: 'prod' } }, message: 'invalid release coordinates' },
			{ value: { ...base, coordinate: { ...base.coordinate, serviceKey: null } }, message: 'invalid release coordinates' },
			{ value: { ...base, release: { kind: 'available', name: 'release', commitSha: 'main' } }, message: 'invalid available release' },
			{ value: { ...base, release: { kind: 'unavailable', reason: 'unknown' } }, message: 'invalid unavailable release' },
			{ value: { ...base, release: { kind: 'unknown' } }, message: 'invalid release availability' },
			{ value: { ...base, uploadCredential: null }, message: 'invalid upload credential' },
			{ value: { ...base, uploadCredential: { ...credential, expiresAt: base.observedAt } }, message: 'invalid upload credential' },
			{
				value: { ...base, release: { kind: 'unavailable', reason: 'dry_run' }, uploadCredential: credential },
				message: 'unavailable releases cannot accept artifacts',
			},
			{ value: { ...base, phase: 'terminal' }, message: 'terminal release has no outcome' },
			{ value: { ...base, outcome: 'succeeded' }, message: 'non-terminal release has an outcome' },
		]
		for (const { value, message } of cases) {
			expect(() => parseReleaseRequest(value)).toThrow(message)
			const response = await handleOperationsReleaseRequest(
				new Request('https://operations.test/private/releases/reconcile', {
					method: 'POST',
					headers: { authorization: `Bearer ${SYNC_KEY}` },
					body: JSON.stringify(value),
				}),
				{ repositories: harness.repositories, syncKey: SYNC_KEY },
			)
			expect(response.status).toBe(400)
			const body: unknown = await response.json()
			expect(body).toEqual({ error: message })
		}
	})

	test('preserves method, bearer, body-size, malformed JSON and missing-source responses', async () => {
		const harness = createHarness()
		const url = 'https://operations.test/private/releases/reconcile'
		const headers = { authorization: `Bearer ${SYNC_KEY}` }
		const options = { repositories: harness.repositories, syncKey: SYNC_KEY }
		const method = await handleOperationsReleaseRequest(new Request(url), options)
		expect(method.status).toBe(405)
		expect(method.headers.get('Allow')).toBe('POST')
		const methodBody: unknown = await method.json()
		expect(methodBody).toEqual({ error: 'method not allowed' })
		const unauthorized = await handleOperationsReleaseRequest(new Request(url, { method: 'POST', body: '{}' }), options)
		expect(unauthorized.status).toBe(401)
		const unauthorizedBody: unknown = await unauthorized.json()
		expect(unauthorizedBody).toEqual({ error: 'unauthorized' })
		for (
			const request of [
				new Request(url, { method: 'POST', headers: { ...headers, 'content-length': 'invalid' }, body: '{}' }),
				new Request(url, { method: 'POST', headers: { ...headers, 'content-length': '65537' }, body: '{}' }),
				new Request(url, { method: 'POST', headers, body: 'x'.repeat(65_537) }),
			]
		) {
			const oversized = await handleOperationsReleaseRequest(request, options)
			expect(oversized.status).toBe(413)
			const body: unknown = await oversized.json()
			expect(body).toEqual({ error: 'payload too large' })
		}
		const malformed = await handleOperationsReleaseRequest(new Request(url, { method: 'POST', headers, body: '{' }), options)
		expect(malformed.status).toBe(500)
		const malformedBody: unknown = await malformed.json()
		expect(malformedBody).toEqual({ error: 'internal error' })
		const missing = await handleOperationsReleaseRequest(
			new Request(url, { method: 'POST', headers, body: JSON.stringify(projection({ runId: 'missing-source' })) }),
			options,
		)
		expect(missing.status).toBe(404)
		const missingBody: unknown = await missing.json()
		expect(missingBody).toEqual({ error: 'Operations source is unavailable' })
	})

	test('deduplicates retries, separates run links, and keeps commits immutable', async () => {
		const harness = createHarness(() => NOW_MS)
		await seedSource(harness, 'source-notes', 'notes')
		const first = projection({ runId: 'run-a' })
		expect((await reconcileOperationsRelease(harness.repositories, first)).outcome).toBe('applied')
		expect((await reconcileOperationsRelease(harness.repositories, first)).outcome).toBe('unchanged')
		expect(
			(await reconcileOperationsRelease(harness.repositories, projection({ runId: 'run-a', revision: 2, phase: 'terminal' }))).outcome,
		).toBe('applied')
		await reconcileOperationsRelease(harness.repositories, projection({ runId: 'run-a-retry', commit: COMMIT_A }))
		await reconcileOperationsRelease(harness.repositories, projection({ runId: 'run-b', commit: COMMIT_B }))

		expect(rows(harness, 'SELECT * FROM releases')).toHaveLength(2)
		expect(rows(harness, 'SELECT * FROM deploy_run_links')).toHaveLength(3)
		expect(rows(harness, 'SELECT DISTINCT commit_sha FROM releases')).toHaveLength(2)
	})

	test('keeps the latest observed run as the commit summary while retaining retry links', async () => {
		const harness = createHarness(() => NOW_MS)
		await seedSource(harness, 'source-notes', 'notes')
		await reconcileOperationsRelease(
			harness.repositories,
			projection({
				runId: 'run-failed',
				phase: 'terminal',
				outcome: 'failed',
				observedAt: NOW_MS + 100,
			}),
		)
		await reconcileOperationsRelease(
			harness.repositories,
			projection({
				runId: 'run-retry',
				phase: 'terminal',
				outcome: 'succeeded',
				artifactState: 'complete',
				observedAt: NOW_MS + 200,
			}),
		)

		expect(rows(harness, 'SELECT run_id, state, finished_at, artifact_state, updated_at FROM releases')).toEqual([{
			run_id: 'run-retry',
			state: 'succeeded',
			finished_at: NOW_MS + 200,
			artifact_state: 'complete',
			updated_at: NOW_MS + 200,
		}])

		await reconcileOperationsRelease(
			harness.repositories,
			projection({
				runId: 'run-failed',
				revision: 2,
				phase: 'terminal',
				outcome: 'failed',
				observedAt: NOW_MS + 150,
			}),
		)

		expect(rows(harness, 'SELECT run_id, state, finished_at, artifact_state, updated_at FROM releases')).toEqual([{
			run_id: 'run-retry',
			state: 'succeeded',
			finished_at: NOW_MS + 200,
			artifact_state: 'complete',
			updated_at: NOW_MS + 200,
		}])
		expect(rows(harness, 'SELECT run_id, projection_revision FROM deploy_run_links ORDER BY run_id')).toEqual([
			{ run_id: 'run-failed', projection_revision: 2 },
			{ run_id: 'run-retry', projection_revision: 1 },
		])
	})

	test('same-revision replay repairs a missing derived upload credential', async () => {
		const harness = createHarness(() => NOW_MS)
		await seedSource(harness, 'source-notes', 'notes')
		const verifier = await sha256Hex(BEARER)
		const request = projection({ runId: 'repair-run', verifier })
		expect((await reconcileOperationsRelease(harness.repositories, request)).outcome).toBe('applied')
		harness.sqlite.query('DELETE FROM artifact_upload_credentials WHERE run_id = ?').run('repair-run')
		expect(await harness.repositories.artifacts.resolveUploadCredential(verifier, NOW_MS)).toBeNull()
		expect((await reconcileOperationsRelease(harness.repositories, request)).outcome).toBe('unchanged')
		expect(await harness.repositories.artifacts.resolveUploadCredential(verifier, NOW_MS)).not.toBeNull()
	})

	test('records dry runs and missing commits as explicitly unavailable', async () => {
		const harness = createHarness()
		await seedSource(harness, 'source-notes', 'notes')
		await reconcileOperationsRelease(harness.repositories, projection({ runId: 'dry', dryRun: true }))
		await reconcileOperationsRelease(harness.repositories, projection({ runId: 'missing', commit: null }))
		expect(rows(harness, 'SELECT * FROM releases')).toEqual([])
		expect(rows(harness, 'SELECT unavailable_reason FROM deploy_run_links ORDER BY run_id')).toEqual([
			{ unavailable_reason: 'dry_run' },
			{ unavailable_reason: 'missing_commit' },
		])
	})

	test('rejects a run replay across source ownership and authenticates the private endpoint', async () => {
		const harness = createHarness()
		await seedSource(harness, 'source-notes', 'notes')
		await seedSource(harness, 'source-shop', 'shop')
		await reconcileOperationsRelease(harness.repositories, projection({ runId: 'shared-run' }))
		await expect(
			reconcileOperationsRelease(harness.repositories, projection({ runId: 'shared-run', appId: 'shop', revision: 2 })),
		).rejects.toThrow('another source')
		const body = JSON.stringify(projection({ runId: 'authenticated' }))
		const unauthorized = await handleOperationsReleaseRequest(
			new Request('https://operations.test/private/releases/reconcile', { method: 'POST', body }),
			{ repositories: harness.repositories, syncKey: SYNC_KEY },
		)
		expect(unauthorized.status).toBe(401)
		const accepted = await handleOperationsReleaseRequest(
			new Request('https://operations.test/private/releases/reconcile', {
				method: 'POST',
				headers: { authorization: `Bearer ${SYNC_KEY}` },
				body,
			}),
			{ repositories: harness.repositories, syncKey: SYNC_KEY },
		)
		expect(accepted.status).toBe(200)
		const malformed = projection({ runId: 'malformed' })
		if (malformed.release.kind !== 'available') throw new Error('expected release')
		const malformedRequest = {
			...malformed,
			release: { ...malformed.release, commitSha: 'branch-name' },
		}
		const rejected = await handleOperationsReleaseRequest(
			new Request('https://operations.test/private/releases/reconcile', {
				method: 'POST',
				headers: { authorization: `Bearer ${SYNC_KEY}` },
				body: JSON.stringify(malformedRequest),
			}),
			{ repositories: harness.repositories, syncKey: SYNC_KEY },
		)
		expect(rejected.status).toBe(400)
	})
})

describe('authenticated source-map artifacts', () => {
	test('accepts opaque upload fields without rewriting bytes while the consumer falls back', async () => {
		const harness = createHarness(() => NOW_MS)
		const blobs = new MemoryBlobs()
		await seedSource(harness, 'source-notes', 'notes')
		const release = projection({ runId: 'run-upload', verifier: await sha256Hex(BEARER) })
		await reconcileOperationsRelease(harness.repositories, release)
		if (release.release.kind !== 'available') throw new Error('expected release')
		const body = '{ "version": null, "sources": [null, 42], "mappings": "AAAA", "extension": true }\n'
		const digest = await sha256Hex(body)
		const response = await handleSourceMapUploadRequest(uploadRequest({ release: release.release.name, body, digest }), {
			repositories: harness.repositories,
			artifacts: blobs,
			now: () => NOW_MS,
		})
		expect(response.status).toBe(201)
		expect([...blobs.values.values()].map((bytes) => new TextDecoder().decode(bytes))).toEqual([body])
		const frames = await resolveFrames(
			[{ filename: 'assets/admin/app.js', line: 1, column: 1 }],
			'source-notes',
			release.release.name,
			operationsSourceMapReader(harness.repositories, blobs),
		)
		expect(frames[0]?.resolved).toBe(false)
	})

	test('binds scope, digest and full logical path without overwrite', async () => {
		const harness = createHarness(() => NOW_MS)
		const blobs = new MemoryBlobs()
		await seedSource(harness, 'source-notes', 'notes')
		const verifier = await sha256Hex(BEARER)
		const release = projection({ runId: 'run-upload', verifier })
		await reconcileOperationsRelease(harness.repositories, release)
		if (release.release.kind !== 'available') throw new Error('expected release')
		const digest = await sha256Hex(SOURCE_MAP)
		expect(await harness.repositories.artifacts.resolveUploadCredential(verifier, NOW_MS)).not.toBeNull()
		expect(
			await harness.repositories.artifacts.resolveUploadCredential(verifier, NOW_MS + 2 * 60 * 60 * 1_000),
		).toBeNull()

		expect(
			(await handleSourceMapUploadRequest(uploadRequest({ release: release.release.name, digest }), {
				repositories: harness.repositories,
				artifacts: blobs,
				now: () => NOW_MS,
			})).status,
		).toBe(201)
		expect(
			(await handleSourceMapUploadRequest(uploadRequest({ release: release.release.name, digest }), {
				repositories: harness.repositories,
				artifacts: blobs,
				now: () => NOW_MS,
			})).status,
		).toBe(200)
		expect(logicalAssetPath('https://cdn.test/assets/admin/app.js?v=1')).toBe('assets/admin/app.js')
		expect(await harness.repositories.artifacts.sourceMapKey('source-notes', release.release.name, 'assets/admin/app.js')).toBe(
			`source-maps/objects/${digest.slice(0, 2)}/${digest}.map`,
		)

		const otherMap = SOURCE_MAP.replace('AAAA', 'BBBB')
		const otherDigest = await sha256Hex(otherMap)
		const before = blobs.puts
		expect(
			(await handleSourceMapUploadRequest(
				uploadRequest({
					release: release.release.name,
					body: otherMap,
					digest: otherDigest,
				}),
				{ repositories: harness.repositories, artifacts: blobs, now: () => NOW_MS },
			)).status,
		).toBe(409)
		expect(blobs.puts).toBe(before)
	})

	test('rejects authentication and coordinate drift before storing bytes', async () => {
		const harness = createHarness(() => NOW_MS)
		const blobs = new MemoryBlobs()
		await seedSource(harness, 'source-notes', 'notes')
		const release = projection({ runId: 'run-upload', verifier: await sha256Hex(BEARER) })
		await reconcileOperationsRelease(harness.repositories, release)
		if (release.release.kind !== 'available') throw new Error('expected release')
		const digest = await sha256Hex(SOURCE_MAP)
		expect(
			(await handleSourceMapUploadRequest(
				uploadRequest({
					release: release.release.name,
					bearer: 'd'.repeat(64),
					digest,
				}),
				{ repositories: harness.repositories, artifacts: blobs, now: () => NOW_MS },
			)).status,
		).toBe(401)
		expect(
			(await handleSourceMapUploadRequest(
				uploadRequest({
					release: release.release.name,
					environment: 'stage',
					digest,
				}),
				{ repositories: harness.repositories, artifacts: blobs, now: () => NOW_MS },
			)).status,
		).toBe(403)
		expect(blobs.puts).toBe(0)
	})

	test('reserves before put and retries a missing content object idempotently', async () => {
		const harness = createHarness(() => NOW_MS)
		const blobs = new MemoryBlobs()
		blobs.failNext = true
		await seedSource(harness, 'source-notes', 'notes')
		const release = projection({ runId: 'run-upload', verifier: await sha256Hex(BEARER) })
		await reconcileOperationsRelease(harness.repositories, release)
		if (release.release.kind !== 'available') throw new Error('expected release')
		const releaseName = release.release.name
		const digest = await sha256Hex(SOURCE_MAP)
		const request = (): Request => uploadRequest({ release: releaseName, digest })
		expect(
			(await handleSourceMapUploadRequest(request(), {
				repositories: harness.repositories,
				artifacts: blobs,
				now: () => NOW_MS,
			})).status,
		).toBe(503)
		expect(rows(harness, 'SELECT * FROM source_maps')).toHaveLength(1)
		expect(blobs.values.size).toBe(0)
		expect(
			(await handleSourceMapUploadRequest(request(), {
				repositories: harness.repositories,
				artifacts: blobs,
				now: () => NOW_MS,
			})).status,
		).toBe(200)
		expect(blobs.values.size).toBe(1)

		const resolved = await resolveFrames(
			[{
				filename: 'https://cdn.test/assets/admin/app.js?v=1',
				line: 1,
				column: 1,
			}],
			'source-notes',
			releaseName,
			operationsSourceMapReader(harness.repositories, blobs),
		)
		expect(resolved[0]?.resolved).toBeTrue()
	})

	test("never resolves another source's map for the same release name and asset path", async () => {
		const harness = createHarness(() => NOW_MS)
		const blobs = new MemoryBlobs()
		await seedSource(harness, 'source-notes', 'notes')
		await seedSource(harness, 'source-shop', 'shop')
		const release = projection({ runId: 'run-upload', appId: 'shop', verifier: await sha256Hex(BEARER) })
		await reconcileOperationsRelease(harness.repositories, release)
		if (release.release.kind !== 'available') throw new Error('expected release')
		const releaseName = release.release.name
		const digest = await sha256Hex(SOURCE_MAP)
		expect(
			(await handleSourceMapUploadRequest(uploadRequest({ appId: 'shop', release: releaseName, digest }), {
				repositories: harness.repositories,
				artifacts: blobs,
				now: () => NOW_MS,
			})).status,
		).toBe(201)

		expect(await harness.repositories.artifacts.sourceMapKey('source-shop', releaseName, 'assets/admin/app.js')).toBe(
			`source-maps/objects/${digest.slice(0, 2)}/${digest}.map`,
		)
		expect(await harness.repositories.artifacts.sourceMapKey('source-notes', releaseName, 'assets/admin/app.js')).toBeNull()

		const frames = [{ filename: 'https://cdn.test/assets/admin/app.js?v=1', line: 1, column: 1 }]
		const reader = operationsSourceMapReader(harness.repositories, blobs)
		const owner = await resolveFrames(frames, 'source-shop', releaseName, reader)
		expect(owner[0]?.resolved).toBeTrue()
		const foreign = await resolveFrames(frames, 'source-notes', releaseName, reader)
		expect(foreign[0]?.resolved).toBeFalse()
		expect(foreign[0]?.source).toBeUndefined()
		expect(foreign[0]?.file).toBe('https://cdn.test/assets/admin/app.js?v=1')
	})
})
