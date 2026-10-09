// What a job run tells Operations, through the ingest every application already has (`FABRIKA_OPERATIONS_DSN`, the
// Sentry envelope). Operations groups by the fingerprint and raises its new-issue and regression alerts, so a failed
// job and a job that stopped succeeding each become one issue.

export interface JobReport {
	/** Grouping in Operations: one issue per kind of problem and job. */
	readonly fingerprint: readonly string[]
	/** The exception type Operations shows, e.g. `JobFailed`. */
	readonly type: string
	/** Framework-authored text only: an application error contributes its name, never its message. */
	readonly message: string
	readonly tags: Readonly<Record<string, string>>
}

export interface JobReporter {
	/** Never throws: a report that cannot be delivered is one log line. */
	report(report: JobReport): Promise<void>
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

export interface OperationsReporterOptions {
	readonly target: OperationsTarget
	readonly release: string | null
	readonly environment: string | null
	readonly fetch?: (request: Request) => Promise<Response>
}

const hexId = (): string => crypto.randomUUID().replaceAll('-', '')

/** The envelope of one error event: a header line, an item header line and the event. */
export function jobEnvelope(report: JobReport, release: string | null, environment: string | null, now: Date): string {
	const eventId = hexId()
	const event = {
		event_id: eventId,
		timestamp: now.toISOString(),
		level: 'error',
		platform: 'javascript',
		logger: 'fabrika.jobs',
		fingerprint: [...report.fingerprint],
		tags: { ...report.tags },
		exception: { values: [{ type: report.type, value: report.message }] },
		...(release === null ? {} : { release }),
		...(environment === null ? {} : { environment }),
	}
	return [JSON.stringify({ event_id: eventId, sent_at: now.toISOString() }), JSON.stringify({ type: 'event' }), JSON.stringify(event), ''].join('\n')
}

export function operationsReporter(options: OperationsReporterOptions): JobReporter {
	const send = options.fetch ?? ((request: Request) => fetch(request))
	return {
		async report(report) {
			const request = new Request(options.target.envelopeUrl, {
				method: 'POST',
				headers: {
					'content-type': 'application/x-sentry-envelope',
					'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${options.target.publicKey}`,
				},
				body: jobEnvelope(report, options.release, options.environment, new Date()),
				signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
			})
			try {
				const response = await send(request)
				await response.body?.cancel()
				if (!response.ok) {
					console.error(`fabrika: job report to Operations answered ${response.status}`)
				}
			} catch {
				// The error may quote the ingest URL with its key.
				console.error('fabrika: job report to Operations could not be delivered')
			}
		},
	}
}

/** Reports go to the server log only: the application has no Operations DSN. */
export const logReporter: JobReporter = {
	report(report) {
		console.error(`fabrika: ${report.type}: ${report.message}`)
		return Promise.resolve()
	},
}
