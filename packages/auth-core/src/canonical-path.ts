/** A request target split into its raw pathname and its query (with the leading `?`, or empty). */
export interface RequestTarget {
	readonly pathname: string
	readonly search: string
}

const ENCODED_SEPARATOR = /%2f|%5c/i
const ENCODED_DOT = /%2e/gi

/**
 * A raw pathname is canonical when it starts with `/` and has no empty segment, no `.` or `..` (also
 * encoded), no encoded `/` or `\`, no literal `\` and no malformed percent escape. Each refused form is one
 * some hop rewrites or rejects, so the gate matcher and the application would otherwise read different
 * paths. A trailing `/` is allowed and significant: every matcher compares it literally, so `/a/` and `/a`
 * are different paths.
 */
export function isCanonicalPath(pathname: string): boolean {
	if (pathname === '/') {
		return true
	}
	if (!pathname.startsWith('/') || pathname.includes('\\') || ENCODED_SEPARATOR.test(pathname)) {
		return false
	}
	const segments = pathname.slice(1).split('/')
	const last = segments.length - 1
	return segments.every((segment, index) => (segment !== '' || index === last) && !isDotSegment(segment) && isDecodable(segment))
}

/** Split an origin-form request target (`/path?query`) at its first `?`. */
export function splitRequestTarget(target: string): RequestTarget {
	const query = target.indexOf('?')
	return query === -1 ? { pathname: target, search: '' } : { pathname: target.slice(0, query), search: target.slice(query) }
}

/**
 * The path and query of an absolute URL string exactly as written, without the fragment. Read it from
 * the string because `new URL()` resolves dot segments and so hides the very paths that must be refused.
 */
export function rawRequestTarget(url: string): RequestTarget {
	const schemeEnd = url.indexOf('://')
	const afterScheme = schemeEnd === -1 ? url : url.slice(schemeEnd + 3)
	const fragment = afterScheme.indexOf('#')
	const withoutFragment = fragment === -1 ? afterScheme : afterScheme.slice(0, fragment)
	// A backslash ends the authority too: a URL parser reads it as `/`.
	const authorityEnd = withoutFragment.search(/[/\\?]/)
	if (authorityEnd === -1) {
		return { pathname: '/', search: '' }
	}
	const target = splitRequestTarget(withoutFragment.slice(authorityEnd))
	return target.pathname === '' ? { pathname: '/', search: target.search } : target
}

/**
 * The absolute URL of `path` on `origin`, or `null` when `path` is not a path of that origin: the one rule for a
 * redirect or return target that must stay on its own origin. A leading `//` or any `\` would make a browser read a
 * host from it, and a browser strips a tab or newline before parsing, so no control character is admitted.
 */
export function sameOriginTarget(origin: string, path: string): string | null {
	if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || [...path].some(isControl)) {
		return null
	}
	const target = new URL(path, origin)
	return target.origin === origin ? target.toString() : null
}

function isControl(character: string): boolean {
	const code = character.charCodeAt(0)
	return code < 0x20 || code === 0x7f
}

/** A segment one reader decodes and another refuses would route differently, so a malformed escape is refused. */
function isDecodable(segment: string): boolean {
	try {
		decodeURIComponent(segment)
		return true
	} catch {
		return false
	}
}

function isDotSegment(segment: string): boolean {
	const decoded = segment.replace(ENCODED_DOT, '.')
	return decoded === '.' || decoded === '..'
}
