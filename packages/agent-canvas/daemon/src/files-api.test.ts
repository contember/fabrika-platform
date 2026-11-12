import { SessionManager } from '@fabrika/canvas-kernel/server'
import { dispatch } from '@fabrika/daemon-kit'
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { attachmentDisposition, createFileHandlers } from './handlers/files'

const directories: string[] = []

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

/** `canvas` receives the directory outside the project root and returns the session's canvas JSX. */
function setup(
	canvas: (outsideRoot: string) => string = (outside) => `<FilePreview path="${outside}/external.ts" />\n<ImageView src="${outside}/image.svg" />`,
) {
	const directory = mkdtempSync(join(tmpdir(), 'agent-canvas-files-'))
	directories.push(directory)
	const projectRoot = join(directory, 'project')
	const outsideRoot = join(directory, 'project-other')
	const tempDir = join(directory, 'daemon-temp')
	const dataDir = join(directory, 'daemon-data')
	mkdirSync(projectRoot)
	mkdirSync(outsideRoot)
	mkdirSync(tempDir)
	mkdirSync(dataDir)
	writeFileSync(join(tempDir, 'daemon-auth-token'), 'dummy-capability')
	writeFileSync(join(dataDir, 'state.json'), '{}')
	writeFileSync(join(projectRoot, 'local.ts'), 'export const local = true;')
	writeFileSync(join(outsideRoot, 'external.ts'), 'export const external = true;')
	writeFileSync(join(outsideRoot, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" />')
	const manager = new SessionManager(join(directory, 'sessions'))
	manager.upsert('files', new Map([['plan.jsx', canvas(outsideRoot)]]), projectRoot)
	const routes = createFileHandlers(manager, { deniedRoots: [tempDir, dataDir] })

	async function get(endpoint: string, path: string) {
		const url = new URL(`http://localhost:19400/api/${endpoint}`)
		url.searchParams.set('session', 'files')
		url.searchParams.set('path', path)
		const response = dispatch(routes, new Request(url), url)
		if (!response) throw new Error(`No route for ${endpoint}`)
		return response
	}

	return { get, manager, projectRoot, outsideRoot, tempDir, dataDir }
}

test('serves relative paths, absolute paths inside the project root, and absolute paths a canvas names', async () => {
	const { get, projectRoot, outsideRoot } = setup()
	for (const path of ['local.ts', join(projectRoot, 'local.ts'), join(outsideRoot, 'external.ts')]) {
		const response = await get('file', path)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			content: path.endsWith('external.ts') ? 'export const external = true;' : 'export const local = true;',
			language: 'typescript',
		})
	}
})

test('serves an absolute image a canvas names outside the project root', async () => {
	const { get, outsideRoot } = setup()
	const image = await get('image', join(outsideRoot, 'image.svg'))
	expect(image.status).toBe(200)
	expect(image.headers.get('Content-Type')).toBe('image/svg+xml')
	expect(image.headers.get('Content-Security-Policy')).toContain('sandbox')
	expect(image.headers.get('X-Content-Type-Options')).toBe('nosniff')
})

test('refuses a path outside the project root that no canvas names, and any directory outside it', async () => {
	const { get, outsideRoot } = setup(() => '<Section />')
	expect((await get('file', join(outsideRoot, 'external.ts'))).status).toBe(403)
	expect((await get('image', join(outsideRoot, 'image.svg'))).status).toBe(403)
	expect((await get('tree', outsideRoot)).status).toBe(403)
	const named = setup()
	expect((await named.get('tree', named.outsideRoot)).status).toBe(403)
	expect((await named.get('file', join(named.outsideRoot, 'image.svg'))).status).toBe(200)
	expect((await named.get('file', join(named.outsideRoot, 'other.ts'))).status).toBe(403)
})

test('keeps serving a file an earlier revision named', async () => {
	const { get, manager, projectRoot, outsideRoot } = setup()
	manager.upsert('files', new Map([['plan.jsx', '<Section />']]), projectRoot)
	expect((await get('file', join(outsideRoot, 'external.ts'))).status).toBe(200)
})

test('rejects relative traversal into a sibling with the same root prefix', async () => {
	const { get } = setup()
	for (const endpoint of ['file', 'image', 'tree']) {
		expect((await get(endpoint, '../project-other/external.ts')).status).toBe(403)
	}
})

test('returns 404 for a missing absolute file a canvas names', async () => {
	const { get, outsideRoot } = setup((outside) => `<FilePreview path="${outside}/missing.ts" />`)
	expect((await get('file', join(outsideRoot, 'missing.ts'))).status).toBe(404)
})

test("refuses the daemon's own state directories, the capability file included", async () => {
	const { get, tempDir, dataDir } = setup()
	for (const endpoint of ['file', 'image', 'tree']) {
		for (const path of [join(tempDir, 'daemon-auth-token'), tempDir, join(dataDir, 'state.json'), dataDir, join(dataDir, 'missing.png')]) {
			const response = await get(endpoint, path)
			expect(response.status).toBe(403)
			expect(await response.text()).not.toContain('dummy-capability')
		}
	}
})

test("refuses a symlink that resolves into the daemon's state", async () => {
	const { get, projectRoot, outsideRoot, tempDir } = setup()
	symlinkSync(join(tempDir, 'daemon-auth-token'), join(projectRoot, 'token-link.txt'))
	symlinkSync(tempDir, join(outsideRoot, 'state-link'))
	expect((await get('file', 'token-link.txt')).status).toBe(403)
	expect((await get('file', join(outsideRoot, 'state-link', 'daemon-auth-token'))).status).toBe(403)
	expect((await get('tree', join(outsideRoot, 'state-link'))).status).toBe(403)
})

test('treats a symlink inside the project root that leads out of it as outside', async () => {
	const { get, projectRoot, outsideRoot } = setup(() => '<Section />')
	symlinkSync(outsideRoot, join(projectRoot, 'link'))
	expect((await get('file', 'link/external.ts')).status).toBe(403)
	expect((await get('tree', 'link')).status).toBe(403)
	const named = setup((outside) => `<FilePreview path="${outside}/external.ts" />`)
	symlinkSync(named.outsideRoot, join(named.projectRoot, 'link'))
	expect((await named.get('file', 'link/external.ts')).status).toBe(200)
})

test('never lists a directory outside the project root, even one a canvas names', async () => {
	const { get, outsideRoot } = setup((outside) => `<FilePreview path="${outside}" />`)
	expect((await get('tree', outsideRoot)).status).toBe(403)
})

test('forgets the names of a removed session that comes back with as many revisions', async () => {
	const { get, manager, projectRoot, outsideRoot } = setup()
	expect((await get('file', join(outsideRoot, 'external.ts'))).status).toBe(200)
	manager.remove('files')
	manager.upsert('files', new Map([['plan.jsx', `<ImageView src="${outsideRoot}/image.svg" />`]]), projectRoot)
	expect((await get('file', join(outsideRoot, 'external.ts'))).status).toBe(403)
	expect((await get('image', join(outsideRoot, 'image.svg'))).status).toBe(200)
})

test('answers 404, not 403, for a missing file under a project root reached through a symlink', async () => {
	const { get, projectRoot, manager } = setup(() => '<Section />')
	const linkedRoot = `${projectRoot}-link`
	symlinkSync(projectRoot, linkedRoot)
	manager.upsert('files', new Map([['plan.jsx', '<Section />']]), linkedRoot)
	expect((await get('file', 'missing.ts')).status).toBe(404)
	expect((await get('file', 'local.ts')).status).toBe(200)
})

test('downloads only a file a canvas names, inside the project root too, as an attachment', async () => {
	const { get, projectRoot, outsideRoot, dataDir } = setup((outside) =>
		`<Download path="${outside}/external.ts" label="Patch" />\n<Download path="local.ts" />`
	)

	const outside = await get('download', join(outsideRoot, 'external.ts'))
	expect(outside.status).toBe(200)
	expect(outside.headers.get('Content-Disposition')).toBe(`attachment; filename="external.ts"; filename*=UTF-8''external.ts`)
	expect(outside.headers.get('Content-Type')).toBe('application/octet-stream')
	expect(outside.headers.get('X-Content-Type-Options')).toBe('nosniff')
	expect(await outside.text()).toBe('export const external = true;')

	expect((await get('download', 'local.ts')).status).toBe(200)
	// Readable through /api/file, but no canvas offers it for download.
	writeFileSync(join(projectRoot, 'other.ts'), 'x')
	expect((await get('download', 'other.ts')).status).toBe(403)
	expect((await get('download', join(dataDir, 'state.json'))).status).toBe(403)
})

test('a Download path also admits the file to the read routes, a computed one does not', async () => {
	const { get, outsideRoot } = setup((outside) => `<Download path={"${outside}/external.ts"} />\n<Download path={dir + '/image.svg'} />`)
	expect((await get('file', join(outsideRoot, 'external.ts'))).status).toBe(200)
	expect((await get('download', join(outsideRoot, 'image.svg'))).status).toBe(403)
})

test('an attachment name cannot break out of its header', () => {
	expect(attachmentDisposition('report "final"; x=1.pdf')).toBe(
		`attachment; filename="report__final___x_1.pdf"; filename*=UTF-8''report%20%22final%22%3B%20x%3D1.pdf`,
	)
	expect(attachmentDisposition("it's (draft).txt")).toBe(`attachment; filename="it_s__draft_.txt"; filename*=UTF-8''it%27s%20%28draft%29.txt`)
})
