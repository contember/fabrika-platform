// The maintenance pass that warns an application's Operations, days ahead, that a workload key its running version holds
// is about to expire: the maintenance renewal could not hand it a new one (its provider writes no credential without a
// deploy, or the write keeps failing), and once it expires every job, webhook and public procedure of that key stops.
// At most one warning per key and day, the keys of one environment due together in one event, to the application's own
// ingest; an expired key is reported as an error.

import type { ControlRepositories } from './db'
import type { ExpiringWorkloadKey } from './db/workload-credentials'
import { sendControlEvent } from './operations-event'

/** A key the running version holds with this little left is reported: a week of warning, after a week of renewals. */
export const WORKLOAD_KEY_WARN_BELOW_SECONDS = 7 * 24 * 60 * 60
/** One warning per key and day. */
export const WORKLOAD_KEY_WARN_EVERY_SECONDS = 24 * 60 * 60

const DAY_SECONDS = 24 * 60 * 60

/** What one pass did, by environment. */
export interface WorkloadKeyExpirySummary {
	/** Environments warned: through their Operations, or the log alone when they have no active ingest. */
	warned: number
	/** Environments whose warning Operations did not take; the next pass sends it again. */
	failed: number
}

export interface WorkloadKeyExpiryDeps {
	readonly repositories: Pick<ControlRepositories, 'workloadCredentials' | 'operationsCatalog'>
	/** How Control reaches an application's ingest origin: the Worker's Operations binding, or the global `fetch`. */
	readonly ingest: (request: Request) => Promise<Response>
	/** Unix seconds. */
	readonly now: () => number
}

export async function warnExpiringWorkloadKeys(deps: WorkloadKeyExpiryDeps): Promise<WorkloadKeyExpirySummary> {
	const summary: WorkloadKeyExpirySummary = { warned: 0, failed: 0 }
	const now = deps.now()
	const expiring = await deps.repositories.workloadCredentials.listExpiring(
		now + WORKLOAD_KEY_WARN_BELOW_SECONDS,
		now - WORKLOAD_KEY_WARN_EVERY_SECONDS,
	)
	for (const keys of byEnvironment(expiring)) {
		const first = keys[0]
		if (first === undefined) continue
		const { app_id: appId, env } = first
		const soonest = Math.min(...keys.map((key) => key.expires_at))
		const expired = soonest <= now
		const message = `the workload keys of ${appId}/${env} (${keys.map((key) => `${key.kind} '${key.name}'`).join(', ')}) `
			+ (expired ? 'have expired' : `expire in ${Math.ceil((soonest - now) / DAY_SECONDS)} day(s)`)
			+ ' and Control could not hand the running version renewed ones; deploy the environment'
		console.warn(`workload keys: ${message}`)
		const delivered = await report(deps, appId, env, { message, level: expired ? 'error' : 'warning', expiresAt: soonest })
		if (!delivered) {
			summary.failed++
			continue
		}
		for (const key of keys) {
			await deps.repositories.workloadCredentials.markExpiryWarned(appId, env, key.kind, key.name, key.credential_id, now)
		}
		summary.warned++
	}
	return summary
}

function byEnvironment(keys: readonly ExpiringWorkloadKey[]): ExpiringWorkloadKey[][] {
	const groups = new Map<string, ExpiringWorkloadKey[]>()
	for (const key of keys) {
		const id = JSON.stringify([key.app_id, key.env])
		groups.set(id, [...(groups.get(id) ?? []), key])
	}
	return [...groups.values()]
}

interface Warning {
	readonly message: string
	readonly level: 'warning' | 'error'
	readonly expiresAt: number
}

/**
 * `true` when the application's Operations took the event, refused it for good (a 4xx), or has none to send it to: the
 * log line stands, and the keys are not warned again that day.
 */
async function report(deps: WorkloadKeyExpiryDeps, appId: string, env: string, warning: Warning): Promise<boolean> {
	const delivery = await sendControlEvent(deps, appId, env, {
		type: 'WorkloadKeyExpiring',
		message: warning.message,
		level: warning.level,
		fingerprint: ['fabrika-workload-key-expiring'],
		tags: { expires_at: new Date(warning.expiresAt * 1000).toISOString() },
	})
	switch (delivery.outcome) {
		case 'delivered':
		case 'no-ingest':
			return true
		case 'refused':
			console.error(`workload keys: the Operations of ${appId}/${env} refused the expiry warning with ${delivery.status}; not sent again today`)
			return true
		case 'failed':
			// Never the error: it may quote the ingest URL; the line names the environment only.
			console.error(
				delivery.status === undefined
					? `workload keys: the expiry warning of ${appId}/${env} could not reach its Operations; sent again next pass`
					: `workload keys: the Operations of ${appId}/${env} answered the expiry warning with ${delivery.status}; sent again next pass`,
			)
			return false
	}
}
