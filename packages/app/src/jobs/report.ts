// What the framework tells Operations, through the ingest every application already has (`FABRIKA_OPERATIONS_DSN`, the
// Sentry envelope): a failed or missed job run, and a request that answered 5xx. Operations groups by the
// fingerprint and raises its new-issue and regression alerts, so each kind of failure becomes one issue.

export interface OperationsReport {
	/** Grouping in Operations: one issue per kind of problem and job or endpoint. */
	readonly fingerprint: readonly string[]
	/** The exception type Operations shows, e.g. `JobFailed`. */
	readonly type: string
	/** Framework-authored text only: fixed codes and declared names, never an application error's name or message. */
	readonly message: string
	readonly tags: Readonly<Record<string, string>>
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
export type ReportSource = 'fabrika.jobs' | 'fabrika.requests'

export interface OperationsReporterOptions {
	readonly target: OperationsTarget
	readonly release: string | null
	readonly environment: string | null
	readonly source: ReportSource
	readonly fetch?: (request: Request) => Promise<Response>
}

/** Where the reports of one application environment go: the ingest of its DSN, its release and its environment. */
export type OperationsSettings = Omit<OperationsReporterOptions, 'source' | 'fetch'>

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

/** The envelope of one error event: a header line, an item header line and the event. */
export function reportEnvelope(
	report: OperationsReport,
	options: Pick<OperationsReporterOptions, 'release' | 'environment' | 'source'>,
	now: Date,
): string {
	const { release, environment } = options
	const eventId = hexId()
	const event = {
		event_id: eventId,
		timestamp: now.toISOString(),
		level: 'error',
		platform: 'javascript',
		logger: options.source,
		fingerprint: [...report.fingerprint],
		tags: { ...report.tags },
		exception: { values: [{ type: report.type, value: report.message }] },
		...(release === null ? {} : { release }),
		...(environment === null ? {} : { environment }),
	}
	return [JSON.stringify({ event_id: eventId, sent_at: now.toISOString() }), JSON.stringify({ type: 'event' }), JSON.stringify(event), ''].join('\n')
}

export function operationsReporter(options: OperationsReporterOptions): OperationsReporter {
	const send = options.fetch ?? ((request: Request) => fetch(request))
	return {
		async report(report) {
			const request = new Request(options.target.envelopeUrl, {
				method: 'POST',
				headers: {
					'content-type': 'application/x-sentry-envelope',
					'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${options.target.publicKey}`,
				},
				body: reportEnvelope(report, options, new Date()),
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
		},
	}
}

/** Reports go to the server log only: the application has no Operations DSN. */
export const logReporter: OperationsReporter = {
	report(report) {
		console.error(`fabrika: ${report.type}: ${report.message}`)
		return Promise.resolve()
	},
}
