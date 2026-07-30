// The ONE database write vozka-runner makes: move a run to its terminal state (`succeeded` | `failed`),
// stamping the exit code + `finished_at`. vozka-runner writes this DIRECTLY (rather than letting the
// fabrika control plane record it after the relay returns) so a run is recorded even when the caller —
// fabrika's queue consumer — was reset mid-deploy. That happens precisely for fabrika's OWN self-deploy:
// the deploy resets the fabrika worker but NOT vozka-runner, so vozka-runner is the one component
// guaranteed to survive to the end of the run and write the outcome.
//
// This deliberately DUPLICATES `@fabrika/control`'s `Db.markRunFinished` (same guarded UPDATE) instead of
// importing it — the executor and control plane are separate packages and must not form a cycle.
// be a cycle. The control plane owns the `runs` schema + migrations; this is a single, stable column
// write that must stay in sync with that method. Keep the two identical — same SQL text, same bind
// order (status, exit_code, finished_at, id). `finished_at` is stamped CALLER-side in unix seconds
// (never `unixepoch()`, which does not exist in Postgres), exactly as `Db.markRunFinished` does.
//
// The `WHERE status IN ('pending','running')` guard makes the write idempotent and order-independent:
// whichever of vozka-runner / the (possibly still-alive) control plane writes FIRST wins the
// pending|running → terminal transition; the other finds no matching row and is a harmless no-op.

import type { SqlDatabase } from '@fabrika/platform'
import type { RunnerStatus } from '@fabrika/runner-contract'

/**
 * Record a run's terminal outcome. Returns true if THIS call performed the transition (the run was
 * still pending|running), false if it was already terminal (a no-op — the control plane beat us to it).
 * Never throws on a no-op; a thrown database error propagates to the caller (logged as a short message).
 *
 * `now` is injectable so the stamp is deterministic in tests; it returns unix SECONDS, the unit
 * `runs.finished_at` uses (the control plane's `Db` carries the same clock on its constructor).
 */
export const finishRun = async (
	db: SqlDatabase,
	runId: string,
	status: 'succeeded' | 'failed',
	exitCode: number | null,
	now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<boolean> => {
	const result = await db
		.prepare(`UPDATE runs SET status = ?, exit_code = ?, finished_at = ?
			WHERE id = ? AND status IN ('pending','running')`)
		.bind(status, exitCode, now(), runId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/** True when the run has already reached a terminal state (so the backstop can skip its work). */
export const isRunFinished = async (db: SqlDatabase, runId: string): Promise<boolean> => {
	const row = await db
		.prepare(`SELECT status FROM runs WHERE id = ? AND status IN ('succeeded','failed')`)
		.bind(runId)
		.first<{ status: string }>()
	return row !== null
}

/** What the backstop should do this tick — extracted as a pure function so the decision is unit-tested. */
export type BackstopAction =
	| { kind: 'noop' } // the relay/control-plane already recorded the run
	| { kind: 'finish'; state: 'succeeded' | 'failed'; exitCode: number | null }
	| { kind: 'reschedule' } // still in flight — poll again later

/**
 * Decide the backstop action from what it observed: whether the run is already finished, the container's
 * status (null = unreachable), and whether the backstop deadline has passed. The backstop writes the
 * terminal status to D1 when the relay (which runs inside the control-plane RPC) was cut off before it
 * could — e.g. a fabrika self-deploy resets fabrika and aborts the RPC, but the container (this DO, in
 * vozka-runner) survives and finishes the deploy. Past the deadline an unfinished/unreachable run is
 * recorded as failed rather than left dangling forever.
 */
export const backstopDecision = (input: { alreadyFinished: boolean; status: RunnerStatus | null; expired: boolean }): BackstopAction => {
	if (input.alreadyFinished) {
		return { kind: 'noop' }
	}
	if (input.status === null) {
		// Container unreachable: it's gone for good only once we're past the deadline.
		return input.expired ? { kind: 'finish', state: 'failed', exitCode: null } : { kind: 'reschedule' }
	}
	if (input.status.state === 'succeeded' || input.status.state === 'failed') {
		return { kind: 'finish', state: input.status.state, exitCode: input.status.exitCode ?? null }
	}
	// Still cloning/installing/deploying — keep polling until terminal or the deadline passes.
	return input.expired ? { kind: 'finish', state: 'failed', exitCode: null } : { kind: 'reschedule' }
}
