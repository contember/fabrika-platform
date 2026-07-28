// `runs.id` IS the ordering and the keyset cursor — `listRuns` is `ORDER BY id DESC` with an
// `id < ?` cursor, on a TEXT comparison. Two runs for one app-env inside one millisecond are
// unlikely but entirely possible (a webhook racing a manual trigger, a retry), and a random tie
// there mis-orders history and lets the cursor skip or repeat a row. So what these tests pin is
// STRICT string order, including the RFC 9562 §6.2 counter's overflow and backwards-clock branches.

import { describe, expect, spyOn, test } from 'bun:test'
import { uuidv7 } from '../uuid'

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The 48-bit timestamp an id carries. */
function timestampOf(id: string): number {
	return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
}

/** Index of the first id not strictly greater than its predecessor, or -1. String order is the test. */
function firstNonAscending(ids: readonly string[]): number {
	for (let i = 1; i < ids.length; i++) {
		if (!(ids[i] > ids[i - 1])) {
			return i
		}
	}
	return -1
}

/** Run `body` with `Date.now()` reading from `now`. The generator has no clock seam of its own. */
function withStubbedClock<T>(now: () => number, body: () => T): T {
	const spy = spyOn(Date, 'now').mockImplementation(now)
	try {
		return body()
	} finally {
		spy.mockRestore()
	}
}

/** A millisecond the generator has not used yet, so a stubbed clock is not clamped away. */
function freshMillis(): number {
	return timestampOf(uuidv7()) + 1
}

describe('uuidv7', () => {
	test('is a well-formed version 7, variant 10xx UUID', () => {
		for (let i = 0; i < 100; i++) {
			expect(uuidv7()).toMatch(UUID_V7_RE)
		}
	})

	test('encodes the wall clock in the leading 48 bits', () => {
		const millis = freshMillis()
		const id = withStubbedClock(() => millis, () => uuidv7())
		expect(timestampOf(id)).toBe(millis)
	})

	test('ids minted in a tight loop are strictly increasing as strings', () => {
		const ids = Array.from({ length: 10_000 }, () => uuidv7())
		expect(firstNonAscending(ids)).toBe(-1)
		expect(new Set(ids).size).toBe(ids.length)
	})

	test('stays ordered across a millisecond boundary', () => {
		const ids: string[] = []
		for (let batch = 0; batch < 4; batch++) {
			// Spin until the wall clock is past the millisecond the generator last used.
			const target = timestampOf(uuidv7())
			while (Date.now() <= target) {
				// spin
			}
			for (let i = 0; i < 50; i++) {
				ids.push(uuidv7())
			}
		}
		expect(firstNonAscending(ids)).toBe(-1)
		expect(new Set(ids.map(timestampOf)).size).toBeGreaterThanOrEqual(4)
	})

	test('a clock that jumps backwards neither repeats an id nor reverses the order', () => {
		const base = freshMillis()
		let now = base
		const ids = withStubbedClock(() => now, () => {
			return [0, 0, -60_000, -3_600_000, 0, 5].map((offset) => {
				now = base + offset
				return uuidv7()
			})
		})
		expect(firstNonAscending(ids)).toBe(-1)
		expect(new Set(ids).size).toBe(ids.length)
		// The backwards jumps never reached the wire — the embedded timestamp only holds or advances.
		expect(ids.map(timestampOf)).toEqual([base, base, base, base, base, base + 5])
	})

	test('exhausting the 12-bit counter borrows a millisecond instead of wrapping', () => {
		const millis = freshMillis()
		// More than 4096 (the counter's width) in ONE millisecond, so the overflow branch has to run.
		const ids = withStubbedClock(() => millis, () => Array.from({ length: 5_000 }, () => uuidv7()))
		expect(firstNonAscending(ids)).toBe(-1)
		expect(new Set(ids).size).toBe(ids.length)
		expect(timestampOf(ids[0])).toBe(millis)
		// Borrowed from the future rather than restarting the counter underneath the last id.
		expect(timestampOf(ids[ids.length - 1])).toBeGreaterThan(millis)
		expect(ids.every((id) => UUID_V7_RE.test(id))).toBe(true)
	})
})
