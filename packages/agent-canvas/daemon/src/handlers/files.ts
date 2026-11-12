import { canvasFileReferences, type RevisionInfo, type SessionData, type SessionManager } from '@fabrika/canvas-kernel/server'
import { jsonResponse, type Route } from '@fabrika/daemon-kit'
import { realpathSync } from 'fs'
import { readdir } from 'fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'path'
import { LANG_MAP } from '../../langMap'
import { HOST_FILE_REFERENCE_PROPS } from '../components'

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

/** `attachment` with an ASCII fallback name and the exact one in RFC 5987 form. */
export function attachmentDisposition(name: string): string {
	const fallback = name.replace(/[^A-Za-z0-9._-]/g, '_') || 'download'
	const exact = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
	return `attachment; filename="${fallback}"; filename*=UTF-8''${exact}`
}

function isInside(path: string, root: string): boolean {
	const relativePath = relative(root, path)
	return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

/** `named-file`: a file a canvas of the session names, wherever it is; inside the project root too. */
type PathKind = 'file' | 'directory' | 'named-file'
type SessionPathResolver = (sessionId: string, relPath: string, kind: PathKind) => { fullPath: string } | Response

/**
 * The files the session's canvases name, in every revision, as written and with symlinks resolved. A push or a new
 * session replaces the revisions array, so the array is the cache key.
 */
function createNamedFiles(sessionManager: SessionManager): (session: SessionData) => Set<string> {
	const cache = new WeakMap<readonly RevisionInfo[], Set<string>>()
	return (session) => {
		const cached = cache.get(session.revisions)
		if (cached !== undefined) return cached
		const paths = new Set<string>()
		for (const revision of session.revisions) {
			for (const { filename } of revision.canvasFiles) {
				const jsx = sessionManager.readRevisionJsx(session.id, revision.revision, filename)
				if (jsx === null) continue
				for (const reference of canvasFileReferences(jsx, HOST_FILE_REFERENCE_PROPS)) {
					const path = resolve(session.projectRoot, reference)
					paths.add(path)
					paths.add(realOrSelf(path))
				}
			}
		}
		cache.set(session.revisions, paths)
		return paths
	}
}

/**
 * Resolves a path against the session's project root. Outside it, symlinks resolved, only a file a canvas of the session
 * names is served and no directory is listed; nothing in a denied root is. The canvas author controls that list, so it
 * stops computed paths and other clients' reads, not a hostile canvas.
 */
function createSessionPathResolver(sessionManager: SessionManager, options: FileHandlerOptions): SessionPathResolver {
	const deniedRoots = [...new Set(options.deniedRoots.flatMap((root) => [resolve(root), realOrSelf(resolve(root))]))]
	const namedFiles = createNamedFiles(sessionManager)

	return (sessionId, relPath, kind) => {
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
		const lexicalRoot = resolve(session.projectRoot)
		// realOrSelf leaves a missing path unresolved, so one under a symlinked root is judged by where it was asked for.
		const insideRoot = isInside(realPath, realOrSelf(lexicalRoot)) || (realPath === fullPath && isInside(fullPath, lexicalRoot))
		const named = () => namedFiles(session).has(fullPath) || namedFiles(session).has(realPath)
		if (kind === 'named-file' && !named()) return jsonResponse({ error: 'Path is not named by a canvas in this session' }, 403)
		if (!insideRoot && (kind === 'directory' || !named())) {
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

		const resolved = resolveSessionPath(sessionId, relPath, 'file')
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

		const resolved = resolveSessionPath(sessionId, relPath, 'file')
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

	/** A file the agent produced and named in `<Download path>` (or any file reference), as an attachment. */
	async function handleDownload(_req: Request, url: URL): Promise<Response> {
		const sessionId = url.searchParams.get('session')
		const relPath = url.searchParams.get('path')
		if (!sessionId || !relPath) return jsonResponse({ error: 'Missing session or path' }, 400)

		const resolved = resolveSessionPath(sessionId, relPath, 'named-file')
		if (resolved instanceof Response) return resolved

		const file = Bun.file(resolved.fullPath)
		if (!(await file.exists())) return jsonResponse({ error: 'File not found' }, 404)
		return new Response(file, {
			headers: {
				'Content-Type': 'application/octet-stream',
				'Content-Disposition': attachmentDisposition(basename(relPath)),
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff',
			},
		})
	}

	async function handleTreeServe(_req: Request, url: URL): Promise<Response> {
		const sessionId = url.searchParams.get('session')
		const relPath = url.searchParams.get('path') || ''
		if (!sessionId) return jsonResponse({ error: 'Missing session' }, 400)

		const resolved = resolveSessionPath(sessionId, relPath, 'directory')
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
		{ method: 'GET', pattern: new URLPattern({ pathname: '/api/download' }), handler: handleDownload },
	]
}
