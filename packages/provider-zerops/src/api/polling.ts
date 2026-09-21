import type { Sleeper } from '../collaborators'
import { ZEROPS_PROCESS_FINISHED, ZEROPS_PROCESS_TERMINAL, type ZeropsApi, type ZeropsProcess } from './types'

// ── waiting on a process ────────────────────────────────────────────────────────

/**
 * How often `waitForProcess` polls. The two process durations anyone has measured are 0.7 s
 * (`stack.enableSubdomainAccess`) and 2.6 s (`stack.updateUserData`), so 5 s — the platform DEPLOY's
 * interval — would spend most of its time asleep on a call that already finished.
 */
const PROCESS_POLL_INTERVAL_MS = 2_000

/** ~5 minutes. The slow case is an import that creates managed services, not a build; a build is polled through `/app-version`. */
const PROCESS_POLL_ATTEMPTS = 150

/**
 * Poll ONE process to completion.
 *
 * The same loop `installation-zerops`'s `deployService` runs over `/app-version`, run over `/process`
 * instead: read, decide ONLY on a status this build knows to be terminal, sleep, and give up on a deadline
 * of our own rather than on a coincidence. Returns the finished process so a caller can read
 * `actionName`/`appVersionId` off it.
 *
 * Anything outside `ZEROPS_PROCESS_TERMINAL` means "keep waiting", including a status this build has never
 * seen — which is why an unpublished vocabulary (see that constant) can cost a timeout and never a false
 * success. A non-`FINISHED` terminal status throws, naming the status and nothing else.
 */
export const waitForProcess = async (input: {
	api: Pick<ZeropsApi, 'getProcess'>
	processId: string
	sleep: Sleeper
	signal: AbortSignal
	/** What to call this process in a failure or timeout message. Defaults to its id. */
	label?: string
	intervalMs?: number
	attempts?: number
}): Promise<ZeropsProcess> => {
	const label = input.label ?? input.processId
	const intervalMs = input.intervalMs ?? PROCESS_POLL_INTERVAL_MS
	const attempts = input.attempts ?? PROCESS_POLL_ATTEMPTS
	for (let attempt = 0;; attempt += 1) {
		// A `Sleeper` resolves early on abort, so without this the loop would spin out its whole budget
		// against a cancelled run.
		if (input.signal.aborted) {
			throw new Error(`zerops: waiting for ${label} was cancelled`)
		}
		const process = await input.api.getProcess({ processId: input.processId, signal: input.signal })
		if (process.status !== undefined && ZEROPS_PROCESS_TERMINAL.has(process.status)) {
			if (process.status !== ZEROPS_PROCESS_FINISHED) {
				throw new Error(`zerops: ${label} finished as ${process.status}`)
			}
			return process
		}
		if (attempt >= attempts) {
			throw new Error(`zerops: ${label} did not finish in time`)
		}
		await input.sleep(intervalMs, input.signal)
	}
}
