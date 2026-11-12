import type { SessionManager } from '@fabrika/canvas-kernel/server'
import { jsonResponse, type Route } from '@fabrika/daemon-kit'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ASSET_FIELD_ID_RE, MAX_ASSET_BYTES, type StoredAsset } from '../assets'

/**
 * Files the user hands the agent through `<FileDrop>`: `sessions/<id>/assets/<field>/<uuid>-<name>`. The feedback
 * names their absolute paths and the agent reads them with its own tools. Nothing here serves a file back, so an
 * upload is never rendered as a page or a script. Files are kept until the session directory is removed.
 */

export { MAX_ASSET_BYTES }
export const MAX_SESSION_ASSET_BYTES = 250 * 1024 * 1024
export const MAX_SESSION_ASSETS = 100

const ASSET_RE = /^[0-9a-f-]{36}-[A-Za-z0-9._-]{1,100}$/
const MAX_NAME = 100
// A multipart body carries the file plus its headers; this much more is plenty.
const MULTIPART_OVERHEAD = 64 * 1024

/** The original name as a file name that is safe on every platform, needs no URL encoding and is never a path. */
export function safeAssetName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? ''
	const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, MAX_NAME)
	return safe === '' ? 'file' : safe
}

export function createAssetHandlers(sessionManager: SessionManager): Route[] {
	function fieldDir(sessionId: string, field: string): string {
		return join(sessionManager.assetsDir(sessionId), field)
	}

	function list(dir: string): StoredAsset[] {
		if (!existsSync(dir)) return []
		return readdirSync(dir).filter((id) => ASSET_RE.test(id)).sort().map((id) => {
			const path = join(dir, id)
			return { id, name: id.slice(37), path, size: statSync(path).size }
		})
	}

	function usage(sessionId: string): { count: number; bytes: number } {
		const root = sessionManager.assetsDir(sessionId)
		if (!existsSync(root)) return { count: 0, bytes: 0 }
		const files = readdirSync(root).filter((field) => ASSET_FIELD_ID_RE.test(field)).flatMap((field) => list(join(root, field)))
		return { count: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) }
	}

	/** The refusal when the session cannot take `adding` more bytes in one more file, or null. */
	function sessionFull(sessionId: string, adding: number): Response | null {
		const used = usage(sessionId)
		if (used.count >= MAX_SESSION_ASSETS) return jsonResponse({ error: `This session already holds ${MAX_SESSION_ASSETS} files` }, 507)
		if (used.bytes + adding > MAX_SESSION_ASSET_BYTES) {
			return jsonResponse({ error: `This session's files would exceed ${MAX_SESSION_ASSET_BYTES / 1024 / 1024} MB` }, 507)
		}
		return null
	}

	/** The session and field of a request, or the refusal. */
	function target(match: URLPatternResult): { sessionId: string; field: string } | Response {
		const sessionId = match.pathname.groups['id'] ?? ''
		const field = match.pathname.groups['field'] ?? ''
		if (!sessionManager.get(sessionId)) return jsonResponse({ error: 'Session not found' }, 404)
		if (!ASSET_FIELD_ID_RE.test(field)) return jsonResponse({ error: 'Invalid field ID' }, 400)
		return { sessionId, field }
	}

	function handleList(_req: Request, _url: URL, match: URLPatternResult): Response {
		const at = target(match)
		if (at instanceof Response) return at
		return jsonResponse({ files: list(fieldDir(at.sessionId, at.field)) })
	}

	async function handleUpload(req: Request, _url: URL, match: URLPatternResult): Promise<Response> {
		const at = target(match)
		if (at instanceof Response) return at
		const tooLarge = jsonResponse({ error: `File too large (max ${MAX_ASSET_BYTES / 1024 / 1024} MB)` }, 413)
		// Without a declared length the body would be buffered in full before any limit applies; browsers always send one.
		const declared = Number(req.headers.get('Content-Length') ?? 'NaN')
		if (!Number.isFinite(declared)) return jsonResponse({ error: 'Content-Length required' }, 411)
		if (declared > MAX_ASSET_BYTES + MULTIPART_OVERHEAD) return tooLarge
		// Fails fast before the body is buffered; the check after the read is the one that counts.
		const fullBeforeRead = sessionFull(at.sessionId, 0)
		if (fullBeforeRead) return fullBeforeRead

		let file: FormDataEntryValue | null
		try {
			file = (await req.formData()).get('file')
		} catch {
			return jsonResponse({ error: 'Expected a multipart form with a file' }, 400)
		}
		if (!(file instanceof File)) return jsonResponse({ error: 'No file provided' }, 400)
		if (file.size > MAX_ASSET_BYTES) return tooLarge
		const bytes = new Uint8Array(await file.arrayBuffer())

		// No await from here to the write, so concurrent uploads cannot all pass the same check.
		const full = sessionFull(at.sessionId, bytes.byteLength)
		if (full) return full

		const dir = fieldDir(at.sessionId, at.field)
		mkdirSync(dir, { recursive: true, mode: 0o700 })
		// UUIDv7 sorts by time, so a listing keeps the upload order.
		const id = `${Bun.randomUUIDv7()}-${safeAssetName(file.name)}`
		const path = join(dir, id)
		writeFileSync(path, bytes, { mode: 0o600 })
		const stored: StoredAsset = { id, name: id.slice(37), path, size: bytes.byteLength }
		return jsonResponse({ file: stored })
	}

	function handleDelete(_req: Request, _url: URL, match: URLPatternResult): Response {
		const at = target(match)
		if (at instanceof Response) return at
		const asset = match.pathname.groups['asset'] ?? ''
		if (!ASSET_RE.test(asset)) return jsonResponse({ error: 'Invalid file ID' }, 400)
		const path = join(fieldDir(at.sessionId, at.field), asset)
		if (!existsSync(path)) return jsonResponse({ error: 'Not found' }, 404)
		rmSync(path)
		return jsonResponse({ ok: true })
	}

	return [
		{ method: 'GET', pattern: new URLPattern({ pathname: '/api/session/:id/assets/:field' }), handler: handleList },
		{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/assets/:field' }), handler: handleUpload },
		{ method: 'DELETE', pattern: new URLPattern({ pathname: '/api/session/:id/assets/:field/:asset' }), handler: handleDelete },
	]
}
