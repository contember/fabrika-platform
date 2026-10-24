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

const DAY_SECONDS = 24 * 60 * 60

/**
 * Retention for the transient tables. `auth_log` and `audit_events` follow the operator's setting
 * (`Config.retention`, `src/retention.ts`): `auth_log` defaults to 30 days, and `audit_events` are kept unless the
 * operator set a retention.
 */
export const PASSWORD_TRANSIENT_RETENTION_SECONDS = 7 * 24 * 60 * 60 // 7 days
export const INVITATION_RETENTION_SECONDS = 7 * 24 * 60 * 60 // 7 days past expiry

/**
 * Prune old auth-log rows, audit rows past an operator's retention, password action tokens, login throttles, spent handoff codes and delegation
 * grants, old invitations, dead sessions and ended terminal identifications. Registered through `waitUntil` because a Worker scheduled
 * handler that returns before its writes settle is cut off; in a process the supervised promise means a
 * failure is logged rather than fatal.
 */
export function runIamMaintenance(env: Env, ctx: RequestContext, now: number = Date.now()): void {
	const services = buildServices(env)
	const nowSeconds = Math.floor(now / 1000)
	const { authLogDays, auditDays } = services.config.retention
	ctx.waitUntil(
		Promise.all([
			services.repositories.device.prune(nowSeconds),
			services.repositories.oauth.prune(nowSeconds),
			services.repositories.audit.pruneAuthLog(nowSeconds - authLogDays * DAY_SECONDS),
			auditDays === null ? Promise.resolve(0) : services.repositories.audit.pruneAuditEvents(nowSeconds - auditDays * DAY_SECONDS),
			services.repositories.passwords.pruneActionTokens(nowSeconds - PASSWORD_TRANSIENT_RETENTION_SECONDS),
			services.repositories.passwords.pruneLoginThrottles(nowSeconds - PASSWORD_TRANSIENT_RETENTION_SECONDS),
			// Codes live two minutes and are single-use, so this only sweeps ones nobody redeemed.
			services.repositories.handoff.pruneCodes(nowSeconds),
			// Delegation grants live two minutes and are single-use; invitations go a week after they expire.
			services.repositories.membership.prune(nowSeconds, nowSeconds - INVITATION_RETENTION_SECONDS),
			// Sessions, at expiry — no grace period, because an expired or revoked session is already
			// refused at use and the row exists only to be deleted. `pruneSessions` was written, tested
			// and then never called, so `sessions` grew for the life of every installation (SEC-13).
			services.repositories.sessions.pruneSessions(nowSeconds),
			// Identifications live two minutes and are single-use, like handoff codes.
			services.repositories.terminals.pruneIdentifications(nowSeconds),
		]).then(() => undefined),
	)
}
