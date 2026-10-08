import type { EventDetail, EventException, StackFrame } from '@fabrika/operations-contract'
import { type SentryEvent, sentryEventSchema, type SentryException, type SentryRuntime } from './event-schemas.js'
import type { ObjectReader } from './source-maps.js'
import { resolveFrames } from './source-maps.js'

interface RawException {
	type: string | null
	value: string | null
	handled: boolean | null
	frames: StackFrame[]
}

function toRawException(exception: SentryException): RawException {
	return {
		type: exception.type ?? null,
		value: exception.value ?? null,
		handled: exception.mechanism?.handled ?? null,
		frames: exception.stacktrace?.frames ?? [],
	}
}

function exceptionsOf(event: SentryEvent): RawException[] {
	const exception = event.exception
	if (exception !== undefined) {
		const values = exception.values
		if (values !== undefined && values.length > 0) {
			return [...values].reverse().flatMap((value) => value === null ? [] : [toRawException(value)])
		}
		return [toRawException(exception)]
	}
	return event.message === undefined ? [] : [{ type: 'Message', value: event.message, handled: null, frames: [] }]
}

function requestOf(event: SentryEvent): EventDetail['request'] {
	const url = event.request?.url
	const contextUrl = event.context?.url
	const method = event.request?.method
	if (!url && !contextUrl && !method) return null
	return { url: url ?? contextUrl ?? null, method: method ?? null }
}

function formatRuntime(runtime: SentryRuntime | undefined): string | null {
	if (!runtime?.name) return null
	return runtime.version ? `${runtime.name} ${runtime.version}` : runtime.name
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
	const read = sentryEventSchema.safeParse(parsed)
	if (!read.success) return emptyDetail(rawText)
	const event = read.data
	const exceptions: EventException[] = await Promise.all(
		exceptionsOf(event).map(async (exception) => ({
			type: exception.type,
			value: exception.value,
			handled: exception.handled,
			frames: await resolveFrames(exception.frames, sourceId, event.release, reader),
		})),
	)
	const contexts = event.contexts
	return {
		eventId: event.event_id ?? null,
		platform: event.platform ?? null,
		release: event.release ?? null,
		environment: event.environment ?? null,
		tags: [...event.tags].sort((left, right) => left.key.localeCompare(right.key)),
		request: requestOf(event),
		user: event.user ?? event.context?.user ?? null,
		breadcrumbs: event.breadcrumbs,
		runtime: contexts ? formatRuntime(contexts.runtime) : null,
		os: contexts ? formatRuntime(contexts.os) ?? formatRuntime(contexts.browser) : null,
		serverName: event.server_name ?? null,
		traceId: contexts?.trace?.trace_id ?? null,
		exceptions,
		rawEvent: JSON.stringify(parsed, null, 2),
	}
}
