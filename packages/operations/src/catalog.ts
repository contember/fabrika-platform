import {
	canonicalOperationsCatalogSources,
	type OperationsCatalogReconcileRequest,
	type OperationsCatalogReconcileResponse,
	operationsCatalogSnapshotHash,
} from '@fabrika/operations-contract/catalog'
import { z } from 'zod'
import { reconcileSourceIngestCredential } from './credentials.js'
import type { OperationsRepositories } from './repositories.js'
import { CatalogRevisionConflictError } from './repositories.js'

const MAX_CATALOG_BODY_BYTES = 1024 * 1024
const MAX_CATALOG_SOURCES = 10_000
const COORDINATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SERVICE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/
const HASH_PATTERN = /^[0-9a-f]{64}$/

const coordinateSchema = z.object({
	appId: z.string().regex(COORDINATE_PATTERN),
	environment: z.string().regex(COORDINATE_PATTERN),
	serviceKey: z.string().regex(SERVICE_KEY_PATTERN).optional(),
}).transform(({ appId, environment, serviceKey }) => ({ appId, environment, ...(serviceKey === undefined ? {} : { serviceKey }) }))
const catalogSourceSchema = z.object({
	coordinate: coordinateSchema,
	displayName: z.string().max(256).refine((value) => value.trim() !== ''),
	publicOrigin: z.string().max(2_048).refine(validPublicOrigin).nullable().optional(),
	ingestCredential: z.object({
		id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
		publicKey: z.string().regex(/^[0-9a-f]{32}$/),
	}),
}).transform(({ publicOrigin, ...source }) => ({ ...source, ...(publicOrigin === undefined ? {} : { publicOrigin }) }))
const catalogRequestSchema = z.object({
	revision: z.number().int().safe().min(1),
	snapshotHash: z.string().regex(HASH_PATTERN),
	sources: z.array(catalogSourceSchema).max(MAX_CATALOG_SOURCES),
})

export interface CatalogHandlerOptions {
	repositories: OperationsRepositories
	syncKey: string
}

export async function reconcileOperationsCatalog(
	repositories: OperationsRepositories,
	request: OperationsCatalogReconcileRequest,
): Promise<OperationsCatalogReconcileResponse> {
	const sources = canonicalOperationsCatalogSources(request.sources)
	assertUniqueCoordinates(sources)
	const hash = await operationsCatalogSnapshotHash(sources)
	if (hash !== request.snapshotHash) throw new CatalogRequestError(400, 'catalog snapshot hash does not match content')
	const response = await repositories.catalog.reconcile({
		revision: request.revision,
		snapshotHash: request.snapshotHash,
		sources,
	})
	if (response.outcome === 'stale') return { ...response, ingest: [] }
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

export function parseCatalogRequest(value: unknown): OperationsCatalogReconcileRequest {
	const result = catalogRequestSchema.safeParse(value)
	if (!result.success) {
		const issue = result.error.issues[0]
		const field = issue?.path[0]
		let message = 'invalid catalog request'
		if (field === 'revision') message = 'invalid catalog revision'
		else if (field === 'snapshotHash') message = 'invalid catalog snapshot hash'
		else if (field === 'sources') {
			message = issue.path.length === 1 ? 'invalid catalog sources' : 'invalid catalog source'
			if (issue.path.length === 3 && issue.path[2] === 'coordinate') message = 'invalid source coordinate'
		}
		throw new CatalogRequestError(400, message)
	}
	assertUniqueCoordinates(canonicalOperationsCatalogSources(result.data.sources))
	return result.data
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
