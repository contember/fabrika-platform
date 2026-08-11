import type { SqlDatabase, SqlStatement } from '@fabrika/platform'
import type { RunnerStatus } from '@fabrika/runner-contract'
import { describe, expect, test } from 'bun:test'
import { backstopDecision, finishRun, isRunFinished } from '../finish-run'

// finishRun is vozka-runner's single database write — a guarded UPDATE that records a run's terminal
// status. These tests drive it (and the backstop's pure decision) against fakes — no real database.

interface Recorded {
	query: string
	values: unknown[]
}

/** Re-read a fixture as the caller's row type (a JSON round-trip keeps the fake honest without an `as`). */
function asRow<T>(value: unknown): T {
	const box: { v: T } = JSON.parse(JSON.stringify({ v: value }))
	return box.v
}

function emptyRows<T>(): T[] {
	const box: { v: T[] } = JSON.parse('{"v":[]}')
	return box.v
}

/** A fake `SqlDatabase`: `run()` reports a fixed `changes`; `first()` returns a fixed row (isRunFinished). */
const makeDb = (changes: number, rec: Recorded[], firstRow: unknown = null): SqlDatabase => {
	const statement = (query: string, values: unknown[]): SqlStatement => ({
		bind: (...next: unknown[]) => statement(query, next),
		run: () => {
			rec.push({ query, values })
			return Promise.resolve({ meta: { changes } })
		},
		first: <T>() => Promise.resolve(firstRow === null ? null : asRow<T>(firstRow)),
		all: <T>() => Promise.resolve({ results: emptyRows<T>() }),
	})
	return {
		prepare: (query: string) => statement(query, []),
		batch: () => Promise.reject(new Error('batch() is not used by finish-run')),
	}
}

/** Fixed clock (unix SECONDS) — `finished_at` is stamped caller-side, so pin it to assert the bind. */
const NOW = 1_700_000_000
const clock = (): number => NOW

describe('finishRun', () => {
	test('writes the terminal status guarded on pending|running and reports the transition', async () => {
		const rec: Recorded[] = []
		const did = await finishRun(makeDb(1, rec), 'run-1', 'succeeded', 0, clock)

		expect(did).toBe(true)
		expect(rec).toHaveLength(1)
		// The guard makes a double-write (control plane + vozka-runner) idempotent.
		expect(rec[0]?.query).toContain("status IN ('pending','running')")
		expect(rec[0]?.query).toContain('cancel_requested_at IS NULL')
		// `unixepoch()` is SQLite-only; the timestamp is bound, so the statement stays portable.
		expect(rec[0]?.query).not.toContain('unixepoch')
		expect(rec[0]?.query).toContain('finished_at = ?')
		// Bound in order: status, exit code, finished_at, run id — the SAME order as Db.markRunFinished.
		expect(rec[0]?.values).toEqual(['succeeded', 0, NOW, 'run-1'])
	})

	test('a no-op (already terminal — the control plane beat us to it) reports false, never throws', async () => {
		const did = await finishRun(makeDb(0, []), 'run-1', 'failed', 1, clock)
		expect(did).toBe(false)
	})

	test('a failed run with no exit code binds null', async () => {
		const rec: Recorded[] = []
		await finishRun(makeDb(1, rec), 'run-2', 'failed', null, clock)
		expect(rec[0]?.values).toEqual(['failed', null, NOW, 'run-2'])
	})

	test('defaults to the real clock in whole unix seconds when no clock is injected', async () => {
		const rec: Recorded[] = []
		const before = Math.floor(Date.now() / 1000)
		await finishRun(makeDb(1, rec), 'run-3', 'succeeded', 0)

		const stamped = rec[0]?.values[2]
		if (typeof stamped !== 'number') {
			throw new Error('expected a numeric finished_at bind')
		}
		// Seconds, not milliseconds — the column's unit (a `Date.now()` default would be ~1000× off).
		expect(Number.isInteger(stamped)).toBe(true)
		expect(stamped).toBeGreaterThanOrEqual(before)
		expect(stamped).toBeLessThan(before + 60)
	})
})

describe('isRunFinished', () => {
	test('true when a terminal row exists, false when none', async () => {
		expect(await isRunFinished(makeDb(0, [], { status: 'succeeded' }), 'run-1')).toBe(true)
		expect(await isRunFinished(makeDb(0, [], null), 'run-1')).toBe(false)
	})
})

describe('backstopDecision', () => {
	const status = (state: RunnerStatus['state'], exitCode?: number): RunnerStatus => ({
		runId: 'r',
		state,
		startedAt: 1,
		...(exitCode !== undefined ? { exitCode } : {}),
	})

	test('already finished → noop (the relay/control-plane recorded it)', () => {
		expect(backstopDecision({ alreadyFinished: true, status: status('deploying'), expired: false })).toEqual({ kind: 'noop' })
	})

	test('container terminal → finish with its state + exit code', () => {
		expect(backstopDecision({ alreadyFinished: false, status: status('succeeded', 0), expired: false })).toEqual({
			kind: 'finish',
			state: 'succeeded',
			exitCode: 0,
		})
		expect(backstopDecision({ alreadyFinished: false, status: status('failed', 1), expired: false })).toEqual({
			kind: 'finish',
			state: 'failed',
			exitCode: 1,
		})
	})

	test('still in flight before the deadline → reschedule', () => {
		expect(backstopDecision({ alreadyFinished: false, status: status('deploying'), expired: false })).toEqual({ kind: 'reschedule' })
	})

	test('unreachable container before the deadline → reschedule (transient)', () => {
		expect(backstopDecision({ alreadyFinished: false, status: null, expired: false })).toEqual({ kind: 'reschedule' })
	})

	test('past the deadline (in flight OR unreachable) → record failed rather than dangle forever', () => {
		expect(backstopDecision({ alreadyFinished: false, status: status('deploying'), expired: true })).toEqual({
			kind: 'finish',
			state: 'failed',
			exitCode: null,
		})
		expect(backstopDecision({ alreadyFinished: false, status: null, expired: true })).toEqual({ kind: 'finish', state: 'failed', exitCode: null })
	})
})
