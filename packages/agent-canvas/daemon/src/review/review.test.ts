import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { connect } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { renderReviewRequests } from './markdown'
import { isLoopbackOrigin, type ReviewAnchor } from './model'
import { ReviewProxies, viteFullReloadPath } from './proxy'
import { createReviewServer } from './server'
import { ReviewStore } from './store'

const WIDGET = 'http://localhost:19400/assets/review.js'

const anchor: ReviewAnchor = {
	url: 'http://localhost:4317/#/products',
	selector: 'main > button:nth-of-type(2)',
	role: 'button',
	name: 'Save',
	components: ['ProductPage', 'SaveBar'],
}

let directory: string
let store: ReviewStore

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'review-test-'))
	store = new ReviewStore(directory)
})

afterEach(() => {
	rmSync(directory, { recursive: true, force: true })
})

describe('ReviewStore', () => {
	test('a note stays open until it is sent, and the agent claims it once', () => {
		const note = store.create('demo', anchor, 'Make it green', false)
		expect(note.state).toBe('open')
		expect(store.claimQueued('demo')).toEqual([])

		store.send('demo', note.id)
		const claimed = store.claimQueued('demo')
		expect(claimed.map((thread) => [thread.id, thread.state])).toEqual([[note.id, 'working']])
		expect(store.claimQueued('demo')).toEqual([])
	})

	test('sending notes queues every unsent note and leaves answered threads with the reviewer', () => {
		const first = store.create('demo', anchor, 'Make it green', false)
		const second = store.create('demo', anchor, 'Too much padding', false)
		const answered = store.create('demo', anchor, 'Why is this red?', true)
		store.claimQueued('demo')
		store.agentReply('demo', answered.id, 'Which shade do you want?', false)

		expect(store.sendNotes('demo').map((thread) => thread.id)).toEqual([first.id, second.id])
		expect(store.claimQueued('demo').map((thread) => thread.id)).toEqual([first.id, second.id])
		expect(store.list('demo').find((thread) => thread.id === answered.id)?.state).toBe('open')
		expect(store.sendNotes('demo')).toEqual([])
	})

	test('an agent reply resolves the thread or hands it back to the reviewer', () => {
		const thread = store.create('demo', anchor, 'Rename it', true)
		store.claimQueued('demo')

		expect(store.agentReply('demo', thread.id, 'Which name?', false).state).toBe('open')
		const resolved = store.agentReply('demo', thread.id, 'Renamed to Publish', true)
		expect(resolved.state).toBe('resolved')
		expect(resolved.comments.map((comment) => comment.author)).toEqual(['user', 'agent', 'agent'])
	})

	test('a reviewer comment reopens a resolved thread unless it is sent', () => {
		const thread = store.create('demo', anchor, 'Rename it', false)
		store.setResolved('demo', thread.id, true)
		expect(store.addUserComment('demo', thread.id, 'Not quite', false).state).toBe('open')
		expect(store.addUserComment('demo', thread.id, 'Try again', true).state).toBe('queued')
	})

	test('a thread the agent works on cannot be sent again', () => {
		const thread = store.create('demo', anchor, 'Rename it', true)
		store.claimQueued('demo')
		expect(() => store.send('demo', thread.id)).toThrow('already working')
	})

	test('an attached screenshot is stored beside the threads and removed with its thread', () => {
		const png = new Uint8Array([137, 80, 78, 71])
		const thread = store.create('demo', anchor, 'Misaligned', true, png)
		expect(thread.screenshot).toBe(join(directory, 'demo', 'screenshots', `${thread.id}.png`))
		expect([...readFileSync(thread.screenshot ?? '')]).toEqual([...png])
		store.delete('demo', thread.id)
		expect(existsSync(thread.screenshot ?? '')).toBe(false)
	})

	test('projects are separate and their names cannot leave the directory', () => {
		store.create('one', anchor, 'A', false)
		expect(store.list('two')).toEqual([])
		expect(() => store.list('../escape')).toThrow('Invalid project name')
	})
})

describe('renderReviewRequests', () => {
	test('names the page, the element and the reply command', () => {
		const thread = store.create('demo', anchor, 'Make it green', true)
		const markdown = renderReviewRequests('demo', [thread])
		expect(markdown).toContain(`## 1. Thread ${thread.id}`)
		expect(markdown).toContain('- Page: http://localhost:4317/#/products')
		expect(markdown).toContain('- Element: button "Save"')
		expect(markdown).toContain('- Components: ProductPage › SaveBar')
		expect(markdown).toContain('> Make it green')
		expect(markdown).toContain('review reply <thread-id>')
	})

	test('adds source positions, landmarks, the screenshot and fenced markup', () => {
		const thread = store.create(
			'demo',
			{
				...anchor,
				context: 'Page "Products" › Dialog "Edit price"',
				sources: [{ label: '<button> in SaveBar', file: '/app/src/SaveBar.tsx', line: 12, column: 7 }],
				html: '<button class="primary">Save ```</button>',
			},
			'Make it green',
			true,
			new Uint8Array([1]),
		)
		const markdown = renderReviewRequests('demo', [thread])
		expect(markdown).toContain('- Where: Page "Products" › Dialog "Edit price"')
		expect(markdown).toContain('  - <button> in SaveBar: `/app/src/SaveBar.tsx:12:7`')
		expect(markdown).toContain(`- Screenshot, the element outlined in red: \`${thread.screenshot}\``)
		expect(markdown).toContain('````html\n<button class="primary">Save ```</button>\n````')
	})

	test('adds the browser and the computed style, and leaves out text that repeats the name', () => {
		const thread = store.create(
			'demo',
			{
				...anchor,
				text: 'Save',
				browser: { name: 'Chrome 141 · Linux', viewport: { width: 1512, height: 982, scale: 2 }, colorScheme: 'dark' },
				style: 'display: flex; gap: 4px',
			},
			'Make it green',
			true,
		)
		const markdown = renderReviewRequests('demo', [thread])
		expect(markdown).toContain('- Browser: Chrome 141 · Linux, viewport 1512×982 @2x, dark color scheme')
		expect(markdown).toContain('- Computed style: `display: flex; gap: 4px`')
		expect(markdown).not.toContain('- Text:')
	})
})

describe('isLoopbackOrigin', () => {
	test('accepts loopback hosts only', () => {
		expect(isLoopbackOrigin('http://localhost:4317')).toBe(true)
		expect(isLoopbackOrigin('http://127.0.0.1:3000')).toBe(true)
		expect(isLoopbackOrigin('http://app.localhost:8080')).toBe(true)
		expect(isLoopbackOrigin('https://example.com')).toBe(false)
		expect(isLoopbackOrigin('http://localhost.example.com')).toBe(false)
		expect(isLoopbackOrigin('null')).toBe(false)
	})
})

describe('review routes', () => {
	const noUpgrade = { upgrade: () => false }

	async function call(method: string, path: string, options: { origin?: string; body?: unknown } = {}) {
		const proxies = new ReviewProxies(store, WIDGET, () => {})
		const review = createReviewServer(store, proxies)
		const headers = new Headers({ 'Content-Type': 'application/json' })
		if (options.origin !== undefined) headers.set('Origin', options.origin)
		const req = new Request(`http://localhost:19400${path}`, {
			method,
			headers,
			...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
		})
		const result = review.fetch(req, new URL(req.url), noUpgrade)
		review.channel.stop()
		proxies.stop()
		if (result === null || result === 'upgraded') throw new Error(`${method} ${path} was not a review route`)
		return await result
	}

	test('the widget creates a thread and the agent claims it as markdown', async () => {
		const created = await call('POST', '/api/review/demo/threads', {
			origin: 'http://localhost:4317',
			body: { anchor, body: 'Make it green', send: true },
		})
		expect(created.status).toBe(200)
		expect(created.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:4317')

		const claimed = await call('POST', '/api/review/demo/claim')
		const body: unknown = await claimed.json()
		expect(body).toMatchObject({ found: true })
		expect(JSON.stringify(body)).toContain('Make it green')
	})

	test('a screenshot arrives as a PNG data URL and is stored as a file', async () => {
		const screenshot = `data:image/png;base64,${btoa(String.fromCharCode(137, 80, 78, 71))}`
		const created = await call('POST', '/api/review/demo/threads', {
			origin: 'http://localhost:4317',
			body: { anchor, body: 'Misaligned', send: false, screenshot },
		})
		expect(created.status).toBe(200)
		const [thread] = store.list('demo')
		expect([...readFileSync(thread?.screenshot ?? '')]).toEqual([137, 80, 78, 71])
	})

	test('the widget sends all notes in one request', async () => {
		store.create('demo', anchor, 'Make it green', false)
		store.create('demo', anchor, 'Too much padding', false)

		const sent = await call('POST', '/api/review/demo/notes/send', { origin: 'http://localhost:4317' })
		expect(sent.status).toBe(200)
		expect(store.list('demo').map((thread) => thread.state)).toEqual(['queued', 'queued'])
	})

	test('a foreign origin cannot create a thread', async () => {
		const response = await call('POST', '/api/review/demo/threads', {
			origin: 'https://example.com',
			body: { anchor, body: 'Delete everything', send: true },
		})
		expect(response.status).toBe(403)
		expect(store.list('demo')).toEqual([])
	})

	test('a browser cannot call the agent endpoints', async () => {
		store.create('demo', anchor, 'Make it green', true)
		const response = await call('POST', '/api/review/demo/claim', { origin: 'http://localhost:4317' })
		expect(response.status).toBe(403)
	})

	test('the proxy forwards to applications on this machine only', async () => {
		const response = await call('POST', '/api/review/demo/proxy', { body: { target: 'https://example.com/' } })
		expect(response.status).toBe(400)
		expect(JSON.stringify(await response.json())).toContain('localhost')
	})

	test('an invalid body is a 400 with the failing field', async () => {
		const response = await call('POST', '/api/review/demo/threads', { origin: 'http://localhost:4317', body: { anchor, body: '  ', send: false } })
		expect(response.status).toBe(400)
		expect(JSON.stringify(await response.json())).toContain('body')
	})
})

describe('viteFullReloadPath', () => {
	test('reads the path of a full reload and ignores every other frame', () => {
		expect(viteFullReloadPath('{"type":"full-reload","path":"/about.html","triggeredBy":"/src/a.ts"}')).toBe('/about.html')
		expect(viteFullReloadPath('{"type":"full-reload"}')).toBe('*')
		expect(viteFullReloadPath('{"type":"update","updates":[{"path":"full-reload.ts"}]}')).toBeUndefined()
		expect(viteFullReloadPath('full-reload')).toBeUndefined()
	})
})

describe('ReviewProxies', () => {
	let app: Bun.Server<undefined>
	let proxies: ReviewProxies
	let reloads: Array<[string, string]>
	let appHits: number

	beforeEach(() => {
		reloads = []
		appHits = 0
		// One address, not a name: `localhost` may resolve to both families, and once the app stops, a connection to its
		// port on the other family can reach another test's server.
		app = Bun.serve<undefined>({
			port: 0,
			hostname: '127.0.0.1',
			fetch(req, server) {
				appHits++
				const url = new URL(req.url)
				if (url.pathname === '/hmr') {
					return server.upgrade(req, { data: undefined, headers: { 'Sec-WebSocket-Protocol': 'vite-hmr' } })
						? undefined
						: new Response(null, { status: 400 })
				}
				if (url.pathname === '/socket') return server.upgrade(req, { data: undefined }) ? undefined : new Response(null, { status: 400 })
				if (url.pathname === '/old') return Response.redirect(`${url.origin}/new`, 302)
				// Raw headers: `Response.redirect` would refuse a port past 65535.
				if (url.pathname === '/away') return new Response(null, { status: 302, headers: { Location: `${url.origin}0/x` } })
				if (url.pathname === '/userinfo') return new Response(null, { status: 302, headers: { Location: `${url.origin}@example.com/x` } })
				if (url.pathname === '/data.json') return Response.json({ search: url.search })
				if (url.pathname.includes('127.0.0.1:')) return new Response(`app ${url.pathname}${url.search}`)
				return new Response('<html><body><h1>App</h1></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
			},
			websocket: {
				message(socket, message) {
					if (message === 'edit') {
						socket.send(JSON.stringify({ type: 'full-reload', path: '*' }))
						socket.send(JSON.stringify({ type: 'update', updates: [] }))
						return
					}
					socket.send(`echo ${String(message)}`)
				},
			},
		})
		proxies = new ReviewProxies(store, WIDGET, (project, path) => reloads.push([project, path]))
	})

	afterEach(async () => {
		proxies.stop()
		await app.stop(true)
	})

	test('serves the application with the widget on its HTML pages and nothing else changed', async () => {
		const url = proxies.open('demo', `http://localhost:${app.port}/admin?tab=1`)
		expect(url).toMatch(/^http:\/\/localhost:\d+\/admin\?tab=1$/)
		expect(await (await fetch(url)).text()).toBe(`<html><body><h1>App</h1><script src="${WIDGET}" data-project="demo"></script></body></html>`)
		expect(await (await fetch(new URL('/data.json?x=1', url))).json()).toEqual({ search: '?x=1' })
	})

	test('keeps redirects on the proxy', async () => {
		const origin = new URL(proxies.open('demo', `http://127.0.0.1:${app.port}/`)).origin
		const response = await fetch(`${origin}/old`, { redirect: 'manual' })
		expect(response.headers.get('Location')).toBe(`${origin}/new`)
	})

	test('leaves a redirect to another origin as it is, however its prefix reads', async () => {
		const origin = new URL(proxies.open('demo', `http://127.0.0.1:${app.port}/`)).origin
		const away = await fetch(`${origin}/away`, { redirect: 'manual' })
		expect(away.headers.get('Location')).toBe(`http://127.0.0.1:${app.port}0/x`)
		const userinfo = await fetch(`${origin}/userinfo`, { redirect: 'manual' })
		expect(userinfo.headers.get('Location')).toBe(`http://127.0.0.1:${app.port}@example.com/x`)
	})

	async function echoThrough(url: string, protocols: string[]): Promise<{ protocol: string; reply: string }> {
		const socket = new WebSocket(url, protocols)
		const reply = await new Promise<string>((resolve, reject) => {
			socket.onopen = () => socket.send('ping')
			socket.onmessage = (event) => resolve(String(event.data))
			socket.onerror = () => reject(new Error('WebSocket failed'))
		})
		socket.close()
		return { protocol: socket.protocol, reply }
	}

	test('relays WebSockets with the subprotocol the application chose', async () => {
		const origin = new URL(proxies.open('demo', `http://127.0.0.1:${app.port}/`)).origin.replace('http:', 'ws:')
		expect(await echoThrough(`${origin}/hmr`, ['vite-hmr'])).toEqual({ protocol: 'vite-hmr', reply: 'echo ping' })
		expect(await echoThrough(`${origin}/socket`, [])).toEqual({ protocol: '', reply: 'echo ping' })
	})

	test('holds a Vite full reload back from the page and hands it to the widget', async () => {
		const origin = new URL(proxies.open('demo', `http://127.0.0.1:${app.port}/`)).origin.replace('http:', 'ws:')
		const socket = new WebSocket(`${origin}/hmr`, ['vite-hmr'])
		const first = await new Promise<string>((resolve, reject) => {
			socket.onopen = () => socket.send('edit')
			socket.onmessage = (event) => resolve(String(event.data))
			socket.onerror = () => reject(new Error('WebSocket failed'))
		})
		socket.close()
		expect(JSON.parse(first)).toEqual({ type: 'update', updates: [] })
		expect(reloads).toEqual([['demo', '*']])
	})

	/** Sends `path` as the literal request target, which `fetch` would normalise, and returns the response body. */
	function rawGet(origin: string, path: string): Promise<string> {
		const { hostname, port } = new URL(origin)
		return new Promise((resolve, reject) => {
			let response = ''
			const socket = connect(Number(port), hostname, () => {
				socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n\r\n`)
			})
			socket.on('data', (chunk) => {
				response += String(chunk)
				const headEnd = response.indexOf('\r\n\r\n')
				const length = /\r\ncontent-length: (\d+)/i.exec(response)?.[1]
				if (headEnd === -1 || length === undefined || response.length - headEnd - 4 < Number(length)) return
				socket.end()
				resolve(response.slice(headEnd + 4))
			})
			socket.on('error', reject)
		})
	}

	test('a path that names another host stays a path on the application', async () => {
		let otherHits = 0
		const other = Bun.serve<undefined>({
			port: 0,
			hostname: '127.0.0.1',
			fetch(req, server) {
				otherHits++
				return server.upgrade(req, { data: undefined }) ? undefined : new Response('other server')
			},
			websocket: { message() {} },
		})
		try {
			const origin = new URL(proxies.open('demo', `http://127.0.0.1:${app.port}/`)).origin
			// The proxy's own fetch sends a leading `//` as `/`, so the application may see one slash less.
			const onApp = new RegExp(`app /+127\\.0\\.0\\.1:${other.port}/x$`)
			expect(await rawGet(origin, `//127.0.0.1:${other.port}/x`)).toMatch(onApp)
			expect(await rawGet(origin, `/\\127.0.0.1:${other.port}/x`)).toMatch(onApp)
			const socket = new WebSocket(`${origin.replace('http:', 'ws:')}//127.0.0.1:${other.port}/x`)
			expect(
				await new Promise((resolve) => {
					socket.onopen = () => resolve('open')
					socket.onerror = () => resolve('refused')
				}),
			).toBe('refused')
			expect(otherHits).toBe(0)
		} finally {
			await other.stop(true)
		}
	})

	/** Sends one request with exactly these headers, which `fetch` and `WebSocket` would not let a test choose, and returns its status. */
	function rawStatus(origin: string, request: { method?: string; path?: string; host?: string; headers?: Record<string, string> }): Promise<number> {
		const { hostname, port } = new URL(origin)
		const lines = [`${request.method ?? 'GET'} ${request.path ?? '/'} HTTP/1.1`, `Host: ${request.host ?? `${hostname}:${port}`}`]
		for (const [name, value] of Object.entries(request.headers ?? {})) lines.push(`${name}: ${value}`)
		if (request.method === 'POST') lines.push('Content-Type: text/plain', 'Content-Length: 1')
		const body = request.method === 'POST' ? 'x' : ''
		return new Promise((resolve, reject) => {
			let response = ''
			const socket = connect(Number(port), hostname, () => socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`))
			socket.on('data', (chunk) => {
				response += String(chunk)
				const status = /^HTTP\/1\.1 (\d{3})/.exec(response)?.[1]
				if (status === undefined) return
				socket.destroy()
				resolve(Number(status))
			})
			socket.on('error', reject)
		})
	}

	const upgrade = { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }

	test('a request for another host name is refused before it reaches the application', async () => {
		const origin = new URL(proxies.open('demo', `http://127.0.0.1:${app.port}/`)).origin
		const { port } = new URL(origin)
		expect(await rawStatus(origin, { host: `attacker.example:${port}` })).toBe(403)
		expect(await rawStatus(origin, { host: 'localhost:1' })).toBe(403)
		expect(await rawStatus(origin, { path: '/socket', host: `attacker.example:${port}`, headers: upgrade })).toBe(403)
		expect(appHits).toBe(0)
	})

	test('a foreign origin cannot change state or open a socket through the proxy', async () => {
		const origin = new URL(proxies.open('demo', `http://127.0.0.1:${app.port}/`)).origin
		expect(await rawStatus(origin, { method: 'POST', headers: { Origin: 'https://attacker.example' } })).toBe(403)
		expect(await rawStatus(origin, { path: '/socket', headers: { ...upgrade, Origin: 'https://attacker.example' } })).toBe(403)
		// Another loopback port is another site's origin too, e.g. a page some other local server serves.
		expect(await rawStatus(origin, { path: '/socket', headers: { ...upgrade, Origin: `http://127.0.0.1:${app.port}` } })).toBe(403)
		// An opaque origin (a sandboxed frame, a `data:` page) is no origin of the proxy's.
		expect(await rawStatus(origin, { method: 'POST', headers: { Origin: 'null' } })).toBe(403)
		// A listed protocol beside `websocket` is still an upgrade.
		expect(await rawStatus(origin, { path: '/socket', headers: { ...upgrade, Upgrade: 'websocket, h2c', Origin: 'https://attacker.example' } }))
			.toBe(403)
		expect(appHits).toBe(0)
	})

	test("the proxy's own origin and a client without one still reach the application", async () => {
		const url = proxies.open('demo', `http://127.0.0.1:${app.port}/`)
		const origin = new URL(url).origin
		expect(await rawStatus(origin, { method: 'POST', headers: { Origin: origin } })).toBe(200)
		expect(await rawStatus(origin, { method: 'POST' })).toBe(200)
		expect(await rawStatus(origin, { path: '/socket', headers: { ...upgrade, Origin: origin } })).toBe(101)
		expect(await rawStatus(origin, { host: `127.0.0.1:${new URL(origin).port}` })).toBe(200)
		expect(await (await fetch(url)).text()).toContain(`<script src="${WIDGET}" data-project="demo"></script>`)
	})

	test('a restarted daemon serves the proxy on the same port', () => {
		const target = `http://127.0.0.1:${app.port}/`
		const url = proxies.open('demo', target)
		proxies.stop()
		proxies = new ReviewProxies(store, WIDGET, () => {})
		proxies.restore()
		expect(proxies.open('demo', target)).toBe(url)
	})

	test('a restored target with a path serves the application at its origin', async () => {
		const url = proxies.open('demo', `http://127.0.0.1:${app.port}/`)
		proxies.stop()
		store.saveProxy('demo', { target: `http://127.0.0.1:${app.port}/admin`, port: Number(new URL(url).port) })
		proxies = new ReviewProxies(store, WIDGET, () => {})
		proxies.restore()
		expect(store.proxyOf('demo')?.target).toBe(`http://127.0.0.1:${app.port}`)
		expect(await (await fetch(new URL('/data.json?x=1', url))).json()).toEqual({ search: '?x=1' })
	})

	test('an application that is not running answers 502', async () => {
		const url = proxies.open('demo', `http://127.0.0.1:${app.port}/`)
		await app.stop(true)
		const response = await fetch(url)
		expect(response.status).toBe(502)
		expect(await response.text()).toContain('Is the application running?')
	})
})
