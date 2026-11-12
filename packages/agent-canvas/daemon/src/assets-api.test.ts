import { SessionManager } from '@fabrika/canvas-kernel/server'
import { dispatch, type Route } from '@fabrika/daemon-kit'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { createAssetHandlers, MAX_ASSET_BYTES, MAX_SESSION_ASSETS, safeAssetName } from './handlers/assets'

const testDirectories: string[] = []

afterEach(() => {
	for (const directory of testDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function setup() {
	const directory = mkdtempSync(join(tmpdir(), 'agent-canvas-assets-'))
	testDirectories.push(directory)
	const sessionManager = new SessionManager(directory)
	sessionManager.upsert('intake', new Map([['intake.jsx', '<Section title="Intake" />']]), directory)
	return { routes: createAssetHandlers(sessionManager), sessionManager }
}

async function call(routes: Route[], method: string, path: string, body?: BodyInit, headers?: Record<string, string>): Promise<Response> {
	const url = new URL(`http://localhost:19400${path}`)
	const response = await dispatch(routes, new Request(url, { method, ...(body === undefined ? {} : { body }), ...(headers ? { headers } : {}) }), url)
	if (!response) throw new Error(`No route for ${method} ${path}`)
	return response
}

function form(name: string, content: string | Uint8Array): FormData {
	const body = new FormData()
	body.append('file', new File([content], name))
	return body
}

const storedOf = (json: unknown) => {
	if (typeof json === 'object' && json !== null && 'file' in json && typeof json.file === 'object' && json.file !== null) {
		const file = json.file
		if ('path' in file && typeof file.path === 'string' && 'id' in file && typeof file.id === 'string') return { path: file.path, id: file.id }
	}
	throw new Error(`Unexpected upload answer ${JSON.stringify(json)}`)
}

describe('file drop assets', () => {
	test('stores a dropped file with the session and lists it for its field only', async () => {
		const { routes } = setup()
		const upload = await call(routes, 'POST', '/api/session/intake/assets/logs', form('server.log', 'boot ok'))
		expect(upload.status).toBe(200)
		const { path } = storedOf(await upload.json())
		expect(readFileSync(path, 'utf-8')).toBe('boot ok')
		expect(path).toContain(join('intake', 'assets', 'logs'))
		expect(statSync(path).mode & 0o777).toBe(0o600)

		const listed = await (await call(routes, 'GET', '/api/session/intake/assets/logs')).json()
		expect(listed).toMatchObject({ files: [{ name: 'server.log', path, size: 7 }] })
		expect(await (await call(routes, 'GET', '/api/session/intake/assets/other')).json()).toEqual({ files: [] })
	})

	test('a file name never becomes a path', async () => {
		const { routes } = setup()
		const { path } = storedOf(await (await call(routes, 'POST', '/api/session/intake/assets/logs', form('../../escape me?.txt', 'x'))).json())
		expect(dirname(path).endsWith(join('assets', 'logs'))).toBe(true)
		expect(safeAssetName('../../escape me?.txt')).toBe('escape_me_.txt')
		expect(safeAssetName('..')).toBe('file')
		expect(safeAssetName('C:\\Users\\me\\report.pdf')).toBe('report.pdf')
	})

	test('removes a file of its own field', async () => {
		const { routes } = setup()
		const { path, id } = storedOf(await (await call(routes, 'POST', '/api/session/intake/assets/logs', form('a.txt', 'x'))).json())
		expect((await call(routes, 'DELETE', `/api/session/intake/assets/other/${id}`)).status).toBe(404)
		expect((await call(routes, 'DELETE', '/api/session/intake/assets/logs/..%2F..%2Fmeta.json')).status).toBe(400)
		expect((await call(routes, 'DELETE', `/api/session/intake/assets/logs/${id}`)).status).toBe(200)
		expect(existsSync(path)).toBe(false)
	})

	test('refuses an unknown session, an invalid field and a body without a file', async () => {
		const { routes } = setup()
		expect((await call(routes, 'POST', '/api/session/other/assets/logs', form('a.txt', 'x'))).status).toBe(404)
		expect((await call(routes, 'POST', '/api/session/intake/assets/.hidden', form('a.txt', 'x'))).status).toBe(400)
		expect((await call(routes, 'POST', '/api/session/intake/assets/logs', 'plain', { 'Content-Type': 'text/plain' })).status).toBe(400)
	})

	test('refuses a file over the limit before reading it, and a session that is full', async () => {
		const { routes } = setup()
		const declaredTooLarge = await call(routes, 'POST', '/api/session/intake/assets/logs', 'x', { 'Content-Length': String(MAX_ASSET_BYTES * 2) })
		expect(declaredTooLarge.status).toBe(413)
		expect((await call(routes, 'POST', '/api/session/intake/assets/logs', form('big.bin', new Uint8Array(MAX_ASSET_BYTES + 1)))).status).toBe(413)

		for (let i = 0; i < MAX_SESSION_ASSETS; i++) await call(routes, 'POST', '/api/session/intake/assets/logs', form(`${i}.txt`, 'x'))
		expect((await call(routes, 'POST', '/api/session/intake/assets/logs', form('one-more.txt', 'x'))).status).toBe(413)
	})

	test('files go with the session', async () => {
		const { routes, sessionManager } = setup()
		const { path } = storedOf(await (await call(routes, 'POST', '/api/session/intake/assets/logs', form('a.txt', 'x'))).json())
		sessionManager.remove('intake')
		expect(existsSync(path)).toBe(false)
	})
})
