// A failure outside any request or job run (ADR-0059): a boot that throws, an uncaught exception, an unhandled
// rejection. Each is one Operations event of what was thrown, scrubbed like every other report. A request's and a job
// run's failures are caught and reported where they happen, so none of them reaches these listeners.

import { type CrashKind, type CrashReporter, crashReporter, operationsSettings } from '../jobs/report'
import { environmentScrubber } from '../jobs/scrub'
import type { CapturedEnvironment } from './environment'
import { MAX_FAILURE_REPORTS_PER_MINUTE, MinuteBudget } from './failures'

/** How long a crash or a failed boot waits for its report before the process fails as it would have without one. */
export const CRASH_FLUSH_MS = 2_000

export type ProcessCrashKind = Exclude<CrashKind, 'boot_failed'>

export interface CrashEvents {
	/** Starts listening; the returned function stops, which gives the runtime its own handling back. */
	listen(listener: (kind: ProcessCrashKind, error: unknown) => void): () => void
}

/** The reporter of `environment`'s DSN, or `null` without a usable one: `boot` reports a DSN that is not one. */
export function environmentCrashReporter(
	environment: CapturedEnvironment,
	fetch: ((request: Request) => Promise<Response>) | undefined,
): CrashReporter | null {
	const settings = operationsSettings(environment.framework, [])
	if (settings === null) {
		return null
	}
	return crashReporter({ ...settings, scrubber: environmentScrubber(environment), ...(fetch === undefined ? {} : { fetch }) })
}

/** Reports and waits for the delivery, at most `flushMs`. Never rejects. */
export async function reportWithin(reporter: CrashReporter, kind: CrashKind, error: unknown, flushMs = CRASH_FLUSH_MS): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const elapsed = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, flushMs)
	})
	try {
		await Promise.race([reporter.report(kind, error), elapsed])
	} finally {
		clearTimeout(timer)
	}
}

export interface FatalCrashOptions {
	readonly events: CrashEvents
	readonly reporter: CrashReporter
	/** Fails the process as the runtime would have without a listener: the listeners are stopped by then. */
	readonly fail: (kind: ProcessCrashKind, error: unknown) => void
	readonly flushMs?: number
}

/**
 * A process that dies of a crash (Bun): the first crash is reported, then the listeners stop and `fail` hands it back
 * to the runtime, which prints it and exits as before. A second crash during that wait is not reported: the process is
 * already failing.
 */
export function reportFatalCrashes(options: FatalCrashOptions): () => void {
	let crashing = false
	const stop = options.events.listen((kind, error) => {
		if (crashing) {
			return
		}
		crashing = true
		void reportWithin(options.reporter, kind, error, options.flushMs).then(() => {
			stop()
			options.fail(kind, error)
		})
	})
	return stop
}

/**
 * An isolate that survives an unhandled rejection (a Worker): each one is reported, at most
 * `MAX_FAILURE_REPORTS_PER_MINUTE` per minute, and the runtime keeps its own handling.
 */
export function reportSurvivedCrashes(events: CrashEvents, reporter: CrashReporter, now: () => number = Date.now): () => void {
	const budget = new MinuteBudget(MAX_FAILURE_REPORTS_PER_MINUTE, now)
	return events.listen((kind, error) => {
		if (budget.admit()) {
			void reporter.report(kind, error)
		}
	})
}
