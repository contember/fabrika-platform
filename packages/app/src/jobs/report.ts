// What the framework tells Operations, through the ingest every application already has (`FABRIKA_OPERATIONS_DSN`, the
// Sentry envelope): a failed or missed job run, a request that answered 5xx, and a process that crashed. Operations
// groups a framework report by its fingerprint and raises its new-issue and regression alerts, so each kind of
// failure becomes one issue. What was thrown travels scrubbed as the report's cause chain (ADR-0059).

import { exceptionChain, type ReportedException } from './exception'
import type { Scrubber } from './scrub'

export interface OperationsReport {
	/** Grouping in Operations: one issue per kind of problem and job or endpoint. */
	readonly fingerprint: readonly string[]
	/** The exception type Operations shows, e.g. `JobFailed`. */
	readonly type: string
	/** Framework-authored text only: fixed codes and declared names. What was thrown travels as `error`. */
	readonly message: string
	readonly tags: Readonly<Record<string, string>>
	/** What was thrown, when something was: sent scrubbed as the cause chain of the framework's exception. */
	readonly error?: unknown
}

export interface OperationsReporter {
	/** Never throws: a report that cannot be delivered is one log line. */
	report(report: OperationsReport): Promise<void>
}

export interface OperationsTarget {
	readonly envelopeUrl: string
	readonly publicKey: string
}

const PUBLIC_KEY = /^[0-9a-f]{32}$/
const PROJECT_ID = /^[1-9][0-9]{0,18}$/
const DELIVERY_TIMEOUT_MS = 5_000

/** The envelope endpoint and key of a DSN `https://<key>@<host>/<project>`, or `null` when it is not one. */
export function operationsTarget(dsn: string): OperationsTarget | null {
	let url: URL
	try {
		url = new URL(dsn.trim())
	} catch {
		return null
	}
	const project = url.pathname.slice(1)
	if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !PUBLIC_KEY.test(url.username) || url.password !== '' || !PROJECT_ID.test(project)) {
		return null
	}
	// `@fabrika/operations-contract` builds the same URL, but it depends on this package.
	return { envelopeUrl: `${url.origin}/api/${project}/envelope/`, publicKey: url.username }
}

/** The envelope's `logger`: which part of the framework reported. */
export type ReportSource = 'fabrika.jobs' | 'fabrika.requests' | 'fabrika.process'

export interface OperationsReporterOptions {
	readonly target: OperationsTarget
	readonly release: string | null
	readonly environment: string | null
	readonly source: ReportSource
	/** What every text of a thrown value passes before it leaves the process. */
	readonly scrubber: Scrubber
	readonly fetch?: (request: Request) => Promise<Response>
}

/** Where the reports of one application environment go: the ingest of its DSN, its release and its environment. */
export type OperationsSettings = Omit<OperationsReporterOptions, 'source' | 'scrubber' | 'fetch'>

/**
 * The settings of `FABRIKA_OPERATIONS_DSN`, `FABRIKA_RELEASE` and `FABRIKA_ENVIRONMENT`; `null` without a DSN. A DSN
 * that is not an ingest DSN adds a problem, because every report would reach no one.
 */
export function operationsSettings(variables: Readonly<Record<string, string>>, problems: string[]): OperationsSettings | null {
	const dsn = variables['FABRIKA_OPERATIONS_DSN']
	if (dsn === undefined || dsn.trim() === '') {
		return null
	}
	const target = operationsTarget(dsn)
	if (target === null) {
		problems.push('FABRIKA_OPERATIONS_DSN is not an ingest DSN (https://<key>@<host>/<project>), so a failure would reach no one')
		return null
	}
	return { target, release: variables['FABRIKA_RELEASE'] ?? null, environment: variables['FABRIKA_ENVIRONMENT'] ?? null }
}

const hexId = (): string => crypto.randomUUID().replaceAll('-', '')

type EnvelopeOptions = Pick<OperationsReporterOptions, 'release' | 'environment' | 'source' | 'scrubber'>

interface EventFields {
	/** Absent: Operations groups by the last value's type and in-app frames. */
	readonly fingerprint?: readonly string[]
	readonly tags: Readonly<Record<string, string>>
	/** Oldest cause first; the last value is the one Operations titles the issue by. */
	readonly values: readonly ReportedException[]
}

/** The envelope of one error event: a header line, an item header line and the event. */
function eventEnvelope(fields: EventFields, options: EnvelopeOptions, now: Date): string {
	const { release, environment } = options
	const eventId = hexId()
	const event = {
		event_id: eventId,
		timestamp: now.toISOString(),
		level: 'error',
		platform: 'javascript',
		logger: options.source,
		...(fields.fingerprint === undefined ? {} : { fingerprint: [...fields.fingerprint] }),
		tags: { ...fields.tags },
		exception: { values: [...fields.values] },
		...(release === null ? {} : { release }),
		...(environment === null ? {} : { environment }),
	}
	return [JSON.stringify({ event_id: eventId, sent_at: now.toISOString() }), JSON.stringify({ type: 'event' }), JSON.stringify(event), ''].join('\n')
}

/** A framework report: its own exception last, so the issue keeps the framework's title, after what was thrown. */
export function reportEnvelope(report: OperationsReport, options: EnvelopeOptions, now: Date): string {
	const cause = report.error === undefined ? [] : exceptionChain(report.error, options.scrubber)
	return eventEnvelope(
		{
			fingerprint: report.fingerprint,
			tags: report.tags,
			values: [...cause, { type: report.type, value: report.message }],
		},
		options,
		now,
	)
}

/** How a process failed outside any request or job run. */
export type CrashKind = 'uncaught_exception' | 'unhandled_rejection' | 'boot_failed'

/** A crash: what was thrown is the issue itself, grouped by Operations from its type and in-app frames. */
export function crashEnvelope(kind: CrashKind, error: unknown, options: EnvelopeOptions, now: Date): string {
	return eventEnvelope({ tags: { crash: kind }, values: exceptionChain(error, options.scrubber) }, options, now)
}

async function deliver(options: OperationsReporterOptions, body: string): Promise<void> {
	const send = options.fetch ?? ((request: Request) => fetch(request))
	const request = new Request(options.target.envelopeUrl, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-sentry-envelope',
			'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${options.target.publicKey}`,
		},
		body,
		signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
	})
	try {
		const response = await send(request)
		await response.body?.cancel()
		if (!response.ok) {
			console.error(`fabrika: a report to Operations answered ${response.status}`)
		}
	} catch {
		// The error may quote the ingest URL with its key.
		console.error('fabrika: a report to Operations could not be delivered')
	}
}

export function operationsReporter(options: OperationsReporterOptions): OperationsReporter {
	return {
		report: (report) => deliver(options, reportEnvelope(report, options, new Date())),
	}
}

export interface CrashReporter {
	/** Never throws: a report that cannot be delivered is one log line. */
	report(kind: CrashKind, error: unknown): Promise<void>
}

export function crashReporter(options: Omit<OperationsReporterOptions, 'source'>): CrashReporter {
	const reporting: OperationsReporterOptions = { ...options, source: 'fabrika.process' }
	return {
		report: (kind, error) => deliver(reporting, crashEnvelope(kind, error, reporting, new Date())),
	}
}

/** Reports go to the server log only: the application has no Operations DSN. */
export const logReporter: OperationsReporter = {
	report(report) {
		console.error(`fabrika: ${report.type}: ${report.message}`)
		return Promise.resolve()
	},
}
