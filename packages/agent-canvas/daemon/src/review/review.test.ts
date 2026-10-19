import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { renderReviewRequests } from './markdown'
import { isLoopbackOrigin, type ReviewAnchor } from './model'
import { ReviewProxies } from './proxy'
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
		const proxies = new ReviewProxies(store, WIDGET)
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

describe('ReviewProxies', () => {
	let app: Bun.Server<undefined>
	let proxies: ReviewProxies

	beforeEach(() => {
		app = Bun.serve<undefined>({
			port: 0,
			hostname: 'localhost',
			fetch(req, server) {
				const url = new URL(req.url)
				if (url.pathname === '/hmr') {
					return server.upgrade(req, { data: undefined, headers: { 'Sec-WebSocket-Protocol': 'vite-hmr' } })
						? undefined
						: new Response(null, { status: 400 })
				}
				if (url.pathname === '/socket') return server.upgrade(req, { data: undefined }) ? undefined : new Response(null, { status: 400 })
				if (url.pathname === '/old') return Response.redirect(`${url.origin}/new`, 302)
				if (url.pathname === '/data.json') return Response.json({ search: url.search })
				return new Response('<html><body><h1>App</h1></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
			},
			websocket: {
				message(socket, message) {
					socket.send(`echo ${String(message)}`)
				},
			},
		})
		proxies = new ReviewProxies(store, WIDGET)
	})

	afterEach(() => {
		proxies.stop()
		app.stop(true)
	})

	test('serves the application with the widget on its HTML pages and nothing else changed', async () => {
		const url = proxies.open('demo', `http://localhost:${app.port}/admin?tab=1`)
		expect(url).toMatch(/^http:\/\/localhost:\d+\/admin\?tab=1$/)
		expect(await (await fetch(url)).text()).toBe(`<html><body><h1>App</h1><script src="${WIDGET}" data-project="demo"></script></body></html>`)
		expect(await (await fetch(new URL('/data.json?x=1', url))).json()).toEqual({ search: '?x=1' })
	})

	test('keeps redirects on the proxy', async () => {
		const origin = new URL(proxies.open('demo', `http://localhost:${app.port}/`)).origin
		const response = await fetch(`${origin}/old`, { redirect: 'manual' })
		expect(response.headers.get('Location')).toBe(`${origin}/new`)
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
		const origin = new URL(proxies.open('demo', `http://localhost:${app.port}/`)).origin.replace('http:', 'ws:')
		expect(await echoThrough(`${origin}/hmr`, ['vite-hmr'])).toEqual({ protocol: 'vite-hmr', reply: 'echo ping' })
		expect(await echoThrough(`${origin}/socket`, [])).toEqual({ protocol: '', reply: 'echo ping' })
	})

	test('a restarted daemon serves the proxy on the same port', () => {
		const target = `http://localhost:${app.port}/`
		const url = proxies.open('demo', target)
		proxies.stop()
		proxies = new ReviewProxies(store, WIDGET)
		proxies.restore()
		expect(proxies.open('demo', target)).toBe(url)
	})

	test('an application that is not running answers 502', async () => {
		const url = proxies.open('demo', `http://localhost:${app.port}/`)
		app.stop(true)
		const response = await fetch(url)
		expect(response.status).toBe(502)
		expect(await response.text()).toContain('Is the application running?')
	})
})
