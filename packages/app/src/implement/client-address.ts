// The client a per-client bucket counts. The buckets live in the application's database (`@fabrika/db`'s
// `Admissions`), so every instance shares them. Admission is not authorization: it only bounds how much one client
// calls a public procedure.

import { CLIENT_ADDRESS_HEADER } from '@fabrika/auth-core'
import { createHash } from 'node:crypto'

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
 * The client a per-client limit counts: an IPv4 address, or an IPv6 address's /64 (one subscriber's prefix, of which
 * it may hold every address). Anything else, the header's absence included, is one shared `unknown` client.
 */
export function clientKey(header: string | null): string {
	const value = (header ?? '').split(',')[0]?.trim().toLowerCase() ?? ''
	if (value === '' || value.length > MAX_ADDRESS_LENGTH) {
		return 'unknown'
	}
	if (IPV4.test(value)) {
		return value
	}
	const groups = ipv6Groups(value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value)
	if (groups === null) {
		return 'unknown'
	}
	const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
	if (mapped) {
		const [high = 0, low = 0] = groups.slice(6)
		return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
	}
	return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`
}

/**
 * The bucket of the client the proxy saw. Only `X-Fabrika-Client-Ip` is read: the proxy deletes it and sets it from
 * the connection on every request, and the proxy secret proves the request came through it. A forwarding header a
 * client can write (`X-Forwarded-For`, `CF-Connecting-IP`) is never read. The address is kept as its digest.
 */
export function clientBucket(request: Request): string {
	return `client:${createHash('sha256').update(clientKey(request.headers.get(CLIENT_ADDRESS_HEADER))).digest('hex')}`
}
