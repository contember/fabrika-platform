import type { EventBreadcrumb, EventDetail, EventException, StackFrame } from '@fabrika/operations-contract'
import type { ObjectReader } from './source-maps.js'
import { resolveFrames } from './source-maps.js'

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
	const result: string[] = []
	for (const item of value) {
		if (typeof item !== 'string') return undefined
		result.push(item)
	}
	return result
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
	for (const candidate of value) {
		const frame = parseFrame(candidate)
		if (frame) frames.push(frame)
	}
	return frames
}

interface RawException {
	type: string | null
	value: string | null
	handled: boolean | null
	frames: StackFrame[]
}

function parseException(value: unknown): RawException | null {
	if (!isRecord(value)) return null
	const mechanism = value['mechanism']
	const handled = isRecord(mechanism) && typeof mechanism['handled'] === 'boolean' ? mechanism['handled'] : null
	const stacktrace = value['stacktrace']
	return {
		type: readString(value, 'type') ?? null,
		value: readString(value, 'value') ?? null,
		handled,
		frames: isRecord(stacktrace) ? parseFrames(stacktrace['frames']) : [],
	}
}

function extractExceptions(payload: Record<string, unknown>): RawException[] {
	const exception = payload['exception']
	if (isRecord(exception)) {
		const values = exception['values']
		if (Array.isArray(values) && values.length > 0) {
			const result: RawException[] = []
			for (const value of [...values].reverse()) {
				const parsed = parseException(value)
				if (parsed) result.push(parsed)
			}
			return result
		}
		const singular = parseException(exception)
		if (singular) return [singular]
	}
	const message = payload['message']
	if (typeof message === 'string' && message.length > 0) {
		return [{ type: 'Message', value: message, handled: null, frames: [] }]
	}
	if (isRecord(message)) {
		const formatted = readString(message, 'formatted') ?? readString(message, 'message')
		if (formatted) return [{ type: 'Message', value: formatted, handled: null, frames: [] }]
	}
	return []
}

function extractTags(payload: Record<string, unknown>): { key: string; value: string }[] {
	const tags = payload['tags']
	const result: { key: string; value: string }[] = []
	if (isRecord(tags)) {
		for (const [key, value] of Object.entries(tags)) {
			if (value !== null && value !== undefined) result.push({ key, value: String(value) })
		}
	} else if (Array.isArray(tags)) {
		for (const pair of tags) {
			if (!Array.isArray(pair) || pair.length !== 2 || pair[0] === null || pair[0] === undefined) continue
			result.push({ key: String(pair[0]), value: String(pair[1]) })
		}
	}
	return result.sort((left, right) => left.key.localeCompare(right.key))
}

function extractRequest(payload: Record<string, unknown>): EventDetail['request'] {
	const request = payload['request']
	const context = payload['context']
	const requestRecord = isRecord(request) ? request : null
	const contextRecord = isRecord(context) ? context : null
	const url = requestRecord ? readString(requestRecord, 'url') : undefined
	const contextUrl = contextRecord ? readString(contextRecord, 'url') : undefined
	const method = requestRecord ? readString(requestRecord, 'method') : undefined
	if (!url && !contextUrl && !method) return null
	return { url: url ?? contextUrl ?? null, method: method ?? null }
}

function extractUser(payload: Record<string, unknown>): EventDetail['user'] {
	const direct = payload['user']
	const context = payload['context']
	const contextUser = isRecord(context) ? context['user'] : undefined
	const user = isRecord(direct) ? direct : isRecord(contextUser) ? contextUser : null
	if (!user) return null
	const rawId = user['id']
	return {
		id: typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : null,
		email: readString(user, 'email') ?? null,
		username: readString(user, 'username') ?? null,
	}
}

function extractBreadcrumbs(payload: Record<string, unknown>): EventBreadcrumb[] {
	const raw = payload['breadcrumbs']
	const values = isRecord(raw) ? raw['values'] : raw
	if (!Array.isArray(values)) return []
	const result: EventBreadcrumb[] = []
	for (const value of values) {
		if (!isRecord(value)) continue
		const breadcrumb: EventBreadcrumb = {}
		const timestamp = value['timestamp']
		if (typeof timestamp === 'number' || typeof timestamp === 'string') breadcrumb.timestamp = timestamp
		const type = readString(value, 'type')
		const category = readString(value, 'category')
		const level = readString(value, 'level')
		const message = readString(value, 'message')
		if (type !== undefined) breadcrumb.type = type
		if (category !== undefined) breadcrumb.category = category
		if (level !== undefined) breadcrumb.level = level
		if (message !== undefined) breadcrumb.message = message
		result.push(breadcrumb)
	}
	return result
}

function formatRuntime(value: unknown): string | null {
	if (!isRecord(value)) return null
	const name = readString(value, 'name')
	if (!name) return null
	const version = readString(value, 'version')
	return version ? `${name} ${version}` : name
}

function emptyDetail(rawEvent: string): EventDetail {
	return {
		eventId: null,
		platform: null,
		release: null,
		environment: null,
		tags: [],
		request: null,
		user: null,
		breadcrumbs: [],
		runtime: null,
		os: null,
		serverName: null,
		traceId: null,
		exceptions: [],
		rawEvent,
	}
}

export async function parseEventDetail(rawText: string, reader: ObjectReader): Promise<EventDetail> {
	let parsed: unknown
	try {
		parsed = JSON.parse(rawText)
	} catch {
		return emptyDetail(rawText)
	}
	if (!isRecord(parsed)) return emptyDetail(rawText)
	const release = readString(parsed, 'release')
	const contexts = parsed['contexts']
	const contextRecord = isRecord(contexts) ? contexts : null
	const trace = contextRecord?.['trace']
	const exceptions: EventException[] = await Promise.all(
		extractExceptions(parsed).map(async (exception) => ({
			type: exception.type,
			value: exception.value,
			handled: exception.handled,
			frames: await resolveFrames(exception.frames, release, reader),
		})),
	)
	return {
		eventId: readString(parsed, 'event_id') ?? null,
		platform: readString(parsed, 'platform') ?? null,
		release: release ?? null,
		environment: readString(parsed, 'environment') ?? null,
		tags: extractTags(parsed),
		request: extractRequest(parsed),
		user: extractUser(parsed),
		breadcrumbs: extractBreadcrumbs(parsed),
		runtime: contextRecord ? formatRuntime(contextRecord['runtime']) : null,
		os: contextRecord ? formatRuntime(contextRecord['os']) ?? formatRuntime(contextRecord['browser']) : null,
		serverName: readString(parsed, 'server_name') ?? null,
		traceId: isRecord(trace) ? readString(trace, 'trace_id') ?? null : null,
		exceptions,
		rawEvent: JSON.stringify(parsed, null, 2),
	}
}
