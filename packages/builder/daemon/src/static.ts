import type { Route } from '@fabrika/daemon-kit'
import { dirname, join } from 'path'

const MIME_TYPES: Record<string, string> = {
	js: 'application/javascript',
	mjs: 'application/javascript',
	css: 'text/css',
	html: 'text/html',
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	ico: 'image/x-icon',
	woff: 'font/woff',
	woff2: 'font/woff2',
	json: 'application/json',
	map: 'application/json',
}

function resolveDistDir(): string {
	const override = process.env['FABRIKA_UI_DIST']
	if (override) return override
	return join(dirname(import.meta.dir), '..', 'ui', 'dist')
}

function mimeFor(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase() ?? ''
	return MIME_TYPES[ext] ?? 'application/octet-stream'
}

export function createStaticHandlers(): Route[] {
	const distDir = resolveDistDir()

	async function serveSpaIndex(): Promise<Response> {
		const file = Bun.file(join(distDir, 'index.html'))
		if (await file.exists()) {
			return new Response(file, {
				headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' },
			})
		}
		return new Response(
			'Builder dashboard not found. Reinstall @fabrika/builder or run its build script.',
			{ status: 503, headers: { 'Content-Type': 'text/plain' } },
		)
	}

	async function serveAsset(_req: Request, url: URL): Promise<Response> {
		const rel = url.pathname.replace(/^\//, '')
		const assetPath = join(distDir, rel)
		if (!assetPath.startsWith(distDir)) {
			return new Response('Forbidden', { status: 403 })
		}
		const file = Bun.file(assetPath)
		if (!(await file.exists())) return new Response('Not found', { status: 404 })
		const basename = assetPath.slice(assetPath.lastIndexOf('/') + 1)
		const isHashed = /\.[a-z0-9]{8,}\.[a-z0-9]+$/i.test(basename)
		return new Response(file, {
			headers: {
				'Content-Type': mimeFor(url.pathname),
				'Cache-Control': isHashed
					? 'public, max-age=31536000, immutable'
					: 'no-cache',
			},
		})
	}

	return [
		{ method: 'GET', pattern: new URLPattern({ pathname: '/s/:id' }), handler: serveSpaIndex },
		{ method: 'GET', pattern: new URLPattern({ pathname: '/assets/*' }), handler: serveAsset },
	]
}
