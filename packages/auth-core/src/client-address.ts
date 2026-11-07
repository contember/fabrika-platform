// The client a per-client abuse bucket counts, derived from the address an ingress wrote. IAM and the application
// runtime both key on it, so one client is one bucket on either side.

/** Longest header value read; an IPv6 address with a zone id fits with room to spare. */
const MAX_ADDRESS_LENGTH = 64

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const HEXTET = /^[0-9a-f]{1,4}$/

/**
 * The eight groups of an IPv6 address, or `null`. An embedded IPv4 tail (`::ffff:192.0.2.1`) counts as two groups,
 * and a zone id (`%eth0`) is dropped.
 */
function ipv6Groups(text: string): number[] | null {
	const address = text.split('%')[0] ?? ''
	const halves = address.split('::')
	if (halves.length > 2) {
		return null
	}
	const groupsOf = (half: string): number[] | null => {
		if (half === '') {
			return []
		}
		const groups: number[] = []
		const parts = half.split(':')
		for (const [index, part] of parts.entries()) {
			if (index === parts.length - 1 && IPV4.test(part)) {
				const [a = 0, b = 0, c = 0, d = 0] = part.split('.').map(Number)
				groups.push(a * 256 + b, c * 256 + d)
			} else if (HEXTET.test(part)) {
				groups.push(Number.parseInt(part, 16))
			} else {
				return null
			}
		}
		return groups
	}
	const head = groupsOf(halves[0] ?? '')
	const tail = halves.length === 2 ? groupsOf(halves[1] ?? '') : []
	if (head === null || tail === null) {
		return null
	}
	if (halves.length === 1) {
		return head.length === 8 ? head : null
	}
	const missing = 8 - head.length - tail.length
	return missing < 1 ? null : [...head, ...Array.from({ length: missing }, () => 0), ...tail]
}

/**
 * The client a client-address header value counts as: an IPv4 address, or an IPv6 address's /64 (one subscriber's
 * prefix, of which it may hold every address); an IPv4-mapped IPv6 address counts as its IPv4 address. Only the first
 * value counts, so a caller that appends a second copy cannot change the key. `null` when the value is absent or no
 * IP address.
 */
export function clientAddressKey(header: string | null): string | null {
	const value = (header ?? '').split(',')[0]?.trim().toLowerCase() ?? ''
	if (value === '' || value.length > MAX_ADDRESS_LENGTH) {
		return null
	}
	if (IPV4.test(value)) {
		return value
	}
	const groups = ipv6Groups(value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value)
	if (groups === null) {
		return null
	}
	const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
	if (mapped) {
		const [high = 0, low = 0] = groups.slice(6)
		return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
	}
	return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`
}
