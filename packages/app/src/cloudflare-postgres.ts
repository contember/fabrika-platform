// ─── Cloudflare Workers adapter, Postgres through Hyperdrive ─────────
//
// The entry `fabrika app build` writes for a Cloudflare application whose config chooses Postgres: the stateless Worker
// serves every request over the `FABRIKA_DATABASE` Hyperdrive binding, and a small Durable Object (the class and binding
// names of ADR-0065) runs only the jobs from its alarm.

import { OPS_PREFIX, opsRefusal, PROXY_SECRET_HEADER } from '@fabrika/auth-core'
import type { ContractWorker } from './cloudflare.js'
import type { ImplementationLoader } from './cloudflare/application.js'
import { TICK_HEADER } from './cloudflare/application.js'
import {
	jobObject,
	notifyWake,
	PostgresEvent,
	type PostgresWorkerOptions,
	proxySecretOf,
	registerPostgresApplication,
} from './cloudflare/postgres-runtime.js'

export { markProductionProcess } from '@fabrika/db/production'
export { FabrikaJobObject, type JobObjectState } from './cloudflare/postgres-object.js'
export {
	HYPERDRIVE_CLIENT_MAX,
	POSTGRES_ALARM_REFRESH_MS,
	type PostgresEventClient,
	type PostgresWorkerOptions,
	WAKE_DELAY_HEADER,
	WAKE_PATH,
} from './cloudflare/postgres-runtime.js'

/**
 * The Worker module of a Cloudflare contract application on Postgres, called only by the generated entrypoint, which
 * also exports `FabrikaJobObject` as `FabrikaApplication`. The Worker boots the application once per isolate and serves
 * each request itself, on a postgres.js client of its own that ends once the work the request handed to `waitUntil`
 * settled. A request whose writes changed a wake (a kick, a claim) tells the job object afterwards, which lowers its
 * alarm to the earliest; `scheduled` sends it the repair tick. The first request an isolate serves also starts the
 * scheduler (`startScheduler`). An ops request is refused: a Postgres environment has no ops channel.
 */
export function createPostgresContractWorker(load: ImplementationLoader, options: PostgresWorkerOptions = {}): ContractWorker {
	const application = registerPostgresApplication(load, options)
	/** Whether this isolate told the job object to start its scheduler, or is telling it now. */
	let started = false
	return {
		async fetch(request, env, exec) {
			if (new URL(request.url).pathname.startsWith(OPS_PREFIX)) {
				return opsRefusal()
			}
			const secret = proxySecretOf(env)
			const outcome = await application.current(env, (promise) => exec.waitUntil(promise))
			if ('failure' in outcome) {
				throw outcome.failure
			}
			const { app } = outcome
			if (!started && (app.jobs.scheduler?.jobs.length ?? 0) > 0) {
				started = true
				exec.waitUntil(startScheduler(env, () => {
					started = false
				}))
			}
			// The earliest wake the request's writes left, in epoch milliseconds of this isolate's clock.
			let wakeAt: number | null = null
			const event = new PostgresEvent(application.connect(env), async (transaction) => {
				const delay = await app.jobs.scheduler?.untilNext(transaction)
				if (delay !== undefined && delay !== null) {
					const at = Date.now() + Math.max(0, delay)
					wakeAt = wakeAt === null ? at : Math.min(wakeAt, at)
				}
			})
			const headers = new Headers(request.headers)
			// Only the Worker's own `scheduled` reaches the tick.
			headers.delete(TICK_HEADER)
			headers.set(PROXY_SECRET_HEADER, secret)
			try {
				return await event.run(() => app.fetch(new Request(request, { headers }), event.exec))
			} finally {
				exec.waitUntil(finish(event, env, () => wakeAt))
			}
		},
		async scheduled(controller, env) {
			const tick = new Request('https://application.invalid/', {
				method: 'POST',
				headers: { [PROXY_SECRET_HEADER]: proxySecretOf(env), [TICK_HEADER]: String(controller.scheduledTime) },
			})
			const response = await jobObject(env)(tick)
			await response.body?.cancel()
			if (!response.ok) {
				throw new Error(`the application's job object answered the repair tick with ${response.status}`)
			}
		},
	}
}

/**
 * The job object hears of nothing on its own: its alarm is unarmed on a fresh environment, and after a redeploy that added
 * the first job. A wake notice due now lowers its alarm to now, and that alarm runs the startup repair (a cron wake per
 * declared job) and arms itself, so the scheduled jobs start with the first traffic of each isolate, not at the next
 * hourly repair tick. A notice that fails lets the isolate's next request try again.
 */
async function startScheduler(env: Readonly<Record<string, unknown>>, failed: () => void): Promise<void> {
	try {
		await notifyWake(env, 0)
	} catch {
		failed()
		console.error('fabrika: the job object did not hear of the first request: wake_failed; the repair tick starts it')
	}
}

/**
 * After the response: once every work the request handed on settled (its writes committed), the job object hears of
 * the earliest wake they left, then the request's client ends. A notice that fails is caught by the object's refresh.
 */
async function finish(event: PostgresEvent, env: Readonly<Record<string, unknown>>, wakeAt: () => number | null): Promise<void> {
	await event.settled()
	const at = wakeAt()
	if (at !== null) {
		try {
			await notifyWake(env, at - Date.now())
		} catch {
			console.error('fabrika: the job object did not hear of a wake: wake_failed; its alarm refresh runs it')
		}
	}
	await event.end()
}
