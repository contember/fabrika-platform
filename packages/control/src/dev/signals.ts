// Wakes a request that waits on a `dev` environment's or a workspace sandbox's record when this process changes it. Another Control process
// does not see the wake-up, so every waiter also re-reads the record at least once a second.

import type { DevSync } from '@fabrika/app/dev/wire'

/** How long a waiter sleeps between two reads of the record at most. */
export const DEV_RECHECK_MS = 1_000

export class DevSignals {
	private readonly waiters = new Map<string, Set<() => void>>()
	/** The files of the newest commit this process made for each key, until a wait takes them. */
	private readonly handoffs = new Map<string, DevSync>()

	/** Resolves on `notify(key)`, after `ms`, or when `signal` aborts, whichever comes first. */
	wait(key: string, ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer)
				signal?.removeEventListener('abort', done)
				const set = this.waiters.get(key)
				set?.delete(done)
				if (set?.size === 0) this.waiters.delete(key)
				resolve()
			}
			const timer = setTimeout(done, Math.max(0, ms))
			if (signal?.aborted === true) return done()
			signal?.addEventListener('abort', done)
			const set = this.waiters.get(key) ?? new Set()
			set.add(done)
			this.waiters.set(key, set)
		})
	}

	notify(key: string): void {
		for (const wake of [...(this.waiters.get(key) ?? [])]) wake()
	}

	/**
	 * Hand a waiting launcher the files of a commit this process just made, so its answer needs no GitHub read. Held in
	 * memory only, one per key; another process, or a launcher at another head, reads the compare instead.
	 */
	offer(key: string, sync: DevSync): void {
		this.handoffs.set(key, sync)
	}

	/** The offered files that bring `from` to `to`, once; null when this process holds none for that step. */
	take(key: string, from: string, to: string): DevSync | null {
		const offered = this.handoffs.get(key)
		if (offered === undefined || offered.from !== from || offered.to !== to) return null
		this.handoffs.delete(key)
		return offered
	}
}

/** The launcher waits on this key; a commit, a bind, a reset or a check request wakes it. */
export const devTargetKey = (appId: string, env: string): string => `target:${appId}@${env}`

/** `apply_changes`, `run_checks` and `get_dev_status` wait on this key; a launcher report wakes them. */
export const devReportKey = (appId: string, env: string): string => `report:${appId}@${env}`

/** `devTargetKey` of one workspace's sandbox. */
export const devSandboxTargetKey = (workspaceId: string): string => `target:${workspaceId}`

/** `devReportKey` of one workspace's sandbox. */
export const devSandboxReportKey = (workspaceId: string): string => `report:${workspaceId}`

/**
 * Sleep in steps of at most `DEV_RECHECK_MS` until `ready` answers a value or `ms` passed; null on the timeout. A wake-up
 * of `key` cuts the current step short.
 */
export async function waitForRecord<T>(
	signals: DevSignals,
	key: string,
	ms: number,
	ready: () => Promise<T | null>,
	signal?: AbortSignal,
): Promise<T | null> {
	const deadline = Date.now() + ms
	for (;;) {
		const value = await ready()
		if (value !== null) return value
		const remaining = deadline - Date.now()
		if (remaining <= 0 || signal?.aborted === true) return null
		await signals.wait(key, Math.min(DEV_RECHECK_MS, remaining), signal)
	}
}
