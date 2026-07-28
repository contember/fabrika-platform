// Ids are load-bearing twice over: the jobs table orders a claimed batch by id, and the repo-wide
// convention is that ids are minted caller-side so an INSERT is identical on SQLite and Postgres.
// The ordering the batch sort depends on is STRICT — two `send()` calls in one millisecond are
// ordinary — so these tests pin the RFC 9562 §6.2 counter, not just the millisecond prefix.

import { describe, expect, test } from 'bun:test'
import { uuidv7 } from '../uuid'

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** The 48-bit timestamp an id carries. */
function timestampOf(id: string): number {
	return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)
}

/** Index of the first id not strictly greater than its predecessor, or -1. String order is the test. */
function firstNonAscending(ids: readonly string[]): number {
	for (let i = 1; i < ids.length; i++) {
		if (!(ids[i]! > ids[i - 1]!)) {
			return i
		}
	}
	return -1
}

/**
 * A millisecond the generator has not used yet. The generator clamps a supplied timestamp to the last
 * one it embedded, so a test that wants an exact round-trip has to ask for one that is ahead.
 */
function freshMillis(): number {
	return timestampOf(uuidv7()) + 1
}

/** Spin until the wall clock is past the millisecond the generator last used. */
function spinPastLastMinted(): void {
	const target = timestampOf(uuidv7())
	while (Date.now() <= target) {
		// spin
	}
}

describe('uuidv7', () => {
	test('is a well-formed version 7, variant 10xx UUID', () => {
		for (let i = 0; i < 100; i++) {
			expect(uuidv7()).toMatch(UUID_V7_RE)
		}
	})

	test('encodes the timestamp in the leading 48 bits', () => {
		const millis = freshMillis()
		expect(timestampOf(uuidv7(millis))).toBe(millis)
	})

	test('sorts lexicographically by the millisecond it was minted at', () => {
		const base = freshMillis()
		const ids = [0, 1, 2, 3].map((offset) => uuidv7(base + offset))
		expect(firstNonAscending(ids)).toBe(-1)
		expect(ids.map(timestampOf)).toEqual([base, base + 1, base + 2, base + 3])
	})

	test('ids minted in a tight loop are strictly increasing as strings', () => {
		const ids = Array.from({ length: 10_000 }, () => uuidv7())
		expect(firstNonAscending(ids)).toBe(-1)
		expect(new Set(ids).size).toBe(ids.length)
	})

	test('two ids from the same millisecond are distinct and strictly increasing', () => {
		const millis = freshMillis()
		const first = uuidv7(millis)
		const second = uuidv7(millis)
		expect(second).not.toBe(first)
		expect(second > first).toBe(true)
	})

	test('stays ordered across a millisecond boundary', () => {
		const ids: string[] = []
		for (let batch = 0; batch < 4; batch++) {
			spinPastLastMinted()
			for (let i = 0; i < 50; i++) {
				ids.push(uuidv7())
			}
		}
		expect(firstNonAscending(ids)).toBe(-1)
		// Each batch started in a millisecond of its own, so the prefix genuinely moved.
		expect(new Set(ids.map(timestampOf)).size).toBeGreaterThanOrEqual(4)
	})

	test('a timestamp that goes backwards neither repeats an id nor reverses the order', () => {
		const base = freshMillis()
		const ids = [base, base - 60_000, base - 3_600_000, base, base + 1].map((millis) => uuidv7(millis))
		expect(firstNonAscending(ids)).toBe(-1)
		expect(new Set(ids).size).toBe(ids.length)
		// The backwards timestamps never reached the wire — the embedded one only holds or advances.
		expect(ids.map(timestampOf)).toEqual([base, base, base, base, base + 1])
	})

	test('exhausting the 12-bit counter borrows a millisecond instead of wrapping', () => {
		const millis = freshMillis()
		// More than 4096 (the counter's width) in ONE millisecond, so the overflow branch has to run.
		const ids = Array.from({ length: 5_000 }, () => uuidv7(millis))
		expect(firstNonAscending(ids)).toBe(-1)
		expect(new Set(ids).size).toBe(ids.length)
		expect(timestampOf(ids[0]!)).toBe(millis)
		// Borrowed from the future rather than restarting the counter underneath the last id.
		expect(timestampOf(ids.at(-1)!)).toBeGreaterThan(millis)
		expect(ids.every((id) => UUID_V7_RE.test(id))).toBe(true)
	})
})
