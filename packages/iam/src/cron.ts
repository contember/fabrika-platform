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
export const PASSWORD_TRANSIENT_RETENTION_SECONDS = 7 * 24 * 60 * 60 // 7 days

/**
 * Prune old auth-log rows, password action tokens, login throttles, and spent handoff codes.
 * Registered through `waitUntil` because a Worker scheduled handler that returns before its writes
 * settle is cut off; in a process the supervised promise means a failure is logged rather than fatal.
 */
export function runIamMaintenance(env: Env, ctx: RequestContext, now: number = Date.now()): void {
	const services = buildServices(env)
	const nowSeconds = Math.floor(now / 1000)
	ctx.waitUntil(
		Promise.all([
			services.repositories.audit.pruneAuthLog(nowSeconds - AUTH_LOG_RETENTION_SECONDS),
			services.repositories.passwords.pruneActionTokens(nowSeconds - PASSWORD_TRANSIENT_RETENTION_SECONDS),
			services.repositories.passwords.pruneLoginThrottles(nowSeconds - PASSWORD_TRANSIENT_RETENTION_SECONDS),
			// Codes live two minutes and are single-use, so this only sweeps ones nobody redeemed.
			services.repositories.handoff.pruneCodes(nowSeconds),
		]).then(() => undefined),
	)
}
