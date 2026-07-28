// Scheduled maintenance — the work behind the Worker's `scheduled` handler, extracted so the
// long-running process runs exactly the same code on exactly the same schedule.
//
// Cloudflare drives it from `triggers.crons` in the Worker config (`0 3 * * *`); Zerops drives it
// from `run.crontab` in `zerops.yaml`, which invokes `node/prune.ts`. That is the mapping the
// portability surface calls "`scheduled` handler → platform cron": no in-process timer, because a
// timer in a horizontally-scaled service fires once per container and its schedule silently resets
// on every redeploy. The operation is idempotent (a DELETE by cutoff), so a duplicate run from an
// overlapping cron is harmless either way.

import type { Env, RequestContext } from './env'
import { buildServices } from './services'

/**
 * Retention for `auth_log`. `audit_events` are kept long; only the dense, high-churn auth log is
 * pruned — it is the one table that grows without bound and is never referenced by a foreign key.
 */
export const AUTH_LOG_RETENTION_SECONDS = 30 * 24 * 60 * 60 // 30 days

/**
 * Prune `auth_log` rows older than the retention window. Registered through `waitUntil` because on
 * Workers a `scheduled` handler that returns before its writes settle is cut off mid-flight; in a
 * process the supervised promise means a failure is logged rather than fatal.
 */
export function pruneAuthLog(env: Env, ctx: RequestContext, now: number = Date.now()): void {
	const services = buildServices(env)
	const cutoff = Math.floor(now / 1000) - AUTH_LOG_RETENTION_SECONDS
	ctx.waitUntil(services.db.pruneAuthLog(cutoff).then(() => undefined))
}
