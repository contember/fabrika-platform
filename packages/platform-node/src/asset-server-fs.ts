// `AssetServer` over a built SPA directory — the replacement for Cloudflare's `ASSETS` binding.
//
// Three things it has to get right, and they are the three things a hand-rolled static handler
// usually gets wrong:
//   * PATH SAFETY. The request path is attacker-controlled. It is percent-decoded, resolved against
//     the root, and then the RESOLVED path is checked to still be inside the root — so `..`, encoded
//     `%2e%2e` and absolute paths all land outside the root and are refused.
//   * CONTENT TYPES. Taken from `Bun.file(...).type`, which maps the extension (and appends a charset
//     for text types). A wrong `content-type` on `.js` or `.css` breaks a SPA outright in a browser.
//   * SPA FALLBACK. A client-routed path like `/apps/foo` has no file behind it and must serve
//     `index.html` with 200, not 404 — but a MISSING ASSET must still 404, or a typo'd bundle URL
//     silently returns HTML and the browser reports a syntax error instead of a missing file. The
//     discriminator is "does this look like a document request": an explicit `text/html` in `Accept`
//     (every browser navigation) or an extension-less path (curl, deep links). A request for
//     `/assets/main-abc123.js` has an extension and does not accept HTML, so it 404s.

import type { AssetServer } from '@fabrika/platform'
import { join, resolve, sep } from 'node:path'

export interface FileSystemAssetServerOptions {
	/** File served for a directory and for the SPA fallback. */
	indexFile?: string
	/** Serve `indexFile` (200) for an unmatched document request. Off = everything unmatched 404s. */
	spaFallback?: boolean
}

const DEFAULT_INDEX = 'index.html'
/** A trailing `.ext` on the last path segment — the "this is an asset, not a route" signal. */
const HAS_EXTENSION = /\.[^./]+$/

export class FileSystemAssetServer implements AssetServer {
	private readonly root: string
	private readonly indexFile: string
	private readonly spaFallback: boolean

	constructor(root: string, options: FileSystemAssetServerOptions = {}) {
		this.root = resolve(root)
		this.indexFile = options.indexFile ?? DEFAULT_INDEX
		this.spaFallback = options.spaFallback ?? true
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
		}

		const pathname = decodePathname(new URL(request.url).pathname)
		if (pathname === null) {
			return new Response('bad request', { status: 400 })
		}

		const file = await this.locate(pathname)
		if (file !== null) {
			return serve(file, request.method)
		}

		// Unmatched. A navigation gets the SPA shell; a missing asset gets an honest 404.
		if (this.spaFallback && looksLikeDocument(request, pathname)) {
			const fallback = await this.locate(`/${this.indexFile}`)
			if (fallback !== null) {
				return serve(fallback, request.method)
			}
		}
		return new Response('not found', { status: 404 })
	}

	/** The file backing `pathname`, or null when there is none inside the root. */
	private async locate(pathname: string): Promise<Bun.BunFile | null> {
		const candidate = resolve(this.root, `.${pathname}`)
		if (candidate !== this.root && !candidate.startsWith(this.root + sep)) {
			return null
		}
		const direct = Bun.file(candidate)
		if (await direct.exists()) {
			return direct
		}
		// A directory is not a `BunFile` that exists, so this also covers `/` and `/sub/`.
		const index = Bun.file(join(candidate, this.indexFile))
		return await index.exists() ? index : null
	}
}

function serve(file: Bun.BunFile, method: string): Response {
	const headers = new Headers({
		'content-type': file.type === '' ? 'application/octet-stream' : file.type,
		'content-length': String(file.size),
	})
	// HEAD must carry the same headers as the GET it stands for, but no body. A `BunFile` body streams.
	return method === 'HEAD' ? new Response(null, { status: 200, headers }) : new Response(file, { status: 200, headers })
}

/** Percent-decode a request path. Null when it is malformed or smuggles a NUL. */
function decodePathname(pathname: string): string | null {
	let decoded: string
	try {
		decoded = decodeURIComponent(pathname)
	} catch {
		return null
	}
	if (decoded.includes('\0')) {
		return null
	}
	return decoded.startsWith('/') ? decoded : `/${decoded}`
}

/** Whether this reads as a request for a page rather than for a build artifact. */
function looksLikeDocument(request: Request, pathname: string): boolean {
	if (request.headers.get('accept')?.includes('text/html') === true) {
		return true
	}
	const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1)
	return !HAS_EXTENSION.test(lastSegment)
}
