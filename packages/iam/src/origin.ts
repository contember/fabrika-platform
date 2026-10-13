/** One canonical spelling for an HTTP origin, shared by everything in IAM that compares one. */

/**
 * A canonical origin can be written into a CSP source list as it is: a host name, an IPv4 or a bracketed IPv6
 * address, and a port. The URL parser keeps `;`, `,`, quotes and `*` in a host, and each of those would end or widen
 * the `form-action` directive the origin is written into.
 */
const CSP_SAFE_ORIGIN = /^https?:\/\/(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])(?::[0-9]+)?$/

/**
 * Canonical origin: lower-cased scheme and host, explicit port only when non-default, no path. Both
 * sides of a comparison go through here, so `https://App.example.com:443/` and
 * `https://app.example.com` are the same origin and neither side has to remember which spelling was
 * registered. Returns null for anything that is not an absolute http(s) URL, and for a host carrying
 * a character a CSP source cannot hold (`CSP_SAFE_ORIGIN`).
 */
export function normalizeOrigin(value: string): string | null {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return null
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return null
	}
	const origin = url.origin.toLowerCase()
	return CSP_SAFE_ORIGIN.test(origin) ? origin : null
}
