// A real directory on disk, no network, no services. The cases that matter are the ones where a
// static server is usually wrong: the SPA fallback answering for a MISSING BUNDLE (which turns a 404
// into a browser syntax error), and path traversal escaping the root.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSystemAssetServer } from '../asset-server-fs'

let root = ''
let outside = ''

beforeAll(async () => {
	const base = await mkdtemp(join(tmpdir(), 'fabrika-assets-'))
	root = join(base, 'dist')
	outside = join(base, 'secret.txt')
	await Bun.write(join(root, 'index.html'), '<!doctype html><title>shell</title>')
	await Bun.write(join(root, 'assets', 'main-abc123.js'), 'console.log(1)')
	await Bun.write(join(root, 'assets', 'main-abc123.css'), 'body{}')
	await Bun.write(join(root, 'favicon.svg'), '<svg/>')
	await Bun.write(join(root, 'data.bin'), new Uint8Array([1, 2, 3]))
	await Bun.write(join(root, 'nested', 'index.html'), '<!doctype html><title>nested</title>')
	await Bun.write(outside, 'do not serve me')
})

afterAll(async () => {
	if (root !== '') {
		await rm(join(root, '..'), { recursive: true, force: true })
	}
})

function server(options?: ConstructorParameters<typeof FileSystemAssetServer>[1]): FileSystemAssetServer {
	return new FileSystemAssetServer(root, options)
}

/** A browser navigation — what the SPA fallback exists for. */
function navigate(path: string): Request {
	return new Request(`https://app.test${path}`, { headers: { accept: 'text/html,application/xhtml+xml' } })
}

/** A sub-resource fetch, as a browser issues for `<script src>`: a wildcard Accept, never `text/html`. */
function asset(path: string): Request {
	return new Request(`https://app.test${path}`, { headers: { accept: '*/*' } })
}

describe('FileSystemAssetServer — serving files', () => {
	test('serves index.html at the root', async () => {
		const response = await server().fetch(navigate('/'))
		expect(response.status).toBe(200)
		expect(await response.text()).toContain('shell')
	})

	test('serves a nested directory index', async () => {
		const response = await server().fetch(navigate('/nested/'))
		expect(await response.text()).toContain('nested')
	})

	test('serves a directory without the trailing slash too', async () => {
		const response = await server().fetch(navigate('/nested'))
		expect(await response.text()).toContain('nested')
	})

	test('sets a correct content type per extension', async () => {
		const cases: [string, string][] = [
			['/index.html', 'text/html'],
			['/assets/main-abc123.js', 'text/javascript'],
			['/assets/main-abc123.css', 'text/css'],
			['/favicon.svg', 'image/svg+xml'],
			['/data.bin', 'application/octet-stream'],
		]
		for (const [path, expected] of cases) {
			const response = await server().fetch(asset(path))
			expect(response.status).toBe(200)
			expect(response.headers.get('content-type')).toStartWith(expected)
		}
	})

	test('sets content-length', async () => {
		const response = await server().fetch(asset('/data.bin'))
		expect(response.headers.get('content-length')).toBe('3')
	})

	test('HEAD returns the headers with no body', async () => {
		const response = await server().fetch(new Request('https://app.test/index.html', { method: 'HEAD' }))
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toStartWith('text/html')
		expect(await response.text()).toBe('')
	})

	test('a percent-encoded path resolves to the same file', async () => {
		const response = await server().fetch(asset('/assets/main%2Dabc123.js'))
		expect(response.status).toBe(200)
	})

	test('rejects a non-GET/HEAD method', async () => {
		const response = await server().fetch(new Request('https://app.test/index.html', { method: 'POST' }))
		expect(response.status).toBe(405)
		expect(response.headers.get('allow')).toBe('GET, HEAD')
	})
})

describe('FileSystemAssetServer — SPA fallback', () => {
	test('a client-routed path serves the shell with 200', async () => {
		const response = await server().fetch(navigate('/apps/my-app/runs/42'))
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toStartWith('text/html')
		expect(await response.text()).toContain('shell')
	})

	test('an extension-less path falls back even without an Accept header', async () => {
		const response = await server().fetch(new Request('https://app.test/apps/my-app'))
		expect(response.status).toBe(200)
		expect(await response.text()).toContain('shell')
	})

	test('a MISSING ASSET still 404s — the fallback must not mask a bad bundle URL', async () => {
		const response = await server().fetch(asset('/assets/main-deadbeef.js'))
		expect(response.status).toBe(404)
	})

	test('a missing asset 404s even inside a directory that exists', async () => {
		const response = await server().fetch(asset('/assets/nope.css'))
		expect(response.status).toBe(404)
	})

	test('fallback can be turned off entirely', async () => {
		const response = await server({ spaFallback: false }).fetch(navigate('/apps/my-app'))
		expect(response.status).toBe(404)
	})

	test('a custom index file is used for both directories and the fallback', async () => {
		const base = await mkdtemp(join(tmpdir(), 'fabrika-assets-alt-'))
		await Bun.write(join(base, 'app.html'), '<!doctype html><title>alt</title>')
		const alt = new FileSystemAssetServer(base, { indexFile: 'app.html' })
		expect(await (await alt.fetch(navigate('/'))).text()).toContain('alt')
		expect(await (await alt.fetch(navigate('/deep/route'))).text()).toContain('alt')
		await rm(base, { recursive: true, force: true })
	})

	test('no index file at all means 404, not a crash', async () => {
		const base = await mkdtemp(join(tmpdir(), 'fabrika-assets-empty-'))
		const empty = new FileSystemAssetServer(base)
		expect((await empty.fetch(navigate('/'))).status).toBe(404)
		expect((await empty.fetch(navigate('/route'))).status).toBe(404)
		await rm(base, { recursive: true, force: true })
	})
})

describe('FileSystemAssetServer — path safety', () => {
	test('a traversal out of the root is refused', async () => {
		for (const path of ['/../secret.txt', '/assets/../../secret.txt', '/%2e%2e/secret.txt', '/..%2Fsecret.txt']) {
			const response = await server({ spaFallback: false }).fetch(asset(path))
			expect(response.status).toBe(404)
		}
	})

	test('a traversal never leaks file contents through the fallback either', async () => {
		const response = await server().fetch(navigate('/../secret.txt'))
		// It may render the SPA shell (it is a document request), but it must never be the outside file.
		expect(await response.text()).not.toContain('do not serve me')
	})

	test('a NUL byte in the path is a bad request', async () => {
		const response = await server().fetch(asset('/index%00.html'))
		expect(response.status).toBe(400)
	})

	test('a malformed percent-escape is a bad request', async () => {
		const response = await server().fetch(asset('/%E0%A4%A.html'))
		expect(response.status).toBe(400)
	})

	test('a sibling directory with the same prefix is not inside the root', async () => {
		// `<root>-evil` starts with the root string but is NOT under it; the separator check is what
		// distinguishes them.
		const evil = `${root}-evil`
		await Bun.write(join(evil, 'index.html'), 'evil')
		const response = await server().fetch(navigate('/../dist-evil/index.html'))
		expect(await response.text()).not.toContain('evil')
		await rm(evil, { recursive: true, force: true })
	})
})
