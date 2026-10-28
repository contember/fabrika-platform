// Remote review projects in the worker: Lopata runs the Worker, the project's Durable Object, its WebSockets and the R2
// bucket in process. The worker only ever sees sealed strings, so these tests seal nothing: any base64 will do.

import { sealedThreadSchema, sealedThreadsSchema } from 'agent-canvas/review/remote'
import { openThread, sealAnchor, sealText } from 'agent-canvas/review/sealing'
import { afterEach, describe, expect, test } from 'bun:test'
import { createTestEnv, type TestEnv } from 'lopata/testing'
import { z } from 'zod'
import worker, { ReviewProject } from './index'

const APP = 'https://app.example.com'
const SHARE_TOKEN = 'share-token'
const createdSchema = z.object({ projectId: z.string(), agentToken: z.string() })
const threadResponseSchema = z.object({ thread: sealedThreadSchema })

const deployed: TestEnv[] = []
afterEach(() => {
	for (const env of deployed.splice(0)) env.dispose()
})

function sealed(text: string): string {
	return btoa(`${text}:${'x'.repeat(40)}`)
}

async function setUp() {
	const testEnv = await createTestEnv({
		worker: { default: worker, ReviewProject },
		bindings: { REVIEWS: { type: 'durable-object', className: 'ReviewProject' }, BLOBS: 'r2', FEEDBACK: 'kv' },
		vars: { SHARE_AUTH_TOKEN: SHARE_TOKEN },
	})
	deployed.push(testEnv)
	const response = await testEnv.fetch('https://share.test/reviews', {
		method: 'POST',
		headers: { Authorization: `Bearer ${SHARE_TOKEN}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ origins: [APP] }),
	})
	expect(response.status).toBe(201)
	const { projectId, agentToken } = createdSchema.parse(await response.json())
	const base = `https://share.test/review/${projectId}`

	const browser = (path: string, init: RequestInit = {}, origin = APP) =>
		testEnv.fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Origin: origin, ...init.headers } })
	const agent = (path: string, init: RequestInit = {}, token = agentToken) =>
		testEnv.fetch(`${base}/agent${path}`, {
			...init,
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init.headers },
		})
	const createThread = async (send: boolean, screenshot?: string) => {
		const created = await browser('/threads', {
			method: 'POST',
			body: JSON.stringify({ anchor: sealed('anchor'), body: sealed('Make it green'), send, ...(screenshot === undefined ? {} : { screenshot }) }),
		})
		expect(created.status).toBe(200)
		return threadResponseSchema.parse(await created.json()).thread
	}
	return { testEnv, projectId, agentToken, browser, agent, createThread }
}

describe('creating a review project', () => {
	test('needs the share token when the worker has one', async () => {
		const { testEnv } = await setUp()
		const refused = await testEnv.fetch('https://share.test/reviews', { method: 'POST', body: JSON.stringify({ origins: [APP] }) })
		expect(refused.status).toBe(401)
	})

	test('accepts only origins', async () => {
		const { testEnv } = await setUp()
		const refused = await testEnv.fetch('https://share.test/reviews', {
			method: 'POST',
			headers: { Authorization: `Bearer ${SHARE_TOKEN}` },
			body: JSON.stringify({ origins: ['https://app.example.com/path'] }),
		})
		expect(refused.status).toBe(400)
	})

	test('an unknown project id answers 404', async () => {
		const { testEnv } = await setUp()
		const response = await testEnv.fetch(`https://share.test/review/${'0'.repeat(24)}/threads`, { headers: { Origin: APP } })
		expect(response.status).toBe(404)
	})
})

describe('browser access', () => {
	test('only the allowed origin may call the project, and it gets CORS for itself alone', async () => {
		const { browser } = await setUp()
		expect((await browser('/threads', {}, 'https://elsewhere.example.com')).status).toBe(403)
		const preflight = await browser('/threads', { method: 'OPTIONS' })
		expect(preflight.status).toBe(204)
		expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(APP)
		const listed = await browser('/threads')
		expect(listed.headers.get('Access-Control-Allow-Origin')).toBe(APP)
		expect(sealedThreadsSchema.parse(await listed.json()).threads).toEqual([])
	})

	test('a request without an origin is not a browser request', async () => {
		const { testEnv, projectId } = await setUp()
		expect((await testEnv.fetch(`https://share.test/review/${projectId}/threads`)).status).toBe(403)
	})

	test('refuses a body that is not sealed', async () => {
		const { browser } = await setUp()
		const response = await browser('/threads', { method: 'POST', body: JSON.stringify({ anchor: '{"url":"x"}', body: 'plain text', send: true }) })
		expect(response.status).toBe(400)
	})

	test('cannot reach the agent routes', async () => {
		const { agent } = await setUp()
		expect((await agent('/claim', { method: 'POST' }, 'guess')).status).toBe(401)
	})
})

describe('the thread lifecycle', () => {
	test('a sent thread is claimed once, and the reply goes back to the browser', async () => {
		const { browser, agent, createThread } = await setUp()
		const note = await createThread(false)
		const thread = await createThread(true)

		const claimed = sealedThreadsSchema.parse(await (await agent('/claim', { method: 'POST' })).json()).threads
		expect(claimed.map((candidate) => [candidate.id, candidate.state])).toEqual([[thread.id, 'working']])
		expect(sealedThreadsSchema.parse(await (await agent('/claim', { method: 'POST' })).json()).threads).toEqual([])

		const replied = await agent(`/threads/${thread.id}/reply`, { method: 'POST', body: JSON.stringify({ body: sealed('Done'), resolve: true }) })
		expect(threadResponseSchema.parse(await replied.json()).thread.state).toBe('resolved')

		const listed = sealedThreadsSchema.parse(await (await browser('/threads')).json()).threads
		expect(listed.map((candidate) => [candidate.id, candidate.state, candidate.comments.map((comment) => comment.author)])).toEqual([
			[note.id, 'open', ['user']],
			[thread.id, 'resolved', ['user', 'agent']],
		])
	})

	test('sending notes queues every unsent note', async () => {
		const { browser, agent, createThread } = await setUp()
		const first = await createThread(false)
		const second = await createThread(false)
		await browser('/notes/send', { method: 'POST' })
		const claimed = sealedThreadsSchema.parse(await (await agent('/claim', { method: 'POST' })).json()).threads
		expect(claimed.map((thread) => thread.id)).toEqual([first.id, second.id])
	})

	test('a thread the agent is working on cannot be sent again', async () => {
		const { browser, agent, createThread } = await setUp()
		const thread = await createThread(true)
		await agent('/claim', { method: 'POST' })
		expect((await browser(`/threads/${thread.id}/send`, { method: 'POST' })).status).toBe(409)
	})

	test("the screenshot is the agent's to read, and goes with its thread", async () => {
		const { browser, agent, createThread, testEnv, projectId } = await setUp()
		const screenshot = sealed('png')
		const thread = await createThread(true, screenshot)
		expect(thread.screenshot).toBe(true)
		expect((await browser(`/threads/${thread.id}/screenshot`)).status).toBe(404)
		const read = await agent(`/threads/${thread.id}/screenshot`)
		expect(z.object({ screenshot: z.string() }).parse(await read.json()).screenshot).toBe(screenshot)

		await browser(`/threads/${thread.id}`, { method: 'DELETE' })
		const bucket: unknown = testEnv.env['BLOBS']
		const get: unknown = typeof bucket === 'object' && bucket !== null ? Reflect.get(bucket, 'get') : undefined
		if (typeof get !== 'function') throw new Error('no R2 bucket')
		expect(await Reflect.apply(get, bucket, [`reviews/${projectId}/screenshots/${thread.id}`])).toBeNull()
		expect((await agent(`/threads/${thread.id}/screenshot`)).status).toBe(404)
	})
})

describe('end-to-end encryption', () => {
	test('what the browser seals, the agent opens, and the worker keeps none of it readable', async () => {
		const { testEnv, browser, agent, projectId } = await setUp()
		const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
		const anchor = { url: 'https://app.example.com/orders', selector: 'main > h1', role: 'heading', name: 'Orders overview' }
		await browser('/threads', {
			method: 'POST',
			body: JSON.stringify({
				anchor: await sealAnchor(key, anchor),
				body: await sealText(key, 'Make the header green'),
				send: true,
				screenshot: await sealText(key, 'data:image/png;base64,c2NyZWVuc2hvdA=='),
			}),
		})

		const [claimed] = sealedThreadsSchema.parse(await (await agent('/claim', { method: 'POST' })).json()).threads
		if (claimed === undefined) throw new Error('nothing claimed')
		const opened = await openThread(key, claimed)
		expect(opened.anchor).toEqual(anchor)
		expect(opened.comments.map((comment) => comment.body)).toEqual(['Make the header green'])

		const stored: string[] = []
		for (const { name } of testEnv.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
			stored.push(JSON.stringify(testEnv.db.query(`SELECT * FROM "${name}"`).all()))
		}
		const bucket: unknown = testEnv.env['BLOBS']
		const get: unknown = typeof bucket === 'object' && bucket !== null ? Reflect.get(bucket, 'get') : undefined
		if (typeof get !== 'function') throw new Error('no R2 bucket')
		const object: unknown = await Reflect.apply(get, bucket, [`reviews/${projectId}/screenshots/${claimed.id}`])
		const text: unknown = typeof object === 'object' && object !== null ? Reflect.get(object, 'text') : undefined
		if (typeof text !== 'function') throw new Error('no screenshot')
		stored.push(String(await Reflect.apply(text, object, [])))

		const everything = stored.join('\n')
		expect(everything).toContain(claimed.id)
		for (const plaintext of ['green', 'Orders overview', 'app.example.com/orders', 'c2NyZWVuc2hvdA']) expect(everything).not.toContain(plaintext)
	})
})

describe('sockets', () => {
	test('browsers see the agent listening, and a waiting agent wakes when a thread is sent', async () => {
		const { testEnv, projectId, agentToken, createThread } = await setUp()
		const project = testEnv.durableObject('REVIEWS').get(projectId)
		const page = await project.connectWebSocket({ path: `/review/${projectId}/ws`, headers: { Origin: APP } })
		expect(JSON.parse(String(await page.waitForMessage()))).toEqual({ type: 'agent-status', watching: false })

		const waiting = await project.connectWebSocket({
			path: `/review/${projectId}/agent/ws`,
			headers: { 'Sec-WebSocket-Protocol': `agent-canvas-review, ${agentToken}` },
		})
		expect(JSON.parse(String(await page.waitForMessage()))).toEqual({ type: 'agent-status', watching: true })

		await createThread(true)
		expect(JSON.parse(String(await waiting.waitForMessage()))).toEqual({ type: 'queued' })
		expect(JSON.parse(String(await page.waitForMessage()))).toMatchObject({ type: 'threads' })

		waiting.close()
		await waiting.waitForClose()
		expect(JSON.parse(String(await page.waitForMessage()))).toEqual({ type: 'agent-status', watching: false })
	})

	test('an agent socket without the token is refused', async () => {
		const { testEnv, projectId } = await setUp()
		const project = testEnv.durableObject('REVIEWS').get(projectId)
		await expect(
			project.connectWebSocket({ path: `/review/${projectId}/agent/ws`, headers: { 'Sec-WebSocket-Protocol': 'agent-canvas-review, guess' } }),
		).rejects
			.toThrow()
	})

	test('a browser socket from another origin is refused', async () => {
		const { testEnv, projectId } = await setUp()
		const project = testEnv.durableObject('REVIEWS').get(projectId)
		await expect(project.connectWebSocket({ path: `/review/${projectId}/ws`, headers: { Origin: 'https://elsewhere.example.com' } })).rejects.toThrow()
	})
})
