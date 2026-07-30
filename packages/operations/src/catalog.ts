import {
	canonicalOperationsCatalogSources,
	OPERATIONS_CATALOG_PROTOCOL_VERSION,
	type OperationsCatalogReconcileRequestV2,
	type OperationsCatalogReconcileResponseV2,
	operationsCatalogSnapshotHash,
	type OperationsCatalogSourceV2,
} from '@fabrika/operations-contract/catalog'
import { reconcileSourceIngestCredential } from './credentials.js'
import type { OperationsRepositories } from './repositories.js'
import { CatalogRevisionConflictError } from './repositories.js'

const MAX_CATALOG_BODY_BYTES = 1024 * 1024
const MAX_CATALOG_SOURCES = 10_000
const COORDINATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SERVICE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/
const HASH_PATTERN = /^[0-9a-f]{64}$/

export interface CatalogHandlerOptions {
	repositories: OperationsRepositories
	syncKey: string
}

export async function reconcileOperationsCatalog(
	repositories: OperationsRepositories,
	request: OperationsCatalogReconcileRequestV2,
): Promise<OperationsCatalogReconcileResponseV2> {
	const sources = canonicalOperationsCatalogSources(request.sources)
	assertUniqueCoordinates(sources)
	const hash = await operationsCatalogSnapshotHash(sources)
	if (hash !== request.snapshotHash) throw new CatalogRequestError(400, 'catalog snapshot hash does not match content')
	const response = await repositories.catalog.reconcile({
		revision: request.revision,
		snapshotHash: request.snapshotHash,
		sources,
	})
	if (response.outcome === 'stale') return response
	const ingest = []
	for (const source of sources) {
		const stored = await repositories.sources.getByCoordinate(
			source.coordinate.appId,
			source.coordinate.environment,
			source.coordinate.serviceKey,
		)
		if (stored === null) throw new Error('reconciled Operations source is unavailable')
		const accepted = await reconcileSourceIngestCredential(repositories, {
			sourceId: stored.id,
			credentialId: source.ingestCredential.id,
			publicKey: source.ingestCredential.publicKey,
		})
		ingest.push({
			coordinate: source.coordinate,
			credentialId: accepted.credentialId,
			ingestProjectId: accepted.ingestProjectId,
		})
	}
	return { ...response, ingest }
}

export async function handleOperationsCatalogRequest(request: Request, options: CatalogHandlerOptions): Promise<Response> {
	if (request.method !== 'POST') {
		return jsonError(405, 'method not allowed', { Allow: 'POST' })
	}
	if (!(await validBearer(request.headers.get('authorization'), options.syncKey))) {
		return jsonError(401, 'unauthorized')
	}
	const declaredLength = Number(request.headers.get('content-length'))
	if (Number.isFinite(declaredLength) && declaredLength > MAX_CATALOG_BODY_BYTES) {
		return jsonError(413, 'payload too large')
	}
	let raw: string
	try {
		raw = await request.text()
	} catch {
		return jsonError(400, 'malformed request')
	}
	if (new TextEncoder().encode(raw).length > MAX_CATALOG_BODY_BYTES) {
		return jsonError(413, 'payload too large')
	}
	try {
		const parsed: unknown = JSON.parse(raw)
		const input = parseCatalogRequest(parsed)
		return Response.json(await reconcileOperationsCatalog(options.repositories, input))
	} catch (error) {
		if (error instanceof CatalogRequestError) return jsonError(error.status, error.message)
		if (error instanceof CatalogRevisionConflictError) return jsonError(409, error.message)
		console.error('operations catalog reconcile failed')
		return jsonError(500, 'internal error')
	}
}

export function parseCatalogRequest(value: unknown): OperationsCatalogReconcileRequestV2 {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new CatalogRequestError(400, 'invalid catalog request')
	}
	const protocolVersion = Reflect.get(value, 'protocolVersion')
	const revision = Reflect.get(value, 'revision')
	const snapshotHash = Reflect.get(value, 'snapshotHash')
	const rawSources = Reflect.get(value, 'sources')
	if (protocolVersion !== OPERATIONS_CATALOG_PROTOCOL_VERSION) {
		throw new CatalogRequestError(400, 'unsupported catalog protocol version')
	}
	if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
		throw new CatalogRequestError(400, 'invalid catalog revision')
	}
	if (typeof snapshotHash !== 'string' || !HASH_PATTERN.test(snapshotHash)) {
		throw new CatalogRequestError(400, 'invalid catalog snapshot hash')
	}
	if (!Array.isArray(rawSources) || rawSources.length > MAX_CATALOG_SOURCES) {
		throw new CatalogRequestError(400, 'invalid catalog sources')
	}
	const sources = rawSources.map(parseCatalogSource)
	assertUniqueCoordinates(canonicalOperationsCatalogSources(sources))
	return {
		protocolVersion: OPERATIONS_CATALOG_PROTOCOL_VERSION,
		revision,
		snapshotHash,
		sources,
	}
}

function parseCatalogSource(value: unknown): OperationsCatalogSourceV2 {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new CatalogRequestError(400, 'invalid catalog source')
	}
	const coordinate = Reflect.get(value, 'coordinate')
	const displayName = Reflect.get(value, 'displayName')
	const publicOrigin = Reflect.get(value, 'publicOrigin')
	const ingestCredential = Reflect.get(value, 'ingestCredential')
	if (typeof coordinate !== 'object' || coordinate === null || Array.isArray(coordinate)) {
		throw new CatalogRequestError(400, 'invalid source coordinate')
	}
	const appId = Reflect.get(coordinate, 'appId')
	const environment = Reflect.get(coordinate, 'environment')
	const serviceKey = Reflect.get(coordinate, 'serviceKey')
	if (
		typeof appId !== 'string'
		|| !COORDINATE_PATTERN.test(appId)
		|| typeof environment !== 'string'
		|| !COORDINATE_PATTERN.test(environment)
		|| (serviceKey !== undefined && (typeof serviceKey !== 'string' || !SERVICE_KEY_PATTERN.test(serviceKey)))
		|| typeof displayName !== 'string'
		|| displayName.trim() === ''
		|| displayName.length > 256
		|| (publicOrigin !== undefined && publicOrigin !== null && !validPublicOrigin(publicOrigin))
		|| typeof ingestCredential !== 'object'
		|| ingestCredential === null
		|| Array.isArray(ingestCredential)
		|| !validCredentialId(Reflect.get(ingestCredential, 'id'))
		|| !validPublicKey(Reflect.get(ingestCredential, 'publicKey'))
	) {
		throw new CatalogRequestError(400, 'invalid catalog source')
	}
	const credentialId = Reflect.get(ingestCredential, 'id')
	const publicKey = Reflect.get(ingestCredential, 'publicKey')
	if (typeof credentialId !== 'string' || typeof publicKey !== 'string') {
		throw new CatalogRequestError(400, 'invalid catalog source')
	}
	return {
		coordinate: {
			appId,
			environment,
			...(serviceKey === undefined ? {} : { serviceKey }),
		},
		displayName,
		...(publicOrigin === undefined ? {} : { publicOrigin }),
		ingestCredential: { id: credentialId, publicKey },
	}
}

function validCredentialId(value: unknown): boolean {
	return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
}

function validPublicKey(value: unknown): boolean {
	return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
}

function validPublicOrigin(value: unknown): boolean {
	if (typeof value !== 'string' || value.length > 2_048) return false
	try {
		const url = new URL(value)
		return (url.protocol === 'https:' || url.protocol === 'http:')
			&& url.origin === value
			&& url.username === ''
			&& url.password === ''
	} catch {
		return false
	}
}

function assertUniqueCoordinates(sources: ReturnType<typeof canonicalOperationsCatalogSources>): void {
	const seen = new Set<string>()
	for (const source of sources) {
		const key = JSON.stringify([
			source.coordinate.appId,
			source.coordinate.environment,
			source.coordinate.serviceKey,
		])
		if (seen.has(key)) throw new CatalogRequestError(400, 'duplicate source coordinate')
		seen.add(key)
	}
}

async function validBearer(header: string | null, expected: string): Promise<boolean> {
	if (expected.length < 32 || header === null || !header.startsWith('Bearer ')) return false
	const supplied = header.slice('Bearer '.length)
	if (supplied.length === 0) return false
	const [left, right] = await Promise.all([sha256(supplied), sha256(expected)])
	let difference = left.length ^ right.length
	const length = Math.max(left.length, right.length)
	for (let index = 0; index < length; index++) {
		difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
	}
	return difference === 0
}

async function sha256(value: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

function jsonError(status: number, message: string, headers?: HeadersInit): Response {
	return Response.json({ error: message }, { status, headers })
}

class CatalogRequestError extends Error {
	constructor(readonly status: number, message: string) {
		super(message)
	}
}
