import { SessionManager } from '@fabrika/canvas-kernel/server'
import { dispatch } from '@fabrika/daemon-kit'
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createFileHandlers } from './handlers/files'

const directories: string[] = []

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

function setup() {
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
	manager.upsert('files', new Map([['plan.jsx', '<Section />']]), projectRoot)
	const routes = createFileHandlers(manager, { deniedRoots: [tempDir, dataDir] })

	async function get(endpoint: string, path: string) {
		const url = new URL(`http://localhost:19400/api/${endpoint}`)
		url.searchParams.set('session', 'files')
		url.searchParams.set('path', path)
		const response = dispatch(routes, new Request(url), url)
		if (!response) throw new Error(`No route for ${endpoint}`)
		return response
	}

	return { get, projectRoot, outsideRoot, tempDir, dataDir }
}

test('serves relative paths and absolute paths inside and outside the project root', async () => {
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

test('serves absolute image and directory paths outside the project root', async () => {
	const { get, outsideRoot } = setup()
	const image = await get('image', join(outsideRoot, 'image.svg'))
	expect(image.status).toBe(200)
	expect(image.headers.get('Content-Type')).toBe('image/svg+xml')
	const tree = await get('tree', outsideRoot)
	expect(tree.status).toBe(200)
	expect(await tree.json()).toEqual({
		entries: [
			{ name: 'external.ts', type: 'file' },
			{ name: 'image.svg', type: 'file' },
		],
	})
})

test('rejects relative traversal into a sibling with the same root prefix', async () => {
	const { get } = setup()
	for (const endpoint of ['file', 'image', 'tree']) {
		expect((await get(endpoint, '../project-other/external.ts')).status).toBe(403)
	}
})

test('returns 404 for a missing absolute file', async () => {
	const { get, outsideRoot } = setup()
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
