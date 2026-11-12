import type { Route } from '@fabrika/daemon-kit'
import { createHash } from 'crypto'
import { dirname, join } from 'path'
import { DATA_DIR } from '../paths'

const MIME_TYPES: Record<string, string> = {
	js: 'application/javascript',
	css: 'text/css',
	html: 'text/html',
	svg: 'image/svg+xml',
	png: 'image/png',
}

let cachedDistDir: string | null = null
async function getDistDir(): Promise<string> {
	if (cachedDistDir) return cachedDistDir
	// import.meta.dir = daemon/src/handlers/, go up two levels to daemon/
	const localDist = join(dirname(import.meta.dir), '..', 'dist')
	if (await Bun.file(join(localDist, 'index.html')).exists()) {
		cachedDistDir = localDist
	} else {
		cachedDistDir = join(DATA_DIR, 'daemon')
	}
	return cachedDistDir
}

/**
 * The canvas page's Content-Security-Policy, derived from the page itself: scripts only from the daemon, the page's own
 * inline scripts by hash and the external scripts it names by exact URL. Canvas JavaScript runs in this page, so
 * `connect-src 'self'` is what keeps it from sending data off the machine. Images, fonts and stylesheets may come from
 * any https origin; such a URL can still carry data out, which is accepted.
 */
export function sessionPageCsp(html: string): string {
	const scripts = ["'self'"]
	for (const [, attributes = '', body = ''] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
		const src = attributes.match(/\bsrc="([^"]+)"/)?.[1]
		if (src === undefined) scripts.push(`'sha256-${createHash('sha256').update(body).digest('base64')}'`)
		else if (src.startsWith('https://')) scripts.push(src)
	}
	return [
		"default-src 'self'",
		`script-src ${scripts.join(' ')}`,
		"style-src 'self' 'unsafe-inline' https:",
		"img-src 'self' data: blob: https:",
		"font-src 'self' data: https:",
		"connect-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].join('; ')
}

async function serveSessionPage(): Promise<Response> {
	const distDir = await getDistDir()
	const file = Bun.file(join(distDir, 'index.html'))
	if (await file.exists()) {
		// Read on every request: a watch rebuild rewrites the page and its inline scripts.
		const html = await file.text()
		return new Response(html, { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': sessionPageCsp(html) } })
	}
	return new Response('Build not found. Run: bun run daemon/build.ts', { status: 500 })
}

async function serveStaticAsset(_req: Request, url: URL): Promise<Response> {
	const path = url.pathname
	const distDir = await getDistDir()
	const assetPath = join(distDir, path.replace('/assets/', ''))
	const file = Bun.file(assetPath)
	if (!(await file.exists())) return new Response('Not found', { status: 404 })

	const ext = path.split('.').pop() || ''
	return new Response(file, {
		// A rebuild keeps the file names, and pages that load the review widget would otherwise keep a stale copy.
		headers: { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' },
	})
}

export function createStaticHandlers(): Route[] {
	return [
		{
			method: 'GET',
			pattern: new URLPattern({ pathname: '/s/:id' }),
			handler: serveSessionPage,
		},
		{
			method: 'GET',
			pattern: new URLPattern({ pathname: '/assets/*' }),
			handler: serveStaticAsset,
		},
	]
}
