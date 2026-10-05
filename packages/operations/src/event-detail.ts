import type { EventBreadcrumb, EventDetail, EventException, StackFrame } from '@fabrika/operations-contract'
import { sentryBreadcrumbSchema, sentryExceptionSchema, sentryRequestSchema, sentryRuntimeSchema, sentryUserSchema } from './event-schemas.js'
import type { ObjectReader } from './source-maps.js'
import { resolveFrames } from './source-maps.js'

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key]
	return typeof value === 'string' ? value : undefined
}

interface RawException {
	type: string | null
	value: string | null
	handled: boolean | null
	frames: StackFrame[]
}

function parseException(value: unknown): RawException | null {
	const parsed = sentryExceptionSchema.safeParse(value)
	if (!parsed.success) return null
	return {
		type: parsed.data.type ?? null,
		value: parsed.data.value ?? null,
		handled: parsed.data.mechanism?.handled ?? null,
		frames: parsed.data.stacktrace?.frames ?? [],
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
	const requestRecord = sentryRequestSchema.safeParse(request)
	const contextRecord = sentryRequestSchema.safeParse(context)
	const url = requestRecord.success ? requestRecord.data.url : undefined
	const contextUrl = contextRecord.success ? contextRecord.data.url : undefined
	const method = requestRecord.success ? requestRecord.data.method : undefined
	if (!url && !contextUrl && !method) return null
	return { url: url ?? contextUrl ?? null, method: method ?? null }
}

function extractUser(payload: Record<string, unknown>): EventDetail['user'] {
	const direct = payload['user']
	const context = payload['context']
	const contextUser = isRecord(context) ? context['user'] : undefined
	const user = isRecord(direct) ? direct : isRecord(contextUser) ? contextUser : null
	if (!user) return null
	return sentryUserSchema.parse(user)
}

function extractBreadcrumbs(payload: Record<string, unknown>): EventBreadcrumb[] {
	const raw = payload['breadcrumbs']
	const values = isRecord(raw) ? raw['values'] : raw
	if (!Array.isArray(values)) return []
	const result: EventBreadcrumb[] = []
	for (const value of values) {
		const parsed = sentryBreadcrumbSchema.safeParse(value)
		if (parsed.success) result.push(parsed.data)
	}
	return result
}

function formatRuntime(value: unknown): string | null {
	const parsed = sentryRuntimeSchema.safeParse(value)
	if (!parsed.success) return null
	const { name, version } = parsed.data
	if (!name) return null
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

export async function parseEventDetail(rawText: string, sourceId: string, reader: ObjectReader): Promise<EventDetail> {
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
			frames: await resolveFrames(exception.frames, sourceId, release, reader),
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
