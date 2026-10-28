// ─── Cloudflare Workers adapter, Postgres through Hyperdrive ─────────
//
// The entry `fabrika app build` writes for a Cloudflare application whose config chooses Postgres: the stateless Worker
// serves every request over the `FABRIKA_DATABASE` Hyperdrive binding, and a small Durable Object (the class and binding
// names of ADR-0065) runs only the jobs from its alarm.
//
// A seam for now: the signatures are final, the runtime is not written yet.

import type { PostgresJSSql } from 'kysely-postgres-js'
import type { ContractWorker } from './cloudflare.js'
import type { ImplementationLoader } from './cloudflare/application.js'
import type { CrashEvents } from './implement/crashes.js'
import type { JobClock } from './jobs/runner.js'

export { markProductionProcess } from '@fabrika/db/production'

/** The part of a postgres.js client the Hyperdrive engine reads: one reserved connection per transaction. */
type HyperdriveClient = Pick<PostgresJSSql, 'reserve'>

/** One event's postgres.js client, which the Worker ends after the event's tracked work settled. */
export interface PostgresEventClient extends HyperdriveClient {
	end(options?: { readonly timeout?: number }): Promise<void>
}

export interface PostgresWorkerOptions {
	/** Where the isolate hears of an unhandled rejection; the global `unhandledrejection` event by default. */
	readonly rejections?: CrashEvents
	/** What posts a report to Operations' ingest; `fetch` by default. */
	readonly operationsFetch?: (request: Request) => Promise<Response>
	/** The jobs' and the alarm's waits and an attempt's deadline; the system clock by default. */
	readonly clock?: JobClock
	/**
	 * Opens one event's client from `FABRIKA_DATABASE.connectionString`;
	 * `postgres(url, { max: HYPERDRIVE_CLIENT_MAX, fetch_types: false, prepare: false })` by default.
	 */
	readonly connect?: (connectionString: string) => PostgresEventClient
}

/** The connections one event's client opens at most: Workers allow six simultaneous connections per invocation. */
export const HYPERDRIVE_CLIENT_MAX = 5

/** The job object re-arms its alarm at least this often, so a wake nothing projected still runs. */
export const POSTGRES_ALARM_REFRESH_MS = 60_000

/** The path on which the Worker tells the job object that a request projected a wake. */
export const WAKE_PATH = '/__fabrika/wake'

/** The milliseconds from now until the earliest wake the request projected. */
export const WAKE_DELAY_HEADER = 'X-Fabrika-Wake-Delay'

/** The Worker module of a Cloudflare contract application on Postgres, called only by the generated entrypoint. */
export function createPostgresContractWorker(_load: ImplementationLoader, _options?: PostgresWorkerOptions): ContractWorker {
	throw new Error('not implemented (WU2)')
}

/** What the job object reads of its Durable Object state. */
export interface JobObjectState {
	readonly storage: { setAlarm(at: number): Promise<void>; getAlarm(): Promise<number | null>; deleteAlarm(): Promise<void> }
	waitUntil(promise: Promise<unknown>): void
	blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
}

/** The Durable Object of a Postgres application: it runs the jobs from its alarm and serves no request of its own. */
export class FabrikaJobObject {
	constructor(_state: JobObjectState, _env: Readonly<Record<string, unknown>>) {
		throw new Error('not implemented (WU2)')
	}

	fetch(_request: Request): Promise<Response> {
		return Promise.reject(new Error('not implemented (WU2)'))
	}

	alarm(): Promise<void> {
		return Promise.reject(new Error('not implemented (WU2)'))
	}
}
