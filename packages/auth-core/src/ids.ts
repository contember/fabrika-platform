/**
 * Generate a UUIDv7 (RFC 9562): time-sortable, 128 bits, monotonic WITHIN a millisecond as well as
 * across one — `audit_events` is listed `ORDER BY id DESC` with an `id < ?` keyset cursor, and a
 * request that writes two audit rows writes them inside the same millisecond routinely.
 *
 * Layout, with §6.2's "fixed bit-length dedicated counter" monotonic variant:
 *   - bytes 0..5  : 48-bit big-endian Unix-millis timestamp
 *   - byte  6     : version nibble `7` in the high 4 bits, the high 4 bits of a 12-bit counter below
 *   - byte  7     : the low 8 bits of that counter (bytes 6..7 low bits are `rand_a`)
 *   - byte  8     : RFC 4122 variant bits `10` in the high 2 bits, random in the low 6
 *   - bytes 9..15 : random (`crypto.getRandomValues`)
 *
 * That leaves **62 random bits per id** — down from the 74 of the unguarded Method 0 this used to be
 * — plus 8 fresh random bits seeding the counter at each new millisecond.
 *
 * The counter is re-seeded from 8 random bits (the top 4 left zero, the RFC's rollover guard, so at
 * least 3840 ids per millisecond are guaranteed) whenever the millisecond advances, and incremented
 * otherwise. Because the timestamp occupies the most-significant bytes and the counter the bytes
 * right after it, ids sort lexicographically in mint order — strictly, not just at millisecond
 * granularity.
 *
 * Two clock hazards are handled explicitly rather than by wrapping:
 *   - counter exhausted inside one millisecond → borrow one millisecond from the future (RFC 9562
 *     §6.2) and re-seed; the borrowed time is repaid as soon as the wall clock catches up.
 *   - clock jumps BACKWARDS → keep the last effective millisecond and keep counting, so the sequence
 *     never repeats and never decreases.
 *
 * The counter is per GENERATOR — one process, one Worker isolate. Two ids minted in the same
 * millisecond by two isolates tie only if their independently seeded counters collide (~1/256), and
 * the 62 random bits break that; within one isolate the order is exact. That is the whole promise:
 * strictly increasing per generator, chronological to the millisecond across generators.
 *
 * No dependency, by design — `@fabrika/control` and `@fabrika/platform-node` carry deliberate copies
 * of this same algorithm because neither may depend on this package (see the note in each).
 */

/** `rand_a` is 12 bits, all of it counter. */
const COUNTER_MAX = 0xfff
/** Seed from 8 random bits only — the leading 4 stay zero so a millisecond has room to count. */
const COUNTER_SEED_MASK = 0xff

/** Effective millisecond of the last id. NEVER decreases; a backwards clock is absorbed here. */
let lastMillis = -1
let counter = 0

export function uuidv7(): string {
	const bytes = new Uint8Array(16)

	// Fill bytes 6..15 with randomness; the timestamp, version, variant and counter overwrite the
	// fields they own below.
	const random = new Uint8Array(10)
	crypto.getRandomValues(random)
	bytes.set(random, 6)

	// Byte 7 is read as the counter seed BEFORE the counter overwrites it, so the seed costs no extra
	// randomness.
	const seed = bytes[7]! & COUNTER_SEED_MASK
	const millis = Date.now()
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

	// 48-bit big-endian Unix-millis timestamp in the first 6 bytes. It fits in 48 bits (well under
	// 2^53), so the high bits are zero.
	bytes[0] = Math.floor(lastMillis / 0x10000000000) & 0xff
	bytes[1] = Math.floor(lastMillis / 0x100000000) & 0xff
	bytes[2] = Math.floor(lastMillis / 0x1000000) & 0xff
	bytes[3] = Math.floor(lastMillis / 0x10000) & 0xff
	bytes[4] = Math.floor(lastMillis / 0x100) & 0xff
	bytes[5] = lastMillis & 0xff

	// Version: high nibble of byte 6 = 0b0111 (7); the counter takes the 12 bits of `rand_a` below it.
	bytes[6] = 0x70 | (counter >>> 8)
	bytes[7] = counter & 0xff
	// Variant: high two bits of byte 8 = 0b10.
	bytes[8] = (bytes[8]! & 0x3f) | 0x80

	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))

	return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${
		hex[14]
	}${hex[15]}`
}
