// The runner's durable record of a run is its R2 `status.json`, written once the run is terminal. The
// control plane reads it back through `recoverRun` and is the only writer of the run's database row.

import type { RunnerStatus } from '@fabrika/runner-contract'
import { parseRunnerStatus, stampDryRun } from './protocol'
import { statusKey } from './relay'

/** First backstop check, ~after a short deploy would normally finish (the relay handles the fast path). */
export const BACKSTOP_FIRST_DELAY_S = 90
/** Re-poll interval while a run is still in flight, or after a failed settlement attempt. */
export const BACKSTOP_POLL_S = 45
/** Give up this long after dispatch (the container is hard-killed ~15 min in) and persist the run failed. */
export const RUN_DEADLINE_MS = 18 * 60 * 1000

export const DEADLINE_PASSED = 'runner deadline passed before the run finished'
export const NEVER_DISPATCHED = 'runner never dispatched the run'
export const PERSISTED_STATUS_MALFORMED = 'runner persisted a malformed status'

/** The slice of a Cloudflare R2 bucket the outcome needs. Real `R2Bucket` satisfies this. */
export interface R2Store {
	get: (key: string) => Promise<{ text(): Promise<string> } | null>
	put: (key: string, value: string) => Promise<unknown>
}

export const isTerminal = (status: RunnerStatus): boolean => status.state === 'succeeded' || status.state === 'failed'

const failure = (runId: string, error: string, startedAt: number, now: number, dryRun: boolean): RunnerStatus =>
	stampDryRun({ runId, state: 'failed', error, startedAt, finishedAt: now }, dryRun)

/**
 * The run's persisted terminal status, or null while none is persisted. A malformed object reads as a
 * failure: it can never become valid, and throwing would leave the run unsettled forever.
 */
export const readTerminalStatus = async (bucket: R2Store, runId: string, now: number): Promise<RunnerStatus | null> => {
	const object = await bucket.get(statusKey(runId))
	if (object === null) return null
	const text = await object.text()
	let status: RunnerStatus
	try {
		status = parseRunnerStatus(JSON.parse(text), runId)
	} catch {
		return failure(runId, PERSISTED_STATUS_MALFORMED, now, now, false)
	}
	return isTerminal(status) ? status : null
}

/** What settling a run needs from its Durable Object. */
export interface RunSettlementPorts {
	readonly runId: string
	/** From the Durable Object's own storage, never from the container. */
	readonly dryRun: boolean
	readonly bucket: R2Store
	readonly now: () => number
	/** The container's current status, or null when it is unreachable. */
	containerStatus(): Promise<RunnerStatus | null>
	/** Best-effort: copy the container's remaining log lines to R2. Never throws. */
	flushLogs(): Promise<void>
}

/**
 * Persist the run's terminal status when one is known: the container's own, or a failure past the
 * deadline. Returns the persisted status, or null while the run is still in flight. Storage errors throw.
 */
export const settleRun = async (ports: RunSettlementPorts, deadline: number): Promise<RunnerStatus | null> => {
	const now = ports.now()
	const persisted = await readTerminalStatus(ports.bucket, ports.runId, now)
	if (persisted !== null) return persisted
	const observed = await ports.containerStatus()
	let status: RunnerStatus
	if (observed !== null && isTerminal(observed)) status = stampDryRun(observed, ports.dryRun)
	else if (now > deadline) status = failure(ports.runId, DEADLINE_PASSED, observed?.startedAt ?? now, now, ports.dryRun)
	else return null
	if (observed !== null) await ports.flushLogs()
	await ports.bucket.put(statusKey(ports.runId), JSON.stringify(status))
	return status
}

/**
 * Recovery after a control-plane restart. `dispatchedAt` is null when the job never reached the
 * container (the caller has already fenced a late start); such a run is persisted failed.
 */
export const recoverDispatched = async (ports: RunSettlementPorts, dispatchedAt: number | null): Promise<RunnerStatus | null> => {
	if (dispatchedAt !== null) return settleRun(ports, dispatchedAt + RUN_DEADLINE_MS)
	const now = ports.now()
	const persisted = await readTerminalStatus(ports.bucket, ports.runId, now)
	if (persisted !== null) return persisted
	const status = failure(ports.runId, NEVER_DISPATCHED, now, now, ports.dryRun)
	await ports.bucket.put(statusKey(ports.runId), JSON.stringify(status))
	return status
}

/**
 * One backstop tick. `@cloudflare/containers` drops a scheduled callback that throws, so any failure
 * reschedules instead; `recoverRun` settles the run even if the backstop stops.
 */
export const backstopTick = async (settle: () => Promise<RunnerStatus | null>, reschedule: () => Promise<void>): Promise<void> => {
	let settled = false
	try {
		settled = (await settle()) !== null
	} catch {
		console.error('backstop: settlement failed, rescheduling')
	}
	if (!settled) await reschedule()
}
