import { canvasFileReferences, type SessionData, type SessionManager } from '@fabrika/canvas-kernel/server'
import { jsonResponse, type Route } from '@fabrika/daemon-kit'
import { realpathSync } from 'fs'
import { readdir } from 'fs/promises'
import { isAbsolute, relative, resolve, sep } from 'path'
import { LANG_MAP } from '../../langMap'

const IMAGE_MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	svg: 'image/svg+xml',
	webp: 'image/webp',
	ico: 'image/x-icon',
	bmp: 'image/bmp',
	avif: 'image/avif',
}

export interface FileHandlerOptions {
	/** Directories whose contents the file routes never return: the daemon's own state. */
	deniedRoots: readonly string[]
}

/** The path with symlinks resolved, or the path itself when it does not exist (reading it then fails as missing). */
function realOrSelf(path: string): string {
	try {
		return realpathSync.native(path)
	} catch {
		return path
	}
}

function isInside(path: string, root: string): boolean {
	const relativePath = relative(root, path)
	return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

type SessionPathResolver = (sessionId: string, relPath: string) => { fullPath: string } | Response

/**
 * The files outside the project root that the session's canvases name, in every revision, symlinks resolved. Revisions
 * never change once written, so the set is rebuilt only when a push adds one.
 */
function createNamedFiles(sessionManager: SessionManager): (session: SessionData) => Set<string> {
	const cache = new Map<string, { revisionCount: number; paths: Set<string> }>()
	return (session) => {
		const cached = cache.get(session.id)
		if (cached?.revisionCount === session.revisions.length) return cached.paths
		const paths = new Set<string>()
		for (const revision of session.revisions) {
			for (const { filename } of revision.canvasFiles) {
				const jsx = sessionManager.readRevisionJsx(session.id, revision.revision, filename)
				if (jsx === null) continue
				for (const reference of canvasFileReferences(jsx)) {
					const path = resolve(session.projectRoot, reference)
					paths.add(path)
					paths.add(realOrSelf(path))
				}
			}
		}
		cache.set(session.id, { revisionCount: session.revisions.length, paths })
		return paths
	}
}

/**
 * Resolves a requested path against the session's project root. A relative path stays inside the root. A path outside
 * the root is served only when one of the session's canvases names it as a file, so canvas JavaScript cannot read
 * arbitrary files. Nothing inside a denied root is served, symlinks resolved.
 */
function createSessionPathResolver(sessionManager: SessionManager, options: FileHandlerOptions): SessionPathResolver {
	const deniedRoots = [...new Set(options.deniedRoots.flatMap((root) => [resolve(root), realOrSelf(resolve(root))]))]
	const namedFiles = createNamedFiles(sessionManager)

	return (sessionId, relPath) => {
		const session = sessionManager.get(sessionId)
		if (!session) return jsonResponse({ error: 'Session not found' }, 404)

		const fullPath = resolve(session.projectRoot, relPath)
		const relativePath = relative(resolve(session.projectRoot), fullPath)
		if (!isAbsolute(relPath) && (relativePath === '..' || relativePath.startsWith(`..${sep}`))) {
			return jsonResponse({ error: 'Path traversal rejected' }, 403)
		}

		const realPath = realOrSelf(fullPath)
		if (deniedRoots.some((root) => isInside(fullPath, root) || isInside(realPath, root))) {
			return jsonResponse({ error: 'Path is not served' }, 403)
		}
		if (!isInside(fullPath, resolve(session.projectRoot)) && !namedFiles(session).has(fullPath)) {
			return jsonResponse({ error: 'Path outside the project root is not named by a canvas in this session' }, 403)
		}

		return { fullPath: realPath }
	}
}

export function createFileHandlers(sessionManager: SessionManager, options: FileHandlerOptions): Route[] {
	const resolveSessionPath = createSessionPathResolver(sessionManager, options)

	async function handleFileServe(_req: Request, url: URL): Promise<Response> {
		const sessionId = url.searchParams.get('session')
		const relPath = url.searchParams.get('path')
		if (!sessionId || !relPath) return jsonResponse({ error: 'Missing session or path' }, 400)

		const resolved = resolveSessionPath(sessionId, relPath)
		if (resolved instanceof Response) return resolved

		try {
			const file = Bun.file(resolved.fullPath)
			const stat = await file.exists()
			if (!stat) return jsonResponse({ error: 'File not found' }, 404)
			if (file.size > 1024 * 1024) return jsonResponse({ error: 'File too large' }, 413)

			const content = await file.text()
			const ext = relPath.split('.').pop() || ''
			return jsonResponse({ content, language: LANG_MAP[ext] || 'text' })
		} catch {
			return jsonResponse({ error: 'Failed to read file' }, 500)
		}
	}

	async function handleImageServe(_req: Request, url: URL): Promise<Response> {
		const sessionId = url.searchParams.get('session')
		const relPath = url.searchParams.get('path')
		if (!sessionId || !relPath) return jsonResponse({ error: 'Missing session or path' }, 400)

		const resolved = resolveSessionPath(sessionId, relPath)
		if (resolved instanceof Response) return resolved

		try {
			const file = Bun.file(resolved.fullPath)
			if (!(await file.exists())) return jsonResponse({ error: 'File not found' }, 404)
			if (file.size > 10 * 1024 * 1024) return jsonResponse({ error: 'File too large' }, 413)

			const ext = relPath.split('.').pop()?.toLowerCase() || ''
			const mime = IMAGE_MIME[ext]
			if (!mime) return jsonResponse({ error: 'Unsupported image format' }, 415)

			return new Response(file, {
				headers: {
					'Content-Type': mime,
					'Cache-Control': 'public, max-age=300',
					// An SVG opened as a document would otherwise run its scripts in the daemon's origin.
					'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
					'X-Content-Type-Options': 'nosniff',
				},
			})
		} catch {
			return jsonResponse({ error: 'Failed to read file' }, 500)
		}
	}

	async function handleTreeServe(_req: Request, url: URL): Promise<Response> {
		const sessionId = url.searchParams.get('session')
		const relPath = url.searchParams.get('path') || ''
		if (!sessionId) return jsonResponse({ error: 'Missing session' }, 400)

		const resolved = resolveSessionPath(sessionId, relPath)
		if (resolved instanceof Response) return resolved

		const ignoreDirs = new Set(['.git', 'node_modules', '.next', '__pycache__', 'dist', '.cache'])

		try {
			const dirents = await readdir(resolved.fullPath, { withFileTypes: true })
			const entries = dirents
				.filter((d) => !ignoreDirs.has(d.name) && !d.name.startsWith('.'))
				.map((d) => ({
					name: d.name,
					type: d.isDirectory() ? 'dir' : 'file',
				}))
				.sort((a, b) => {
					if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
					return a.name.localeCompare(b.name)
				})
			return jsonResponse({ entries })
		} catch {
			return jsonResponse({ error: 'Failed to read directory' }, 500)
		}
	}

	return [
		{ method: 'GET', pattern: new URLPattern({ pathname: '/api/file' }), handler: handleFileServe },
		{ method: 'GET', pattern: new URLPattern({ pathname: '/api/image' }), handler: handleImageServe },
		{ method: 'GET', pattern: new URLPattern({ pathname: '/api/tree' }), handler: handleTreeServe },
	]
}
