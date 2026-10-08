import type { ParsedEvent, ParsedException, StackFrame } from '@fabrika/operations-contract/ingest'
import { envelopeItemSchema, type SentryEvent, sentryEventSchema, type SentryException } from './event-schemas.js'
import { redactEventPayload } from './redact.js'

export interface ParsedEnvelope {
	eventPayload: Record<string, unknown> | null
}

export interface ParsedEventEnvelope {
	eventPayloads: Record<string, unknown>[]
	ignoredItemTypes: string[]
}

export class EnvelopeParseError extends Error {
	constructor(
		message: string,
		readonly reason: 'malformed' | 'too_many_events' = 'malformed',
	) {
		super(message)
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toParsedException(exception: SentryException): ParsedException {
	return {
		type: exception.type ?? 'Error',
		value: exception.value ?? '',
		frames: exception.stacktrace?.frames ?? [],
	}
}

function exceptionOf(event: SentryEvent): ParsedException | null {
	const exception = event.exception
	if (exception !== undefined) {
		const latest = exception.values?.at(-1)
		if (latest) return toParsedException(latest)
		const singular = toParsedException(exception)
		if (singular.value.length > 0 || singular.frames.length > 0 || exception.hasTypeKey) return singular
	}
	return event.message === undefined ? null : { type: 'Message', value: event.message, frames: [] }
}

export type IngestAuthResult =
	| { ok: true; publicKey: string }
	| { ok: false; reason: 'missing' | 'invalid' | 'ambiguous' }

export function parseIngestAuth(request: Request): IngestAuthResult {
	const url = new URL(request.url)
	const queryValues = url.searchParams.getAll('sentry_key')
	if (queryValues.length > 1) return { ok: false, reason: 'ambiguous' }
	const queryKey = queryValues[0]
	if (queryKey !== undefined && !/^[0-9a-f]{32}$/.test(queryKey)) return { ok: false, reason: 'invalid' }

	const authHeader = request.headers.get('x-sentry-auth')
	let headerKey: string | undefined
	if (authHeader !== null) {
		if (!/^Sentry\s+/i.test(authHeader)) return { ok: false, reason: 'invalid' }
		const values = authHeader.replace(/^Sentry\s+/i, '').split(',')
			.map((part) => part.trim())
			.filter((part) => part.toLowerCase().startsWith('sentry_key='))
		if (values.length !== 1) return { ok: false, reason: values.length > 1 ? 'ambiguous' : 'invalid' }
		headerKey = values[0]?.slice('sentry_key='.length)
		if (headerKey === undefined || !/^[0-9a-f]{32}$/.test(headerKey)) return { ok: false, reason: 'invalid' }
	}

	if (queryKey !== undefined && headerKey !== undefined && queryKey !== headerKey) return { ok: false, reason: 'ambiguous' }
	const publicKey = queryKey ?? headerKey
	return publicKey === undefined ? { ok: false, reason: 'missing' } : { ok: true, publicKey }
}

export function extractIngestKey(request: Request): string | null {
	const auth = parseIngestAuth(request)
	return auth.ok ? auth.publicKey : null
}

export function parseEnvelope(body: string): ParsedEnvelope {
	try {
		return { eventPayload: parseEventEnvelope(new TextEncoder().encode(body)).eventPayloads[0] ?? null }
	} catch {
		return { eventPayload: null }
	}
}

export function parseEventEnvelope(body: Uint8Array, maxEventItems = 32): ParsedEventEnvelope {
	if (!Number.isInteger(maxEventItems) || maxEventItems < 1) throw new RangeError('event item limit must be positive')
	let offset = 0
	const envelopeHeader = readLine(body, offset)
	if (!envelopeHeader) throw new EnvelopeParseError('missing envelope header')
	offset = envelopeHeader.next
	parseJsonRecord(envelopeHeader.bytes, 'invalid envelope header')

	const eventPayloads: Record<string, unknown>[] = []
	const ignoredItemTypes = new Set<string>()
	while (offset < body.length) {
		if (body[offset] === 10) {
			offset++
			continue
		}
		const itemHeaderLine = readLine(body, offset)
		if (!itemHeaderLine) throw new EnvelopeParseError('missing item header terminator')
		offset = itemHeaderLine.next
		if (itemHeaderLine.bytes.length === 0) continue
		const itemHeader = envelopeItemSchema.safeParse(parseJsonRecord(itemHeaderLine.bytes, 'invalid item header'))
		if (!itemHeader.success) throw new EnvelopeParseError(itemHeader.error.issues[0]?.path[0] === 'type' ? 'invalid item type' : 'invalid item length')
		const { type, length } = itemHeader.data

		let payload: Uint8Array
		if (typeof length === 'number') {
			if (offset + length > body.length) throw new EnvelopeParseError('truncated item payload')
			payload = body.subarray(offset, offset + length)
			offset += length
			if (body[offset] === 13 && body[offset + 1] === 10) offset += 2
			else if (body[offset] === 10) offset++
		} else {
			const payloadLine = readLine(body, offset, true)
			if (!payloadLine) throw new EnvelopeParseError('missing item payload')
			payload = payloadLine.bytes
			offset = payloadLine.next
		}

		if (type !== 'event') {
			ignoredItemTypes.add(type)
			continue
		}
		if (eventPayloads.length >= maxEventItems) throw new EnvelopeParseError('too many event items', 'too_many_events')
		eventPayloads.push(parseJsonRecord(payload, 'invalid event payload'))
	}
	return { eventPayloads, ignoredItemTypes: [...ignoredItemTypes].sort() }
}

function readLine(body: Uint8Array, offset: number, allowEof = false): { bytes: Uint8Array; next: number } | null {
	let end = offset
	while (end < body.length && body[end] !== 10) end++
	if (end === body.length && !allowEof) return null
	const contentEnd = end > offset && body[end - 1] === 13 ? end - 1 : end
	return { bytes: body.subarray(offset, contentEnd), next: end < body.length ? end + 1 : end }
}

function parseJsonRecord(bytes: Uint8Array, message: string): Record<string, unknown> {
	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
	} catch {
		throw new EnvelopeParseError(message)
	}
	if (!isRecord(parsed)) throw new EnvelopeParseError(message)
	return parsed
}

export function buildParsedEvent(
	projectId: string,
	untrustedPayload: Record<string, unknown>,
	receivedAt: number = Date.now(),
): ParsedEvent | null {
	const eventPayload = redactEventPayload(untrustedPayload)
	const event = sentryEventSchema.parse(eventPayload)
	const exception = exceptionOf(event)
	if (!exception) return null
	const eventId = event.event_id !== undefined && /^[0-9a-f]{32}$/i.test(event.event_id)
		? event.event_id.toLowerCase()
		: crypto.randomUUID().replaceAll('-', '')
	const fingerprint = event.fingerprint ?? []
	const parsed: ParsedEvent = {
		eventId,
		projectId,
		exception,
		level: event.level ?? 'error',
		tags: Object.fromEntries(event.tags.map((tag) => [tag.key, tag.value])),
		sdkFingerprint: fingerprint.length > 0 ? fingerprint : null,
		receivedAt,
		raw: eventPayload,
	}
	if (event.release !== undefined) parsed.release = event.release
	if (event.environment !== undefined) parsed.environment = event.environment
	if (event.platform !== undefined) parsed.platform = event.platform
	return parsed
}

function frameSignature(frame: StackFrame): string {
	return `${frame.module ?? frame.filename ?? frame.absPath ?? '?'}:${frame.function ?? '?'}`
}

export async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input)
	const digest = await crypto.subtle.digest('SHA-256', data)
	let hex = ''
	for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
	return hex
}

export async function computeFingerprint(exception: ParsedException): Promise<string> {
	const inApp = exception.frames.filter((frame) => frame.inApp === true)
	const chosen = (inApp.length > 0 ? inApp : exception.frames).slice(-5)
	const parts = [exception.type, ...chosen.map(frameSignature)]
	if (chosen.length === 0) parts.push(exception.value)
	return sha256Hex(parts.join('\n'))
}

export async function resolveFingerprint(event: ParsedEvent): Promise<string> {
	const fallback = await computeFingerprint(event.exception)
	if (!event.sdkFingerprint) return fallback
	const expanded = event.sdkFingerprint.map((part) => (/^\{\{\s*default\s*\}\}$/.test(part) ? fallback : part))
	return sha256Hex(expanded.join('\n'))
}

export function issueTitle(exception: ParsedException): string {
	return exception.value ? `${exception.type}: ${exception.value}` : exception.type
}

export function issueCulprit(exception: ParsedException): string | null {
	const inApp = exception.frames.filter((frame) => frame.inApp === true)
	const top = (inApp.length > 0 ? inApp : exception.frames).at(-1)
	return top?.function ?? top?.module ?? top?.filename ?? top?.absPath ?? null
}
