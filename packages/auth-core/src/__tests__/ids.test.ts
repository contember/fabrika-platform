// `audit_events` is listed `ORDER BY id DESC` with an `id < ?` keyset cursor, and several audit rows
// per request land in the same millisecond routinely — so the ordering pinned here is STRICT string
// order, including the RFC 9562 §6.2 counter's overflow and backwards-clock branches.

import { describe, expect, spyOn, test } from 'bun:test'
import { uuidv7 } from '../ids'

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
	test('returns a valid v7 UUID in canonical lowercase form', () => {
		for (let i = 0; i < 100; i++) {
			expect(uuidv7()).toMatch(UUID_V7_RE)
		}
	})

	test('is unique across many calls', () => {
		const count = 10_000
		const ids = new Set<string>()
		for (let i = 0; i < count; i++) {
			ids.add(uuidv7())
		}
		expect(ids.size).toBe(count)
	})

	test('encodes the wall clock in the leading 48 bits', () => {
		const millis = freshMillis()
		expect(timestampOf(withStubbedClock(() => millis, () => uuidv7()))).toBe(millis)
	})

	test('is time-sortable: an id generated later sorts > one generated earlier', () => {
		const earlier = uuidv7()

		// Busy-wait until the wall clock advances at least 2ms so the timestamp prefix differs.
		const start = Date.now()
		while (Date.now() - start < 2) {
			// spin
		}

		const later = uuidv7()

		expect(later >= earlier).toBe(true)
		expect(later > earlier).toBe(true)
	})

	test('ids minted in a tight loop are strictly increasing as strings', () => {
		const ids = Array.from({ length: 10_000 }, () => uuidv7())
		expect(firstNonAscending(ids)).toBe(-1)
	})

	test('lexicographic order tracks generation time across a millisecond boundary', () => {
		const ids: string[] = []
		for (let batch = 0; batch < 5; batch++) {
			// Spin until the wall clock is past the millisecond the generator last used.
			const target = timestampOf(uuidv7())
			while (Date.now() <= target) {
				// spin
			}
			for (let i = 0; i < 20; i++) {
				ids.push(uuidv7())
			}
		}
		expect(firstNonAscending(ids)).toBe(-1)
		expect(new Set(ids.map(timestampOf)).size).toBeGreaterThanOrEqual(5)
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
		expect(timestampOf(ids[0]!)).toBe(millis)
		// Borrowed from the future rather than restarting the counter underneath the last id.
		expect(timestampOf(ids.at(-1)!)).toBeGreaterThan(millis)
		expect(ids.every((id) => UUID_V7_RE.test(id))).toBe(true)
	})
})
