import { ZeropsApiError } from '../api/errors'
import type { ZeropsApi } from '../api/types'
import type { Sleeper } from '../collaborators'
import type { ZeropsSourceClient } from '../source'

export const isAbsentManagedVersion = (error: unknown): boolean =>
	error instanceof ZeropsApiError && error.status === 400 && error.code === 'appVersionNotFound'

/** Only pre-submission callers may delete; a late upload cannot revive a version confirmed absent. */
export async function cleanupManagedReservation(input: {
	api: Pick<ZeropsApi, 'deleteAppVersion' | 'getAppVersion'>
	source: Pick<ZeropsSourceClient, 'cancel'>
	runId: string
	appVersionId: string
	signal: AbortSignal
	sleep: Sleeper
}): Promise<boolean> {
	input.signal.throwIfAborted()
	const cancellation = new AbortController()
	const timeout = new AbortController()
	try {
		await Promise.race([
			Promise.resolve().then(() =>
				input.source.cancel({ runId: input.runId, appVersionId: input.appVersionId, signal: AbortSignal.any([input.signal, cancellation.signal]) })
			)
				.then(() => true, () => false),
			Promise.resolve().then(() => input.sleep(5000, timeout.signal)).then(() => false, () => false),
		])
	} finally {
		timeout.abort()
		cancellation.abort()
	}
	input.signal.throwIfAborted()
	try {
		await input.api.deleteAppVersion({ appVersionId: input.appVersionId, signal: input.signal })
	} catch (error) {
		input.signal.throwIfAborted()
		if (!isAbsentManagedVersion(error)) return false
	}
	input.signal.throwIfAborted()
	try {
		await input.api.getAppVersion({ appVersionId: input.appVersionId, signal: input.signal })
		return false
	} catch (error) {
		input.signal.throwIfAborted()
		return isAbsentManagedVersion(error)
	}
}
