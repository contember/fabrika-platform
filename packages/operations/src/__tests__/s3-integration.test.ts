import {
	type IngestMessage,
	OPERATIONS_ARTIFACT_HEADERS,
	OPERATIONS_RELEASE_PROTOCOL_VERSION,
	operationsReleaseName,
	type OperationsReleaseReconcileRequestV1,
} from '@fabrika/operations-contract'
import type { BlobStore } from '@fabrika/platform'
import { S3BlobStore, type S3BlobStoreOptions } from '@fabrika/platform-node'
import { afterAll, describe, expect, test } from 'bun:test'
import { handleSourceMapUploadRequest, operationsSourceMapReader } from '../artifact-upload.js'
import { parseEventDetail } from '../event-detail.js'
import { sha256Hex } from '../ingest.js'
import { eventBlobKey, persistIngest } from '../pipeline.js'
import { reconcileOperationsRelease } from '../releases.js'
import { createHarness } from './helpers/sqlite.js'

const PREFIX = 'FABRIKA_TEST_S3_'
const REQUIRED_NAMES = [`${PREFIX}BUCKET`, `${PREFIX}ACCESS_KEY_ID`, `${PREFIX}SECRET_ACCESS_KEY`]
const SKIP_REASON = `skipped: set ${PREFIX}BUCKET / ${PREFIX}ACCESS_KEY_ID / ${PREFIX}SECRET_ACCESS_KEY to run the S3-backed tests`
const NOW_MS = 1_700_000_000_000
const BEARER = 'c'.repeat(64)
const COMMIT = 'a'.repeat(40)
const SOURCE_MAP = JSON.stringify({
	version: 3,
	file: 'app.js',
	sources: ['src/app.ts'],
	names: [],
	mappings: 'AAAA',
	sourcesContent: ['throw new Error("boom")'],
})

const s3Options = readS3Options(process.env)
const hasS3 = s3Options !== null

if (!hasS3) console.warn(`s3-integration.test.ts ${SKIP_REASON}`)

class PrefixedBlobStore implements BlobStore {
	readonly writtenKeys = new Set<string>()

	constructor(private readonly store: BlobStore, private readonly prefix: string) {}

	async put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<void> {
		const physicalKey = this.physicalKey(key)
		await this.store.put(physicalKey, value)
		this.writtenKeys.add(physicalKey)
	}

	get(key: string): Promise<{ body: ReadableStream; text(): Promise<string> } | null> {
		return this.store.get(this.physicalKey(key))
	}

	async delete(key: string): Promise<void> {
		const physicalKey = this.physicalKey(key)
		await this.store.delete(physicalKey)
		this.writtenKeys.delete(physicalKey)
	}

	async cleanup(): Promise<void> {
		await Promise.all([...this.writtenKeys].map((key) => this.store.delete(key)))
		this.writtenKeys.clear()
	}

	private physicalKey(key: string): string {
		return `${this.prefix}/${key}`
	}
}

const blobs = s3Options === null
	? null
	: new PrefixedBlobStore(
		S3BlobStore.connect(s3Options),
		`operations-tests/${Date.now()}-${crypto.randomUUID()}`,
	)

afterAll(async () => {
	await blobs?.cleanup()
})

describe.skipIf(!hasS3)('Operations S3 integration', () => {
	test('persists event payloads and source-map artifacts through Operations flows', async () => {
		if (blobs === null) throw new Error('S3 test store is unavailable')
		const harness = createHarness(() => NOW_MS)
		await harness.repositories.sources.upsert({
			id: 'source-notes',
			appId: 'notes',
			environment: 'prod',
			displayName: 'notes / prod',
			enabled: true,
		})

		const releaseName = operationsReleaseName({
			appId: 'notes',
			environment: 'prod',
			commitSha: COMMIT,
		})
		const release: OperationsReleaseReconcileRequestV1 = {
			protocolVersion: OPERATIONS_RELEASE_PROTOCOL_VERSION,
			revision: 1,
			runId: 'run-s3-integration',
			coordinate: { appId: 'notes', environment: 'prod' },
			phase: 'started',
			providerRunId: null,
			outcome: null,
			artifactState: 'pending',
			release: {
				kind: 'available',
				name: releaseName,
				commitSha: COMMIT,
			},
			uploadCredential: {
				verifier: await sha256Hex(BEARER),
				expiresAt: NOW_MS + 60_000,
			},
			observedAt: NOW_MS,
		}
		expect((await reconcileOperationsRelease(harness.repositories, release)).outcome).toBe('applied')

		const digest = await sha256Hex(SOURCE_MAP)
		const upload = await handleSourceMapUploadRequest(
			new Request('https://operations.test/api/artifacts/source-maps/', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${BEARER}`,
					'content-type': 'application/json',
					[OPERATIONS_ARTIFACT_HEADERS.appId]: 'notes',
					[OPERATIONS_ARTIFACT_HEADERS.environment]: 'prod',
					[OPERATIONS_ARTIFACT_HEADERS.serviceKey]: 'default',
					[OPERATIONS_ARTIFACT_HEADERS.release]: releaseName,
					[OPERATIONS_ARTIFACT_HEADERS.runId]: release.runId,
					[OPERATIONS_ARTIFACT_HEADERS.logicalPath]: 'https://cdn.test/assets/admin/app.js?v=1',
					[OPERATIONS_ARTIFACT_HEADERS.digest]: digest,
				},
				body: SOURCE_MAP,
			}),
			{
				repositories: harness.repositories,
				artifacts: blobs,
				now: () => NOW_MS,
			},
		)
		expect(upload.status).toBe(201)

		const message: IngestMessage = {
			projectId: 'source-notes',
			fingerprint: 'fingerprint-s3-integration',
			eventId: 'event-s3-integration',
			title: 'Error: boom',
			culprit: 'assets/admin/app.js',
			level: 'error',
			release: releaseName,
			environment: 'prod',
			receivedAt: NOW_MS,
			payload: {
				event_id: 'event-s3-integration',
				platform: 'javascript',
				release: releaseName,
				environment: 'prod',
				exception: {
					values: [{
						type: 'Error',
						value: 'boom',
						stacktrace: {
							frames: [{
								filename: 'https://cdn.test/assets/admin/app.js?v=1',
								lineno: 1,
								colno: 1,
								in_app: true,
							}],
						},
					}],
				},
			},
		}
		const persisted = await persistIngest(
			{
				repositories: harness.repositories,
				payloads: blobs,
				ingestQueue: { send: () => Promise.resolve() },
			},
			message,
		)
		expect(persisted.duplicate).toBeFalse()

		const payload = await blobs.get(eventBlobKey(message))
		expect(payload).not.toBeNull()
		if (payload === null) throw new Error('persisted event payload is missing')
		const detail = await parseEventDetail(
			await payload.text(),
			operationsSourceMapReader(harness.repositories, blobs),
		)
		expect(detail.eventId).toBe(message.eventId)
		expect(detail.release).toBe(releaseName)
		expect(detail.exceptions[0]?.frames[0]).toMatchObject({
			file: 'src/app.ts',
			line: 1,
			column: 1,
			resolved: true,
		})

		const sourceMap = await operationsSourceMapReader(harness.repositories, blobs).getSourceMap?.(
			releaseName,
			'assets/admin/app.js',
		)
		expect(await sourceMap?.text()).toBe(SOURCE_MAP)
	})
})

interface S3TestEnvironment {
	[name: string]: string | undefined
}

function readS3Options(environment: S3TestEnvironment): S3BlobStoreOptions | null {
	const configured = REQUIRED_NAMES.filter((name) => present(environment[name]))
	if (configured.length === 0) return null
	const missing = REQUIRED_NAMES.filter((name) => !present(environment[name]))
	if (missing.length > 0) throw new Error(`Incomplete S3 test configuration; missing ${missing.join(', ')}`)
	const endpoint = optional(environment[`${PREFIX}ENDPOINT`])
	return {
		bucket: required(environment, `${PREFIX}BUCKET`),
		accessKeyId: required(environment, `${PREFIX}ACCESS_KEY_ID`),
		secretAccessKey: required(environment, `${PREFIX}SECRET_ACCESS_KEY`),
		virtualHostedStyle: false,
		region: optional(environment[`${PREFIX}REGION`]) ?? 'auto',
		...(endpoint === undefined ? {} : { endpoint }),
	}
}

function present(value: string | undefined): boolean {
	return value !== undefined && value !== ''
}

function optional(value: string | undefined): string | undefined {
	return present(value) ? value : undefined
}

function required(environment: S3TestEnvironment, name: string): string {
	const value = environment[name]
	if (value === undefined || value === '') throw new Error(`Missing ${name}`)
	return value
}
