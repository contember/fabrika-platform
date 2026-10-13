// Bound and addressed as a literal: `localhost` can bind ::1 while a client connects to 127.0.0.1.
export const BUILDER_DAEMON_HOST = '127.0.0.1'

export function builderDaemonUrl(port: number, scheme: 'http' | 'ws' = 'http'): string {
	return `${scheme}://${BUILDER_DAEMON_HOST}:${port}`
}

function parseHttpUrl(value: unknown, label: string): URL {
	if (
		typeof value !== 'string' || value.length === 0 || value.trim() !== value
		|| [...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || character === '\\')
	) {
		throw new Error(`${label} must be an HTTP(S) URL`)
	}
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error(`${label} must be an HTTP(S) URL`)
	}
	if (
		!/^https?:\/\//i.test(value) || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password
		|| /^https?:\/\/[^/?#]*@/i.test(value)
	) {
		throw new Error(`${label} must be an HTTP(S) URL without credentials`)
	}
	return url
}

export function parseBuilderOrigin(value: unknown, label = 'origin'): string {
	const url = parseHttpUrl(value, label)
	if (typeof value !== 'string' || !/^https?:\/\/[^/?#]+\/?$/i.test(value) || url.pathname !== '/' || url.search || url.hash) {
		throw new Error(`${label} must be an origin without a path, query, or fragment`)
	}
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
		|| url.hostname.endsWith('.localhost')
	// Do not let URL's legacy IPv4 normalization turn shorthand or numeric hosts into loopback exceptions.
	const authority = value.slice(value.indexOf('://') + 3).replace(/\/$/, '').toLowerCase()
	const canonicalLoopback = url.hostname !== '127.0.0.1' || /^127\.0\.0\.1(?::\d+)?$/.test(authority)
	if (url.protocol !== 'https:' && (!local || !canonicalLoopback)) {
		throw new Error(`${label} must use HTTPS except on localhost`)
	}
	return url.origin
}

export function parseBuilderPreviewUrl(value: unknown): string {
	return parseHttpUrl(value, 'preview URL').href
}
