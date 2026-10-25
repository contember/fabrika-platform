// `egress: 'public'`: a cron job that calls the websites its operators name (a crawler, an auditor, a link checker)
// reaches any public host over HTTPS or HTTP, and never the installation or a private network (ADR-0070). These are the
// rules a URL alone decides, which the runtime guard and the checker share. The guard adds the installation's own hosts
// and, where the runtime exposes name resolution, the addresses a name resolves to.

/** The declared form of public egress: every public host, over HTTPS or HTTP, on its default port. */
export const PUBLIC_EGRESS = 'public'

export type PublicEgress = typeof PUBLIC_EGRESS

/** What a site declares in `egress`: its exact HTTPS origins, sorted, or every public host (a cron job only). */
export type DeclaredEgress = readonly string[] | PublicEgress

/**
 * The name suffixes public egress refuses, each with every name under it: local and special-use names (RFC 6761,
 * RFC 6762, RFC 8375, RFC 9476), the names private networks conventionally use (`.internal` holds Google's metadata
 * host and Control's own `operations.internal`), and the platform subdomains an installation is served on beside its
 * own domains: Cloudflare's `workers.dev`, where its Workers have their default routes, and Zerops' `zerops.app`, where
 * its proxies, Control and IAM have their subdomains (a namespace proxy's `proxy-…-8080.<region>.zerops.app`), with the
 * `zerops` suffix of a Zerops project's private network. Control knows no list of those subdomains, so every one is
 * refused, another installation's too.
 */
export const PUBLIC_EGRESS_REFUSED_SUFFIXES = [
	'localhost',
	'local',
	'internal',
	'intranet',
	'lan',
	'home',
	'corp',
	'private',
	'arpa',
	'test',
	'invalid',
	'example',
	'onion',
	'alt',
	'zerops',
	'zerops.app',
	'workers.dev',
] as const

/** A host name without its trailing dots, lowercased: the form every comparison here uses. */
export function normalizedHost(hostname: string): string {
	return hostname.toLowerCase().replace(/\.+$/, '')
}

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/**
 * Why public egress refuses `url`, or `null` when the URL alone admits it: a scheme other than `https:` and `http:`, a
 * port other than the scheme's default, an IP literal, a name of one label, a name under a refused suffix, or one of
 * `refusedHosts` (normalized names). A host it admits may still resolve to a private address, which only a runtime that
 * resolves names refuses.
 */
export function publicEgressRefusal(url: URL, refusedHosts: ReadonlySet<string> = new Set()): string | null {
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return `${url.protocol} is not https: or http:`
	if (url.port !== '') return `port ${url.port} is not the default port of ${url.protocol}`
	const host = normalizedHost(url.hostname)
	if (host.startsWith('[') || IPV4.test(host)) return `${host} is an IP address, not a public host name`
	if (!host.includes('.')) return `${host} is a name of one label, as an internal service or a local machine has`
	if (host.split('.').some((label) => label === '')) return `${host} has an empty label`
	const suffix = PUBLIC_EGRESS_REFUSED_SUFFIXES.find((refused) => host === refused || host.endsWith(`.${refused}`))
	if (suffix !== undefined) return `${host} is under .${suffix}, which names no public website`
	if (refusedHosts.has(host)) return `${host} is a host of this installation`
	return null
}

/**
 * Whether `address` (an IPv4 or IPv6 address, as a resolver answers it) is a public unicast address: not private,
 * loopback, link-local (which holds the cloud metadata address 169.254.169.254), shared, multicast, reserved,
 * documentation, or an IPv6 form that embeds or tunnels an IPv4 address it cannot vouch for. A text that is no address
 * is not public.
 */
export function isPublicAddress(address: string): boolean {
	const v4 = ipv4Octets(address)
	if (v4 !== null) return isPublicIpv4(v4)
	const words = ipv6Words(address)
	if (words === null) return false
	const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = words
	// ::ffff:a.b.c.d, an IPv4 address in IPv6 form, is that IPv4 address.
	if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
		return isPublicIpv4([w6 >> 8, w6 & 0xff, w7 >> 8, w7 & 0xff])
	}
	// Only global unicast (2000::/3) is public; every other block is local, multicast, reserved or a translation prefix.
	if ((w0 & 0xe000) !== 0x2000) return false
	// 2001::/32 Teredo, 2001:10::/28 ORCHID, 2001:20::/28 ORCHIDv2, 2001:db8::/32 documentation, 2002::/16 6to4.
	if (w0 === 0x2001 && (w1 === 0 || (w1 & 0xfff0) === 0x10 || (w1 & 0xfff0) === 0x20 || w1 === 0x0db8)) return false
	if (w0 === 0x2002) return false
	// 3fff::/20 documentation (RFC 9637).
	if (w0 === 0x3fff && (w1 & 0xf000) === 0) return false
	return true
}

/** The non-public IPv4 blocks, each as its network (a 32-bit number) and its prefix length. */
const IPV4_REFUSED: readonly (readonly [number, number])[] = [
	[0x00000000, 8], // 0.0.0.0/8 this network
	[0x0a000000, 8], // 10.0.0.0/8 private
	[0x64400000, 10], // 100.64.0.0/10 shared address space
	[0x7f000000, 8], // 127.0.0.0/8 loopback
	[0xa9fe0000, 16], // 169.254.0.0/16 link-local, the cloud metadata address
	[0xac100000, 12], // 172.16.0.0/12 private
	[0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
	[0xc0000200, 24], // 192.0.2.0/24 documentation
	[0xc0586300, 24], // 192.88.99.0/24 6to4 relay anycast
	[0xc0a80000, 16], // 192.168.0.0/16 private
	[0xc6120000, 15], // 198.18.0.0/15 benchmarking
	[0xc6336400, 24], // 198.51.100.0/24 documentation
	[0xcb007100, 24], // 203.0.113.0/24 documentation
	[0xe0000000, 4], // 224.0.0.0/4 multicast
	[0xf0000000, 4], // 240.0.0.0/4 reserved, broadcast
]

function isPublicIpv4(octets: readonly number[]): boolean {
	const [a = 0, b = 0, c = 0, d = 0] = octets
	const value = ((a << 24) >>> 0) + (b << 16) + (c << 8) + d
	return !IPV4_REFUSED.some(([network, prefix]) => {
		const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
		return ((value & mask) >>> 0) === network
	})
}

function ipv4Octets(text: string): number[] | null {
	if (!IPV4.test(text)) return null
	const octets = text.split('.').map((part) => Number.parseInt(part, 10))
	return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null
}

const HEX_WORD = /^[0-9a-f]{1,4}$/i

/** The eight 16-bit words of an IPv6 address (brackets and a zone allowed, an embedded IPv4 tail too), or `null`. */
function ipv6Words(text: string): number[] | null {
	let rest = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
	const zone = rest.indexOf('%')
	if (zone !== -1) rest = rest.slice(0, zone)
	if (!rest.includes(':')) return null
	const tailAt = rest.lastIndexOf(':')
	const tail = ipv4Octets(rest.slice(tailAt + 1))
	const embedded: number[] = []
	if (tail !== null) {
		const [a = 0, b = 0, c = 0, d = 0] = tail
		embedded.push((a << 8) | b, (c << 8) | d)
		rest = rest.slice(0, tailAt + 1) + '0'
	}
	const halves = rest.split('::')
	if (halves.length > 2) return null
	const parse = (half: string | undefined): number[] | null => {
		if (half === undefined || half === '') return []
		const parts = half.split(':')
		if (!parts.every((part) => HEX_WORD.test(part))) return null
		return parts.map((part) => Number.parseInt(part, 16))
	}
	const head = parse(halves[0])
	const back = parse(halves[1])
	if (head === null || back === null) return null
	if (tail !== null) {
		// The placeholder word stands for the two words of the IPv4 tail.
		const last = halves.length === 2 ? back : head
		last.pop()
		last.push(...embedded)
	}
	const missing = 8 - head.length - back.length
	if (halves.length === 1) return missing === 0 ? head : null
	if (missing < 1) return null
	return [...head, ...Array.from({ length: missing }, () => 0), ...back]
}
