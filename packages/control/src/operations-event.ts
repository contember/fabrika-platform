// An event Control raises in an application's own Operations project, through the ingest of the environment's active
// DSN: Operations groups it by its fingerprint, and the project's alert rules (`new_issue`) deliver it.

import { operationsEnvelopeUrl } from '@fabrika/operations-contract/ingest'
import type { ControlRepositories } from './db'
import { ingestOrigin } from './operations-catalog'

const DELIVERY_TIMEOUT_MS = 5_000

export interface ControlEvent {
	/** The exception type Operations titles the issue with. */
	readonly type: string
	readonly message: string
	readonly level: 'warning' | 'error'
	readonly fingerprint: readonly string[]
	readonly tags?: Readonly<Record<string, string>>
}

/**
 * `refused` is a 4xx other than 429, which answers the same until the ingest's configuration changes (a stale key, a
 * removed project); `failed` is worth sending again, and carries no status when no answer came.
 */
export type ControlEventDelivery =
	| { readonly outcome: 'delivered' | 'no-ingest' }
	| { readonly outcome: 'refused'; readonly status: number }
	| { readonly outcome: 'failed'; readonly status?: number }

export interface ControlEventDeps {
	readonly repositories: Pick<ControlRepositories, 'operationsCatalog'>
	/** How Control reaches an application's ingest origin: the Worker's Operations binding, or the global `fetch`. */
	readonly ingest: (request: Request) => Promise<Response>
	/** Unix seconds. */
	readonly now: () => number
}

export async function sendControlEvent(deps: ControlEventDeps, appId: string, env: string, event: ControlEvent): Promise<ControlEventDelivery> {
	const config = await deps.repositories.operationsCatalog.getActiveIngestConfig(appId, env)
	const origin = ingestOrigin(config)
	if (config === null || config.ingest_project_id === null || origin === undefined) return { outcome: 'no-ingest' }
	const eventId = crypto.randomUUID().replaceAll('-', '')
	const sentAt = new Date(deps.now() * 1000).toISOString()
	const payload = {
		event_id: eventId,
		timestamp: sentAt,
		level: event.level,
		platform: 'javascript',
		logger: 'fabrika.control',
		fingerprint: event.fingerprint,
		...(event.tags === undefined ? {} : { tags: event.tags }),
		exception: { values: [{ type: event.type, value: event.message }] },
		environment: env,
	}
	const body = [JSON.stringify({ event_id: eventId, sent_at: sentAt }), JSON.stringify({ type: 'event' }), JSON.stringify(payload), ''].join('\n')
	let status: number
	try {
		const response = await deps.ingest(
			new Request(operationsEnvelopeUrl(origin, config.ingest_project_id), {
				method: 'POST',
				headers: {
					'content-type': 'application/x-sentry-envelope',
					'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${config.public_key}`,
				},
				body,
				redirect: 'manual',
				signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
			}),
		)
		await response.body?.cancel()
		status = response.status
	} catch {
		return { outcome: 'failed' }
	}
	if (status >= 200 && status < 300) return { outcome: 'delivered' }
	if (status >= 400 && status < 500 && status !== 429) return { outcome: 'refused', status }
	return { outcome: 'failed', status }
}
