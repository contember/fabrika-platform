// Whether a request names a source map. An SPA mount never serves one: the build sends its sources to Operations. The
// decision reads the path the way the asset servers resolve it, not the way it was spelled: each segment decoded, empty
// segments dropped, and any case, because a case-insensitive filesystem opens `x.js.MAP` as `x.js.map`.

/** The last non-empty segment of `pathname`, decoded, names a `.map` file; an undecodable one is refused too. */
export function namesSourceMap(pathname: string): boolean {
	const last = pathname.split('/').filter((segment) => segment !== '').at(-1)
	if (last === undefined) return false
	let decoded: string
	try {
		decoded = decodeURIComponent(last)
	} catch {
		return true
	}
	return isSourceMapName(decoded)
}

/** A file name, already decoded, that is a source map in any case. */
export function isSourceMapName(name: string): boolean {
	return name.toLowerCase().endsWith('.map')
}
