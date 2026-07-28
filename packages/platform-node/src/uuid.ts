/**
 * UUIDv7 generator — time-ordered ids, so a jobs table orders by id chronologically and a keyset
 * cursor works, monotonic WITHIN a millisecond as well as across one. Ids are minted CALLER-SIDE,
 * never by SQL (the repo-wide convention, and the one thing that keeps inserts identical across
 * SQLite and Postgres). Self-contained so this package has no dependencies beyond the port it
 * implements.
 *
 * RFC 9562 layout, with §6.2's "fixed bit-length dedicated counter" monotonic variant:
 *
 *   bytes 0..5   48-bit big-endian Unix-millis timestamp
 *   byte  6      version nibble `7` + the high 4 bits of a 12-bit counter (`rand_a`)
 *   byte  7      the low 8 bits of that counter
 *   byte  8      variant bits `10` + 6 random bits
 *   bytes 9..15  56 random bits
 *
 * so **62 random bits per id** — down from the 74 of the unguarded Method 0 this used to be — plus 8
 * fresh random bits seeding the counter at each new millisecond.
 *
 * The counter is re-seeded from 8 random bits (the top 4 left zero, the RFC's rollover guard, so at
 * least 3840 ids per millisecond are guaranteed) whenever the millisecond advances, and incremented
 * otherwise. `rand_a` sits immediately after the timestamp and the version nibble in the canonical
 * string, so two ids minted in the same millisecond differ there and a TEXT `ORDER BY` puts them in
 * mint order, strictly.
 *
 * Two clock hazards are handled explicitly rather than by wrapping:
 *   - counter exhausted inside one millisecond → borrow one millisecond from the future (RFC 9562
 *     §6.2) and re-seed; the borrowed time is repaid as soon as the clock catches up.
 *   - the timestamp goes BACKWARDS → keep the last effective millisecond and keep counting, so the
 *     sequence never repeats and never decreases.
 *
 * The counter is per GENERATOR — one process. Two ids minted in the same millisecond by two processes
 * tie only if their independently seeded counters collide (~1/256), and the 62 random bits break
 * that; within one process the order is exact. That is the whole promise: strictly increasing per
 * generator, chronological to the millisecond across generators.
 *
 * `millis` is injectable so a caller that already has a clock (the job queue does) mints ids on THAT
 * clock, keeping id order and row order consistent. Because the generator is monotonic, the timestamp
 * actually embedded is `max(millis, last embedded)`: a supplied millisecond BEHIND one already used
 * is clamped, and the counter carries the ordering instead. Ordering is the promise; an exact
 * round-trip of an arbitrary past `millis` is not.
 *
 * `@fabrika/auth-core` and `@fabrika/control` carry deliberate copies of this same algorithm — see
 * the note in each.
 */

/** `rand_a` is 12 bits, all of it counter. */
const COUNTER_MAX = 0xfff
/** Seed from 8 random bits only — the leading 4 stay zero so a millisecond has room to count. */
const COUNTER_SEED_MASK = 0xff

/** Effective millisecond of the last id. NEVER decreases; a backwards clock is absorbed here. */
let lastMillis = -1
let counter = 0

export function uuidv7(millis: number = Date.now()): string {
	const bytes = new Uint8Array(16)
	crypto.getRandomValues(bytes)

	// Byte 7 is read as the counter seed BEFORE the counter overwrites it, so the seed costs no extra
	// randomness.
	const seed = (bytes[7] ?? 0) & COUNTER_SEED_MASK
	if (millis > lastMillis) {
		lastMillis = millis
		counter = seed
	} else if (counter < COUNTER_MAX) {
		// Same millisecond, or a clock that went backwards: hold the effective timestamp, count on.
		counter += 1
	} else {
		// Exhausted — borrow a millisecond from the future rather than wrap back under the last id.
		lastMillis += 1
		counter = seed
	}

	// 48-bit big-endian timestamp in bytes 0..5.
	bytes[0] = (lastMillis / 2 ** 40) & 0xff
	bytes[1] = (lastMillis / 2 ** 32) & 0xff
	bytes[2] = (lastMillis / 2 ** 24) & 0xff
	bytes[3] = (lastMillis / 2 ** 16) & 0xff
	bytes[4] = (lastMillis / 2 ** 8) & 0xff
	bytes[5] = lastMillis & 0xff

	// Version 7 in the high nibble of byte 6, the counter in the remaining 12 bits of `rand_a`;
	// variant (10xx) in the high bits of byte 8.
	bytes[6] = 0x70 | (counter >>> 8)
	bytes[7] = counter & 0xff
	bytes[8] = (bytes[8] ?? 0) & 0x3f | 0x80

	const hex: string[] = []
	for (const b of bytes) {
		hex.push(b.toString(16).padStart(2, '0'))
	}
	const s = hex.join('')
	return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}
