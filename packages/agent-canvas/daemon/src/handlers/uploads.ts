import type { SessionManager } from '@fabrika/canvas-kernel/server'
import { jsonResponse, type Route } from '@fabrika/daemon-kit'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { UPLOADS_DIR } from '../paths'
import { parseUploadImage, UPLOAD_IMAGE_REFUSED, uploadImageTypeOfExtension, uploadServeHeaders } from '../upload-image'

export function createUploadHandlers(sessionManager: SessionManager): Route[] {
	async function handleUpload(req: Request, _url: URL, match: URLPatternResult): Promise<Response> {
		const sessionId = match.pathname.groups.id!
		if (!sessionManager.get(sessionId)) {
			return jsonResponse({ error: 'Session not found' }, 404)
		}

		const formData = await req.formData()
		const file = formData.get('image')
		if (!(file instanceof File)) return jsonResponse({ error: 'No image provided' }, 400)
		if (file.size > 10 * 1024 * 1024) return jsonResponse({ error: 'Image too large (max 10MB)' }, 413)

		const bytes = new Uint8Array(await file.arrayBuffer())
		const image = parseUploadImage(bytes)
		if (!image) return jsonResponse({ error: UPLOAD_IMAGE_REFUSED }, 400)

		const filename = `${crypto.randomUUID()}.${image.extension}`
		const filepath = join(UPLOADS_DIR, filename)
		writeFileSync(filepath, bytes)

		return jsonResponse({ path: filepath, filename })
	}

	async function handleUploadServe(_req: Request, _url: URL, match: URLPatternResult): Promise<Response> {
		const filename = match.pathname.groups.filename!
		if (filename.includes('/') || filename.includes('..')) {
			return jsonResponse({ error: 'Invalid filename' }, 400)
		}

		const filepath = join(UPLOADS_DIR, filename)
		const file = Bun.file(filepath)
		if (!(await file.exists())) return jsonResponse({ error: 'Not found' }, 404)

		const ext = filename.split('.').pop() ?? ''

		return new Response(file, {
			headers: {
				...uploadServeHeaders(uploadImageTypeOfExtension(ext)),
				'Cache-Control': 'public, max-age=3600',
			},
		})
	}

	return [
		{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/upload' }), handler: handleUpload },
		{ method: 'GET', pattern: new URLPattern({ pathname: '/api/uploads/:filename' }), handler: handleUploadServe },
	]
}
