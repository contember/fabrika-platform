import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { renderReviewRequests } from './markdown'
import type { ReviewAnchor } from './model'
import { createReviewServer, isLoopbackOrigin } from './server'
import { ReviewStore } from './store'

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
		const review = createReviewServer(store)
		const headers = new Headers({ 'Content-Type': 'application/json' })
		if (options.origin !== undefined) headers.set('Origin', options.origin)
		const req = new Request(`http://localhost:19400${path}`, {
			method,
			headers,
			...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
		})
		const result = review.fetch(req, new URL(req.url), noUpgrade)
		review.channel.stop()
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

	test('an invalid body is a 400 with the failing field', async () => {
		const response = await call('POST', '/api/review/demo/threads', { origin: 'http://localhost:4317', body: { anchor, body: '  ', send: false } })
		expect(response.status).toBe(400)
		expect(JSON.stringify(await response.json())).toContain('body')
	})
})
