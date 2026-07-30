import {
	OPERATIONS_ARTIFACT_HEADERS,
	OPERATIONS_RELEASE_PROTOCOL_VERSION,
	type OperationsReleaseAvailabilityV1,
	operationsReleaseName,
	type OperationsReleaseReconcileRequestV1,
} from '@fabrika/operations-contract'
import type { BlobStore } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { handleSourceMapUploadRequest, operationsSourceMapReader } from '../artifact-upload.js'
import { sha256Hex } from '../ingest.js'
import { handleOperationsReleaseRequest, reconcileOperationsRelease } from '../releases.js'
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
	dryRun?: boolean
	verifier?: string
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
		outcome: phase === 'terminal' ? 'succeeded' : null,
		artifactState: release.kind === 'available' ? (phase === 'terminal' ? 'incomplete' : 'pending') : 'not_applicable',
		release,
		...(release.kind === 'available' && input.verifier !== undefined
			? { uploadCredential: { verifier: input.verifier, expiresAt: NOW_MS + 2 * 60 * 60 * 1_000 } }
			: {}),
		observedAt: NOW_MS + (input.revision ?? 1),
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
	environment?: string
	path?: string
	digest: string
}): Request {
	return new Request('https://operations.test/api/artifacts/source-maps/', {
		method: 'POST',
		headers: {
			authorization: `Bearer ${input.bearer ?? BEARER}`,
			'content-type': 'application/json',
			[OPERATIONS_ARTIFACT_HEADERS.appId]: 'notes',
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
		expect(await harness.repositories.artifacts.sourceMapKey(release.release.name, 'assets/admin/app.js')).toBe(
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
			releaseName,
			operationsSourceMapReader(harness.repositories, blobs),
		)
		expect(resolved[0]?.resolved).toBeTrue()
	})
})
