import type { ParsedEvent, ParsedException, StackFrame } from '@fabrika/operations-contract/ingest'

export interface ParsedEnvelope {
	eventPayload: Record<string, unknown> | null
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

export function extractIngestKey(request: Request): string | null {
	const url = new URL(request.url)
	const fromQuery = url.searchParams.get('sentry_key')
	if (fromQuery) return fromQuery
	const authHeader = request.headers.get('x-sentry-auth')
	if (!authHeader) return null
	const match = authHeader.match(/sentry_key=([^,\s]+)/i)
	if (!match?.[1]) return null
	try {
		return decodeURIComponent(match[1])
	} catch {
		return null
	}
}

export function ingestKeyLookup(key: string): string {
	return `ingest-key:${key}`
}

export function parseEnvelope(body: string): ParsedEnvelope {
	const lines = body.split('\n')
	let index = 1
	while (index < lines.length) {
		const headerLine = lines[index]
		if (headerLine === undefined || headerLine.trim() === '') {
			index++
			continue
		}
		let header: unknown
		try {
			header = JSON.parse(headerLine)
		} catch {
			return { eventPayload: null }
		}
		const payloadLine = lines[index + 1]
		index += 2
		if (payloadLine === undefined) break
		if (!isRecord(header) || header['type'] !== 'event') continue
		try {
			const payload: unknown = JSON.parse(payloadLine)
			return { eventPayload: isRecord(payload) ? payload : null }
		} catch {
			return { eventPayload: null }
		}
	}
	return { eventPayload: null }
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
