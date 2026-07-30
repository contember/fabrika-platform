import type { IngestMessage, IngestRejectReason } from '@fabrika/operations-contract/ingest'
import type { JobQueue } from '@fabrika/platform'
import { buildParsedEvent, EnvelopeParseError, type ParsedEventEnvelope, parseEventEnvelope, parseIngestAuth } from './ingest.js'
import { credentialVerifier, prepareIngestMessage } from './pipeline.js'
import type { IngestCredentialResolution, OperationsRepositories } from './repositories.js'

export const MAX_INGEST_BODY_BYTES = 200 * 1024
export const MAX_INGEST_MESSAGE_BYTES = 120 * 1024
export const MAX_ENVELOPE_EVENT_ITEMS = 32
export const DEFAULT_INGEST_RATE_LIMIT_PER_MINUTE = 300

const RATE_WINDOW_MS = 60_000
const ENVELOPE_PATH = /^\/api\/([1-9][0-9]{0,18})\/envelope\/$/
const ACCEPTED_CONTENT_TYPES = new Set([
	'application/octet-stream',
	'application/x-sentry-envelope',
	'text/plain',
])

export type IngestOutcome =
	| { kind: 'accepted'; sourceId: string; eventCount: number; bodyBytes: number }
	| { kind: 'rejected'; reason: IngestRejectReason; sourceId: string | null }

export interface DirectIngestOptions {
	repositories: OperationsRepositories
	queue: JobQueue<IngestMessage>
	now?: () => number
	rateLimitPerMinute?: number
	onOutcome?: (outcome: IngestOutcome) => void
}

export async function handleDirectIngestRequest(request: Request, options: DirectIngestOptions): Promise<Response> {
	if (request.method !== 'POST') return jsonError(405, 'method not allowed', { Allow: 'POST' })
	const match = new URL(request.url).pathname.match(ENVELOPE_PATH)
	const pathProjectId = match?.[1]
	if (pathProjectId === undefined) return jsonError(404, 'not found')

	const auth = parseIngestAuth(request)
	if (!auth.ok) return reject(options, 'unauthorized', 401, 'invalid ingest authentication', null)

	let credential: IngestCredentialResolution | null
	try {
		credential = await options.repositories.sources.resolveIngestCredential(await credentialVerifier(auth.publicKey))
	} catch {
		return reject(options, 'unavailable', 503, 'temporarily unavailable', null)
	}
	if (credential === null) return reject(options, 'unauthorized', 401, 'invalid ingest authentication', null)
	if (credential.ingestProjectId !== pathProjectId) {
		return reject(options, 'forbidden', 403, 'credential does not match ingest project', credential.sourceId)
	}

	const now = (options.now ?? Date.now)()
	const rateLimitPerMinute = options.rateLimitPerMinute ?? DEFAULT_INGEST_RATE_LIMIT_PER_MINUTE
	if (!Number.isSafeInteger(rateLimitPerMinute) || rateLimitPerMinute < 1) {
		throw new RangeError('ingest per-minute rate limit must be a positive integer')
	}
	const windowStart = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS
	let withinLimit: boolean
	try {
		withinLimit = await options.repositories.ingestRateLimits.consume({
			sourceId: credential.sourceId,
			windowStart,
			limit: rateLimitPerMinute,
		})
	} catch {
		return reject(options, 'unavailable', 503, 'temporarily unavailable', credential.sourceId)
	}
	if (!withinLimit) {
		const retryAfter = Math.max(1, Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1_000))
		return reject(options, 'rate_limited', 429, 'rate limit exceeded', credential.sourceId, { 'Retry-After': String(retryAfter) })
	}

	const encoding = request.headers.get('content-encoding')?.trim().toLowerCase()
	if (encoding !== undefined && encoding !== '' && encoding !== 'identity') {
		return reject(options, 'unsupported', 415, 'content encoding is not supported', credential.sourceId)
	}
	const contentTypeHeader = request.headers.get('content-type')
	const contentType = contentTypeHeader?.split(';', 1)[0]?.trim().toLowerCase()
	if (contentType === undefined || !ACCEPTED_CONTENT_TYPES.has(contentType)) {
		return reject(options, 'unsupported', 415, 'content type is not supported', credential.sourceId)
	}

	const declaredLength = request.headers.get('content-length')
	if (declaredLength !== null) {
		if (!/^[0-9]+$/.test(declaredLength)) {
			return reject(options, 'malformed', 400, 'invalid content length', credential.sourceId)
		}
		const bytes = Number(declaredLength)
		if (!Number.isSafeInteger(bytes)) return reject(options, 'malformed', 400, 'invalid content length', credential.sourceId)
		if (bytes > MAX_INGEST_BODY_BYTES) {
			return reject(options, 'too_large', 413, 'payload too large', credential.sourceId)
		}
	}

	const body = await readLimitedBody(request, MAX_INGEST_BODY_BYTES)
	if (body.kind === 'unreadable') return reject(options, 'malformed', 400, 'unreadable body', credential.sourceId)
	if (body.kind === 'too_large') return reject(options, 'too_large', 413, 'payload too large', credential.sourceId)

	let envelope: ParsedEventEnvelope
	try {
		envelope = parseEventEnvelope(body.bytes, MAX_ENVELOPE_EVENT_ITEMS)
	} catch (error) {
		const status = error instanceof EnvelopeParseError && error.reason === 'too_many_events' ? 413 : 400
		const reason: IngestRejectReason = status === 413 ? 'too_large' : 'malformed'
		return reject(options, reason, status, status === 413 ? 'too many event items' : 'malformed envelope', credential.sourceId)
	}
	if (envelope.eventPayloads.length === 0) {
		return reject(options, 'malformed', 400, 'no event in envelope', credential.sourceId)
	}
	if (envelope.eventPayloads.length > 1) {
		try {
			withinLimit = await options.repositories.ingestRateLimits.consume({
				sourceId: credential.sourceId,
				windowStart,
				amount: envelope.eventPayloads.length - 1,
				limit: rateLimitPerMinute,
			})
		} catch {
			return reject(options, 'unavailable', 503, 'temporarily unavailable', credential.sourceId)
		}
		if (!withinLimit) {
			const retryAfter = Math.max(1, Math.ceil((windowStart + RATE_WINDOW_MS - now) / 1_000))
			return reject(options, 'rate_limited', 429, 'rate limit exceeded', credential.sourceId, { 'Retry-After': String(retryAfter) })
		}
	}

	const messages: IngestMessage[] = []
	try {
		for (const payload of envelope.eventPayloads) {
			const parsed = buildParsedEvent(credential.sourceId, payload, now)
			if (parsed === null) return reject(options, 'malformed', 400, 'no exception in event', credential.sourceId)
			const message = await prepareIngestMessage(credential.sourceId, parsed)
			if (new TextEncoder().encode(JSON.stringify(message)).length > MAX_INGEST_MESSAGE_BYTES) {
				return reject(options, 'too_large', 413, 'payload too large', credential.sourceId)
			}
			messages.push(message)
		}
	} catch {
		return reject(options, 'unavailable', 503, 'temporarily unavailable', credential.sourceId)
	}

	try {
		for (const message of messages) await options.queue.send(message)
	} catch {
		return reject(options, 'unavailable', 503, 'temporarily unavailable', credential.sourceId)
	}
	recordOutcome(options, { kind: 'accepted', sourceId: credential.sourceId, eventCount: messages.length, bodyBytes: body.bytes.length })
	const first = messages[0]
	if (!first) return reject(options, 'malformed', 400, 'no event in envelope', credential.sourceId)
	const headers = new Headers()
	if (envelope.ignoredItemTypes.length > 0) {
		headers.set('X-Fabrika-Ignored-Sentry-Items', envelope.ignoredItemTypes.join(','))
	}
	return Response.json({ id: first.eventId }, { status: 202, headers })
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
		while (true) {
			const next = await reader.read()
			if (next.done) break
			length += next.value.length
			if (length > limit) {
				try {
					await reader.cancel()
				} catch {
					// The size decision is already final.
				}
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

function reject(
	options: DirectIngestOptions,
	reason: IngestRejectReason,
	status: number,
	message: string,
	sourceId: string | null,
	headers?: HeadersInit,
): Response {
	recordOutcome(options, { kind: 'rejected', reason, sourceId })
	return jsonError(status, message, headers)
}

function recordOutcome(options: DirectIngestOptions, outcome: IngestOutcome): void {
	try {
		options.onOutcome?.(outcome)
	} catch {
		// Telemetry is advisory and never changes ingest delivery.
	}
}

function jsonError(status: number, message: string, headers?: HeadersInit): Response {
	return Response.json({ error: message }, { status, headers })
}
