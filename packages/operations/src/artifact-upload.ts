import { OPERATIONS_ARTIFACT_HEADERS, OPERATIONS_SOURCE_MAP_UPLOAD_PATH } from '@fabrika/operations-contract'
import type { BlobStore } from '@fabrika/platform'
import { sha256Hex } from './ingest.js'
import type { ArtifactUploadCredentialResolution, OperationsRepositories } from './repositories.js'
import { logicalAssetPath, type ObjectReader } from './source-maps.js'
import { uuidv7 } from './uuid.js'

export const MAX_SOURCE_MAP_BYTES = 8 * 1024 * 1024
export const MAX_SOURCE_MAPS_PER_RUN = 256
export const MAX_SOURCE_MAP_BYTES_PER_RUN = 64 * 1024 * 1024

const HASH_PATTERN = /^[0-9a-f]{64}$/
const ACCEPTED_CONTENT_TYPES = new Set(['application/json', 'application/octet-stream'])

export interface ArtifactUploadOptions {
	repositories: OperationsRepositories
	artifacts: BlobStore
	now?: () => number
}

export async function handleSourceMapUploadRequest(request: Request, options: ArtifactUploadOptions): Promise<Response> {
	const url = new URL(request.url)
	if (url.pathname !== OPERATIONS_SOURCE_MAP_UPLOAD_PATH) return jsonError(404, 'not found')
	if (request.method !== 'POST') return jsonError(405, 'method not allowed', { Allow: 'POST' })
	const bearer = parseBearer(request.headers.get('authorization'))
	if (bearer === null) return jsonError(401, 'unauthorized')
	let credential: ArtifactUploadCredentialResolution | null
	try {
		credential = await options.repositories.artifacts.resolveUploadCredential(await sha256Hex(bearer), (options.now ?? Date.now)())
	} catch {
		return jsonError(503, 'temporarily unavailable')
	}
	if (credential === null) return jsonError(401, 'unauthorized')
	if (
		request.headers.get(OPERATIONS_ARTIFACT_HEADERS.appId) !== credential.app_id
		|| request.headers.get(OPERATIONS_ARTIFACT_HEADERS.environment) !== credential.environment
		|| request.headers.get(OPERATIONS_ARTIFACT_HEADERS.serviceKey) !== credential.service_key
		|| request.headers.get(OPERATIONS_ARTIFACT_HEADERS.release) !== credential.release_name
		|| request.headers.get(OPERATIONS_ARTIFACT_HEADERS.runId) !== credential.run_id
	) {
		return jsonError(403, 'artifact scope does not match credential')
	}
	const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
	if (contentType === undefined || !ACCEPTED_CONTENT_TYPES.has(contentType)) {
		return jsonError(415, 'content type is not supported')
	}
	const rawPath = request.headers.get(OPERATIONS_ARTIFACT_HEADERS.logicalPath)
	const claimedDigest = request.headers.get(OPERATIONS_ARTIFACT_HEADERS.digest)
	if (rawPath === null || claimedDigest === null || !HASH_PATTERN.test(claimedDigest)) {
		return jsonError(400, 'invalid artifact metadata')
	}
	let logicalPath: string
	try {
		logicalPath = logicalAssetPath(rawPath)
	} catch {
		return jsonError(400, 'invalid logical artifact path')
	}
	const declaredLength = request.headers.get('content-length')
	if (declaredLength !== null) {
		if (!/^[0-9]+$/.test(declaredLength)) return jsonError(400, 'invalid content length')
		const length = Number(declaredLength)
		if (!Number.isSafeInteger(length)) return jsonError(400, 'invalid content length')
		if (length > MAX_SOURCE_MAP_BYTES) return jsonError(413, 'artifact too large')
	}
	const body = await readLimitedBody(request, MAX_SOURCE_MAP_BYTES)
	if (body.kind === 'too_large') return jsonError(413, 'artifact too large')
	if (body.kind === 'unreadable') return jsonError(400, 'unreadable artifact')
	const digest = await sha256Bytes(body.bytes)
	if (digest !== claimedDigest) return jsonError(400, 'artifact digest does not match body')
	if (!validSourceMap(body.bytes)) return jsonError(400, 'invalid source map')

	const blobKey = `source-maps/objects/${digest.slice(0, 2)}/${digest}.map`
	try {
		const result = await options.repositories.artifacts.indexSourceMap({
			credentialId: credential.credential_id,
			releaseId: credential.release_id,
			logicalPath,
			digest,
			byteLength: body.bytes.length,
			blobKey,
			operationId: uuidv7((options.now ?? Date.now)()),
			maxArtifacts: MAX_SOURCE_MAPS_PER_RUN,
			maxBytes: MAX_SOURCE_MAP_BYTES_PER_RUN,
		})
		if (result === 'conflict') return jsonError(409, 'logical artifact path already has different content')
		if (result === 'limit') return jsonError(429, 'artifact quota exceeded')
		// Reserve the immutable logical path before writing. A failed put leaves a retryable index;
		// the same digest returns `unchanged` and fills the missing content-addressed object.
		await options.artifacts.put(blobKey, arrayBuffer(body.bytes))
		return Response.json({ digest, logicalPath, outcome: result }, { status: result === 'inserted' ? 201 : 200 })
	} catch {
		return jsonError(503, 'temporarily unavailable')
	}
}

export function operationsSourceMapReader(
	repositories: OperationsRepositories,
	artifacts: BlobStore,
): ObjectReader {
	return {
		get: () => Promise.resolve(null),
		async getSourceMap(releaseName, logicalPath) {
			const key = await repositories.artifacts.sourceMapKey(releaseName, logicalPath)
			return key === null ? null : artifacts.get(key)
		},
	}
}

type LimitedBody =
	| { kind: 'ok'; bytes: Uint8Array }
	| { kind: 'too_large' }
	| { kind: 'unreadable' }

async function readLimitedBody(request: Request, limit: number): Promise<LimitedBody> {
	if (request.body === null) return { kind: 'ok', bytes: new Uint8Array() }
	const reader = request.body.getReader()
	const chunks: Uint8Array[] = []
	let length = 0
	try {
		for (;;) {
			const next = await reader.read()
			if (next.done) break
			length += next.value.length
			if (length > limit) {
				await reader.cancel().catch(() => {})
				return { kind: 'too_large' }
			}
			chunks.push(next.value)
		}
	} catch {
		return { kind: 'unreadable' }
	}
	const bytes = new Uint8Array(length)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.length
	}
	return { kind: 'ok', bytes }
}

function validSourceMap(bytes: Uint8Array): boolean {
	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes))
	} catch {
		return false
	}
	return typeof parsed === 'object'
		&& parsed !== null
		&& !Array.isArray(parsed)
		&& 'version' in parsed
		&& 'mappings' in parsed
		&& typeof parsed.mappings === 'string'
		&& 'sources' in parsed
		&& Array.isArray(parsed.sources)
}

function parseBearer(header: string | null): string | null {
	if (header === null || !header.startsWith('Bearer ')) return null
	const value = header.slice('Bearer '.length)
	return /^[0-9a-f]{64}$/.test(value) ? value : null
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', arrayBuffer(bytes)))
	return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength)
	new Uint8Array(buffer).set(bytes)
	return buffer
}

function jsonError(status: number, message: string, headers?: HeadersInit): Response {
	return Response.json({ error: message }, { status, headers })
}
