// The ZEROPS driver's side-effecting collaborators — its ONE seam, the counterpart of
// `CloudflareCollaborators`. Note how little is in it, and that nothing from Cloudflare's bundle appears:
// a Zerops deploy has no shell, no filesystem and no oblaka, so a `runCommand` here would be a lie in the
// type system (ADR-0009). That is exactly why collaborators moved out of `deploy()`'s parameter list.

import type { ZeropsTarget } from '../../types'
import { defaultReconcileSchema, type SchemaReconciler } from '../shared/schema'
import { createZeropsApi, type ZeropsApi } from './api'

/**
 * A cancellable pause. Injected rather than called directly so the `await-deploy` poll loop is testable in
 * real time (a fake resolves immediately) and so cancellation interrupts the WAIT, not just the request.
 */
export type Sleeper = (ms: number, signal: AbortSignal) => Promise<void>

/** The real sleeper: resolves after `ms`, or as soon as the run is cancelled. */
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

/** The full bundle of collaborators the ZEROPS driver depends on. Tests substitute `api` wholesale. */
export interface ZeropsCollaborators {
	/** The Zerops REST client — the entirety of this driver's contact with the platform. */
	api: ZeropsApi
	/** Portable across drivers: it talks to the IAM service, not to a cloud (ADR-0002). */
	reconcileSchema: SchemaReconciler
	/** Between poll iterations of `await-deploy`. */
	sleep: Sleeper
}

/**
 * How the driver obtains its bundle. A FACTORY rather than a value, unlike Cloudflare's: the Zerops client
 * is authenticated with a token that lives on the run's `ctx.target`, so the bundle cannot be built once at
 * module load. Tests pass `() => fakes` and ignore the target.
 */
export type ZeropsCollaboratorFactory = (target: ZeropsTarget) => ZeropsCollaborators

/** The production factory: a real REST client for the run's token, the real propustka reconciler, real timers. */
export const defaultZeropsCollaborators: ZeropsCollaboratorFactory = (target) => ({
	api: createZeropsApi({ token: target.accessToken, baseUrl: target.apiBaseUrl }),
	reconcileSchema: defaultReconcileSchema,
	sleep: defaultSleep,
})
