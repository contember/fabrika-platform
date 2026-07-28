// `WaitUntil` for a long-running process — the seam that stops call sites branching on the runtime.
//
// On Workers `ctx.waitUntil` keeps the isolate alive past the response. A Bun process is already
// alive, so all this has to do is SUPERVISE: hold a reference so a graceful shutdown can wait for the
// work, and — the part that actually matters — swallow rejections. An unhandled rejection from a
// background promise terminates the process by default, which would turn a failed log flush into an
// outage. Every rejection is logged as a short message and dropped.
//
// `drain()` exists for the two moments a process needs it: shutdown (finish what was promised before
// exiting) and tests (assert on the effect of background work without sleeping).

import type { WaitUntil } from '@fabrika/platform'

export interface BackgroundTasks {
	/** The port itself. Hand it a promise and forget it; it never throws and never rejects. */
	readonly waitUntil: WaitUntil
	/** How many supervised promises are still in flight. */
	readonly pending: number
	/** Settle once every supervised promise has finished, including ones added while draining. */
	drain(): Promise<void>
}

export interface BackgroundTasksOptions {
	/**
	 * Called for every rejection instead of the default log. Keep it cheap and non-throwing — a throw
	 * here is itself swallowed. NEVER log the error object: it may quote a clone URL with an embedded
	 * token.
	 */
	onError?: (error: unknown) => void
	/** Prefix for the default log line, so a process running several of these can tell them apart. */
	label?: string
}

export function createBackgroundTasks(options: BackgroundTasksOptions = {}): BackgroundTasks {
	const label = options.label ?? 'background task'
	const onError = options.onError ?? ((error: unknown) => {
		console.error(`${label} failed:`, error instanceof Error ? error.message : 'unknown error')
	})
	const inFlight = new Set<Promise<void>>()

	const waitUntil: WaitUntil = (promise) => {
		const supervised = Promise.resolve(promise).then(
			() => {},
			(error: unknown) => {
				try {
					onError(error)
				} catch {
					// A reporter that throws must not resurrect the failure it was meant to absorb.
				}
			},
		).finally(() => {
			inFlight.delete(supervised)
		})
		inFlight.add(supervised)
	}

	return {
		waitUntil,
		get pending(): number {
			return inFlight.size
		},
		async drain(): Promise<void> {
			// A task may enqueue another task, so keep going until the set is genuinely empty.
			while (inFlight.size > 0) {
				await Promise.all([...inFlight])
			}
		},
	}
}
