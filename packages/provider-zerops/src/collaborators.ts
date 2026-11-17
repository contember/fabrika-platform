import { createZeropsApi, type ZeropsApi } from './api'
import { type ExposureAlerter, sendExposureAlert } from './exposure'
import type { ZeropsSourcePort } from './source/port'
import type { ZeropsRuntimeTarget } from './types'

export type Sleeper = (ms: number, signal: AbortSignal) => Promise<void>

/** Elapsed time and the per-request timeouts measured on it. */
export interface ZeropsClock {
	now(): number
	/** A signal that aborts `ms` from now. */
	timeout(ms: number): AbortSignal
}

export const systemClock: ZeropsClock = { now: () => Date.now(), timeout: (ms) => AbortSignal.timeout(ms) }

export const defaultSleep: Sleeper = (ms, signal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve()
			return
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort)
			resolve()
		}, ms)
		const onAbort = (): void => {
			clearTimeout(timer)
			resolve()
		}
		signal.addEventListener('abort', onAbort, { once: true })
	})

export interface ZeropsCollaborators {
	api: ZeropsApi
	/** Injected by the Zerops control composition; dry runs do not require it. */
	source?: ZeropsSourcePort
	/** Raises the Operations alert for a refused activation; best-effort. */
	alertExposure: ExposureAlerter
	sleep: Sleeper
	/** The clock the database backup's wait runs on; the system clock when absent. */
	clock?: ZeropsClock
}

export type ZeropsCollaboratorFactory = (target: ZeropsRuntimeTarget) => ZeropsCollaborators

export const defaultZeropsCollaborators: ZeropsCollaboratorFactory = (target) => ({
	api: createZeropsApi({ token: target.accessToken, baseUrl: target.apiBaseUrl }),
	alertExposure: sendExposureAlert,
	sleep: defaultSleep,
})
