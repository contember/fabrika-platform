/**
 * One canonical spelling for an HTTP origin, shared by everything in IAM that compares one.
 *
 * It lives on its own so the admin-origin registry (`services.ts`) and the return-origin registry
 * (`handoff.ts`) cannot drift apart on what "the same origin" means — the two are configured by the
 * same operator and a difference between them would only ever be a trap.
 */

/**
 * Canonical origin: lower-cased scheme and host, explicit port only when non-default, no path. Both
 * sides of a comparison go through here, so `https://App.example.com:443/` and
 * `https://app.example.com` are the same origin and neither side has to remember which spelling was
 * registered. Returns null for anything that is not an absolute http(s) URL.
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
	return url.origin.toLowerCase()
}
