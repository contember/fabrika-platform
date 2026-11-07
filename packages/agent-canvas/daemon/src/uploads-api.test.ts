import { SessionManager } from '@fabrika/canvas-kernel/server'
import { dispatch } from '@fabrika/daemon-kit'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod'
import { createUploadHandlers } from './handlers/uploads'
import { UPLOADS_DIR } from './paths'

const uploadedSchema = z.object({ path: z.string(), filename: z.string() })

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
const BMP = new Uint8Array([0x42, 0x4d, 0x3a, 0, 0, 0, 0, 0, 0, 0, 0x36, 0, 0, 0])
const INERT = { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" }

const cleanup: string[] = []
afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true })
})

function setup() {
	const directory = mkdtempSync(join(tmpdir(), 'agent-canvas-uploads-'))
	cleanup.push(directory)
	const manager = new SessionManager(join(directory, 'sessions'))
	manager.upsert('uploads', new Map([['plan.jsx', '<Section />']]), directory)
	const routes = createUploadHandlers(manager)

	function call(request: Request) {
		const response = dispatch(routes, request, new URL(request.url))
		if (!response) throw new Error(`No route for ${request.url}`)
		return response
	}
	const upload = (bytes: Uint8Array<ArrayBuffer>, name: string) => {
		const form = new FormData()
		form.set('image', new File([bytes], name))
		return call(new Request('http://localhost:19400/api/session/uploads/upload', { method: 'POST', body: form }))
	}
	const serve = (filename: string) => call(new Request(`http://localhost:19400/api/uploads/${filename}`))
	return { upload, serve }
}

test('accepts a PNG, names it by the type its content carries and serves it inert', async () => {
	const { upload, serve } = setup()
	const uploaded = await upload(PNG, 'shot.jpg')
	expect(uploaded.status).toBe(200)
	const { path, filename } = uploadedSchema.parse(await uploaded.json())
	cleanup.push(path)
	expect(filename).toEndWith('.png')

	const served = await serve(filename)
	expect(served.status).toBe(200)
	expect(Object.fromEntries(served.headers)).toMatchObject({ ...INERT, 'content-type': 'image/png' })
	expect(served.headers.get('content-disposition')).toBeNull()
})

test('refuses content that is not a PNG, JPEG, GIF or WebP, whatever its name says', async () => {
	const { upload } = setup()
	expect((await upload(SVG, 'drawing.svg')).status).toBe(400)
	expect((await upload(SVG, 'shot.png')).status).toBe(400)
	expect((await upload(BMP, 'shot.bmp')).status).toBe(400)
})

test('serves an upload stored before the allowlist as an inert download', async () => {
	const { serve } = setup()
	const filename = `${crypto.randomUUID()}.svg`
	const path = join(UPLOADS_DIR, filename)
	writeFileSync(path, SVG)
	cleanup.push(path)

	const served = await serve(filename)
	expect(served.status).toBe(200)
	expect(Object.fromEntries(served.headers)).toMatchObject({
		...INERT,
		'content-type': 'application/octet-stream',
		'content-disposition': 'attachment',
	})
})
