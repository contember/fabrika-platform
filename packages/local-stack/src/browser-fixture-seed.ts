/** Local-only Operations fixture seeding through the private projection protocols. */
import {
	DEFAULT_OPERATIONS_SERVICE_KEY,
	OPERATIONS_ARTIFACT_HEADERS,
	OPERATIONS_CATALOG_PROTOCOL_VERSION,
	OPERATIONS_RELEASE_PROTOCOL_VERSION,
	type OperationsCatalogReconcileResponseV2,
	operationsCatalogSnapshotHash,
	type OperationsCatalogSourceV2,
	operationsReleaseName,
	type OperationsReleaseReconcileRequestV1,
} from '@fabrika/operations-contract'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const INTERNAL_ORIGIN = 'http://127.0.0.1:3000'
const OUTPUT_DIR = resolve(import.meta.dir, '..', '.state')
const OUTPUT_FILE = resolve(OUTPUT_DIR, 'browser-fixtures.json')
const COMMIT_SHA = 'b'.repeat(40)
const NEXT_COMMIT_SHA = 'c'.repeat(40)

const source = (appId: string, environment: string, displayName: string): OperationsCatalogSourceV2 => ({
	coordinate: { appId, environment },
	displayName,
	publicOrigin: 'http://control:3000',
	ingestCredential: {
		id: randomUUID(),
		publicKey: randomBytes(16).toString('hex'),
	},
})

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringProperty(value: unknown, key: string): string {
	if (!isRecord(value) || typeof value[key] !== 'string' || value[key] === '') throw new Error(`fixture response is missing ${key}`)
	return value[key]
}

async function postPrivate(path: string, body: unknown): Promise<unknown> {
	const syncKey = process.env['OPERATIONS_SYNC_KEY']
	if (syncKey === undefined || syncKey.length < 32) throw new Error('OPERATIONS_SYNC_KEY is required')
	const response = await fetch(`${INTERNAL_ORIGIN}${path}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${syncKey}`, 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})
	if (!response.ok) throw new Error(`fixture projection failed with status ${response.status}`)
	return response.json()
}

async function projectRelease(
	source: OperationsCatalogSourceV2,
	commitSha = COMMIT_SHA,
): Promise<{ name: string; runId: string; uploadBearer: string }> {
	const appId = source.coordinate.appId
	const environment = source.coordinate.environment
	const runId = randomUUID()
	const uploadBearer = randomBytes(32).toString('hex')
	const name = operationsReleaseName({ appId, environment, commitSha })
	const verifier = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uploadBearer))
	const request: OperationsReleaseReconcileRequestV1 = {
		protocolVersion: OPERATIONS_RELEASE_PROTOCOL_VERSION,
		revision: 1,
		runId,
		coordinate: { appId, environment },
		phase: 'provider_accepted',
		providerRunId: `browser-${runId}`,
		outcome: null,
		artifactState: 'pending',
		release: {
			kind: 'available',
			name,
			commitSha,
		},
		uploadCredential: {
			verifier: [...new Uint8Array(verifier)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
			expiresAt: Date.now() + 60 * 60 * 1000,
		},
		observedAt: Date.now(),
	}
	await postPrivate('/private/releases/reconcile', request)
	return { name, runId, uploadBearer }
}

async function seed(): Promise<void> {
	const visible = source('browser-notes', 'test', 'Browser Notes / test')
	const hidden = source('browser-hidden', 'secret', 'Hidden sibling / secret')
	const sources = [visible, hidden]
	const catalog = await postPrivate('/private/catalog/reconcile', {
		protocolVersion: OPERATIONS_CATALOG_PROTOCOL_VERSION,
		revision: 1,
		snapshotHash: await operationsCatalogSnapshotHash(sources),
		sources,
	})
	const ingest = parseCatalogIngest(catalog)
	const [visibleRelease, visibleNextRelease, hiddenRelease] = await Promise.all([
		projectRelease(visible),
		projectRelease(visible, NEXT_COMMIT_SHA),
		projectRelease(hidden),
	])
	await uploadSourceMap(visible, visibleRelease)

	mkdirSync(OUTPUT_DIR, { recursive: true, mode: 0o700 })
	chmodSync(OUTPUT_DIR, 0o700)
	await Bun.write(
		OUTPUT_FILE,
		`${
			JSON.stringify(
				{
					version: 1,
					visible: fixtureSource(visible, ingest, visibleRelease, visibleNextRelease),
					hidden: fixtureSource(hidden, ingest, hiddenRelease),
				},
				null,
				'\t',
			)
		}\n`,
	)
	chmodSync(OUTPUT_FILE, 0o600)
}

async function uploadSourceMap(
	source: OperationsCatalogSourceV2,
	release: { name: string; runId: string; uploadBearer: string },
): Promise<void> {
	const body = JSON.stringify({
		version: 3,
		file: 'browser.js',
		sources: ['src/browser-fixture.ts'],
		names: [],
		mappings: 'AAAA',
		sourcesContent: ["throw new Error('Browser fixture primary failure')"],
	})
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
	const digestHex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
	const response = await fetch('http://errors.fabrika.localhost:3000/api/artifacts/source-maps/', {
		method: 'POST',
		headers: {
			authorization: `Bearer ${release.uploadBearer}`,
			'content-type': 'application/json',
			[OPERATIONS_ARTIFACT_HEADERS.appId]: source.coordinate.appId,
			[OPERATIONS_ARTIFACT_HEADERS.environment]: source.coordinate.environment,
			[OPERATIONS_ARTIFACT_HEADERS.serviceKey]: DEFAULT_OPERATIONS_SERVICE_KEY,
			[OPERATIONS_ARTIFACT_HEADERS.release]: release.name,
			[OPERATIONS_ARTIFACT_HEADERS.runId]: release.runId,
			[OPERATIONS_ARTIFACT_HEADERS.logicalPath]: 'http://control:3000/assets/browser.js',
			[OPERATIONS_ARTIFACT_HEADERS.digest]: digestHex,
		},
		body,
	})
	if (!response.ok) throw new Error(`browser source-map fixture failed with status ${response.status}`)
}

function parseCatalogIngest(value: unknown): OperationsCatalogReconcileResponseV2['ingest'] {
	if (!isRecord(value) || !Array.isArray(value['ingest'])) throw new Error('catalog fixture response is invalid')
	return value['ingest'].map((entry) => {
		if (!isRecord(entry) || !isRecord(entry['coordinate'])) throw new Error('catalog fixture response is invalid')
		return {
			coordinate: {
				appId: stringProperty(entry['coordinate'], 'appId'),
				environment: stringProperty(entry['coordinate'], 'environment'),
				serviceKey: stringProperty(entry['coordinate'], 'serviceKey'),
			},
			credentialId: stringProperty(entry, 'credentialId'),
			ingestProjectId: stringProperty(entry, 'ingestProjectId'),
		}
	})
}

function fixtureSource(
	source: OperationsCatalogSourceV2,
	ingest: OperationsCatalogReconcileResponseV2['ingest'],
	release: { name: string; runId: string; uploadBearer: string },
	nextRelease?: { name: string; runId: string; uploadBearer: string },
) {
	const appId = source.coordinate.appId
	const environment = source.coordinate.environment
	const projected = ingest.find((candidate) => candidate.coordinate.appId === appId && candidate.coordinate.environment === environment)
	if (projected === undefined) throw new Error('catalog fixture response omitted a source')
	return {
		appId,
		environment,
		serviceKey: DEFAULT_OPERATIONS_SERVICE_KEY,
		displayName: source.displayName,
		credentialId: source.ingestCredential.id,
		publicKey: source.ingestCredential.publicKey,
		ingestProjectId: projected.ingestProjectId,
		release,
		...(nextRelease === undefined ? {} : { nextRelease }),
	}
}

if (import.meta.main) {
	seed().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : 'Operations browser fixture setup failed')
		process.exit(1)
	})
}
