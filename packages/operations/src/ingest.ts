import type { ParsedEvent, ParsedException, StackFrame } from '@fabrika/operations-contract/ingest'

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

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key]
	return typeof value === 'string' ? value : undefined
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key]
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
	const value = record[key]
	return typeof value === 'boolean' ? value : undefined
}

function readStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined
	const strings: string[] = []
	for (const item of value) {
		if (typeof item !== 'string') return undefined
		strings.push(item)
	}
	return strings
}

function parseFrame(value: unknown): StackFrame | null {
	if (!isRecord(value)) return null
	const frame: StackFrame = {}
	const functionName = readString(value, 'function')
	const filename = readString(value, 'filename')
	const module = readString(value, 'module')
	const absPath = readString(value, 'abs_path')
	const line = readNumber(value, 'lineno')
	const column = readNumber(value, 'colno')
	const inApp = readBoolean(value, 'in_app')
	const preContext = readStringArray(value['pre_context'])
	const contextLine = readString(value, 'context_line')
	const postContext = readStringArray(value['post_context'])
	if (functionName !== undefined) frame.function = functionName
	if (filename !== undefined) frame.filename = filename
	if (module !== undefined) frame.module = module
	if (absPath !== undefined) frame.absPath = absPath
	if (line !== undefined) frame.line = line
	if (column !== undefined) frame.column = column
	if (inApp !== undefined) frame.inApp = inApp
	if (preContext !== undefined) frame.preContext = preContext
	if (contextLine !== undefined) frame.contextLine = contextLine
	if (postContext !== undefined) frame.postContext = postContext
	return frame
}

function parseFrames(value: unknown): StackFrame[] {
	if (!Array.isArray(value)) return []
	const frames: StackFrame[] = []
	for (const item of value) {
		const frame = parseFrame(item)
		if (frame) frames.push(frame)
	}
	return frames
}

function parseExceptionValue(value: unknown): ParsedException | null {
	if (!isRecord(value)) return null
	const stacktrace = value['stacktrace']
	const frames = isRecord(stacktrace) ? parseFrames(stacktrace['frames']) : []
	return {
		type: readString(value, 'type') ?? 'Error',
		value: readString(value, 'value') ?? '',
		frames,
	}
}

function parseExceptionFromEvent(event: Record<string, unknown>): ParsedException | null {
	const exception = event['exception']
	if (isRecord(exception)) {
		const values = exception['values']
		if (Array.isArray(values) && values.length > 0) {
			const parsed = parseExceptionValue(values[values.length - 1])
			if (parsed) return parsed
		}
		const singular = parseExceptionValue(exception)
		if (singular && (singular.value.length > 0 || singular.frames.length > 0 || exception['type'] !== undefined)) return singular
	}

	const message = event['message']
	if (typeof message === 'string' && message.length > 0) {
		return { type: 'Message', value: message, frames: [] }
	}
	if (isRecord(message)) {
		const formatted = readString(message, 'formatted') ?? readString(message, 'message')
		if (formatted) return { type: 'Message', value: formatted, frames: [] }
	}
	return null
}

function parseTags(event: Record<string, unknown>): Record<string, string> {
	const result: Record<string, string> = {}
	const tags = event['tags']
	if (isRecord(tags)) {
		for (const [key, value] of Object.entries(tags)) {
			if (value !== null && value !== undefined) result[key] = String(value)
		}
		return result
	}
	if (!Array.isArray(tags)) return result
	for (const pair of tags) {
		if (!Array.isArray(pair) || pair.length !== 2 || pair[0] === null || pair[0] === undefined) continue
		result[String(pair[0])] = String(pair[1])
	}
	return result
}

function parseSdkFingerprint(event: Record<string, unknown>): string[] | null {
	const fingerprint = event['fingerprint']
	if (!Array.isArray(fingerprint)) return null
	const parts = fingerprint.filter((part): part is string => typeof part === 'string')
	return parts.length > 0 ? parts : null
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
		const itemHeader = parseJsonRecord(itemHeaderLine.bytes, 'invalid item header')
		const type = itemHeader['type']
		if (typeof type !== 'string' || type.length === 0) throw new EnvelopeParseError('invalid item type')
		const length = itemHeader['length']
		if (length !== undefined && (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)) {
			throw new EnvelopeParseError('invalid item length')
		}

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
	eventPayload: Record<string, unknown>,
	receivedAt: number = Date.now(),
): ParsedEvent | null {
	const exception = parseExceptionFromEvent(eventPayload)
	if (!exception) return null
	const rawEventId = eventPayload['event_id']
	const eventId = typeof rawEventId === 'string' && /^[0-9a-f]{32}$/i.test(rawEventId)
		? rawEventId.toLowerCase()
		: crypto.randomUUID().replaceAll('-', '')
	const parsed: ParsedEvent = {
		eventId,
		projectId,
		exception,
		level: readString(eventPayload, 'level') ?? 'error',
		tags: parseTags(eventPayload),
		sdkFingerprint: parseSdkFingerprint(eventPayload),
		receivedAt,
		raw: eventPayload,
	}
	const release = readString(eventPayload, 'release')
	const environment = readString(eventPayload, 'environment')
	const platform = readString(eventPayload, 'platform')
	if (release !== undefined) parsed.release = release
	if (environment !== undefined) parsed.environment = environment
	if (platform !== undefined) parsed.platform = platform
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
