import { SessionManager } from '@fabrika/canvas-kernel/server'
import { dispatch, type Route } from '@fabrika/daemon-kit'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createThreadHandlers } from './handlers/threads'
import { CanvasThreadStore } from './threads'

const testDirectories: string[] = []

afterEach(() => {
	for (const directory of testDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function setup() {
	const directory = mkdtempSync(join(tmpdir(), 'agent-canvas-threads-'))
	testDirectories.push(directory)
	const sessionManager = new SessionManager(directory)
	sessionManager.upsert('plan', new Map([['plan.jsx', '<Section title="Plan" />']]), directory)
	sessionManager.saveFeedback('plan', 1, 'feedback', [
		{ id: 'ann-1', snippet: 'Ship the beta', note: 'too early?', canvasFile: 'plan.jsx' },
		{ id: 'ann-2', snippet: 'Rollout', note: '' },
	])
	const broadcasts: unknown[] = []
	const notices: unknown[] = []
	const routes = createThreadHandlers({
		store: new CanvasThreadStore(sessionManager, () => new Date('2026-11-12T10:00:00.000Z')),
		broadcast: (_sessionId, frame) => broadcasts.push(frame),
		notifyWaiters: (_sessionId, frame) => notices.push(frame),
	})
	return { routes, broadcasts, notices, sessionManager }
}

async function call(routes: Route[], method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
	const url = new URL(`http://localhost:19400${path}`)
	const init = body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
	const response = await dispatch(routes, new Request(url, init), url)
	if (!response) throw new Error(`No route for ${method} ${path}`)
	return { status: response.status, json: await response.json() }
}

describe('canvas threads', () => {
	test('the agent opens a thread by answering a submitted annotation', async () => {
		const { routes, broadcasts } = setup()
		const reply = await call(routes, 'POST', '/api/session/plan/threads/ann-1/reply', { body: 'Yes, moved to Q3.', resolve: false })
		expect(reply.status).toBe(200)

		const { json } = await call(routes, 'GET', '/api/session/plan/threads')
		expect(json).toMatchObject({
			threads: [{
				id: 'ann-1',
				state: 'open',
				revision: 1,
				snippet: 'Ship the beta',
				canvasFile: 'plan.jsx',
				comments: [{ author: 'user', body: 'too early?' }, { author: 'agent', body: 'Yes, moved to Q3.' }],
			}],
		})
		expect(broadcasts).toHaveLength(1)
	})

	test('an annotation with no note opens with only the answer', async () => {
		const { routes } = setup()
		const { json } = await call(routes, 'POST', '/api/session/plan/threads/ann-2/reply', { body: 'Done.', resolve: true })
		expect(json).toMatchObject({ thread: { state: 'resolved', comments: [{ author: 'agent', body: 'Done.' }] } })
	})

	test('refuses an annotation that was never submitted, and an unknown session', async () => {
		const { routes } = setup()
		expect((await call(routes, 'POST', '/api/session/plan/threads/ann-9/reply', { body: 'x', resolve: false })).status).toBe(404)
		expect((await call(routes, 'POST', '/api/session/other/threads/ann-1/reply', { body: 'x', resolve: false })).status).toBe(404)
		expect((await call(routes, 'GET', '/api/session/other/threads')).status).toBe(404)
		expect((await call(routes, 'POST', '/api/session/plan/threads/ann-1/comments', { body: 'no thread yet' })).status).toBe(404)
	})

	test("the user's answer reaches the agent once", async () => {
		const { routes, notices } = setup()
		await call(routes, 'POST', '/api/session/plan/threads/ann-1/reply', { body: 'Moved to Q3.', resolve: true })
		const comment = await call(routes, 'POST', '/api/session/plan/threads/ann-1/comments', { body: 'Q4 is safer.' })
		expect(comment.json).toMatchObject({ thread: { state: 'queued' } })
		expect(notices).toEqual([{ type: 'thread-queued' }])

		const claimed = await call(routes, 'POST', '/api/session/plan/threads/claim')
		const markdown = markdownOf(claimed.json)
		expect(markdown).toContain('### Annotation `ann-1` in plan.jsx (revision 1)')
		expect(markdown).toContain('**User:** Q4 is safer.')
		expect(markdown).toContain('agent-canvas reply <annotation-id>')
		expect((await call(routes, 'POST', '/api/session/plan/threads/claim')).json).toEqual({ markdown: null })
	})

	test('the user resolves and reopens a thread; an empty answer is refused', async () => {
		const { routes } = setup()
		await call(routes, 'POST', '/api/session/plan/threads/ann-1/reply', { body: 'Moved.', resolve: false })
		expect((await call(routes, 'POST', '/api/session/plan/threads/ann-1/resolved', { resolved: true })).json).toMatchObject({
			thread: { state: 'resolved' },
		})
		expect((await call(routes, 'POST', '/api/session/plan/threads/ann-1/resolved', { resolved: false })).json).toMatchObject({
			thread: { state: 'open' },
		})
		expect((await call(routes, 'POST', '/api/session/plan/threads/ann-1/comments', { body: '   ' })).status).toBe(400)
	})

	test('threads go with the session', async () => {
		const { routes, sessionManager } = setup()
		await call(routes, 'POST', '/api/session/plan/threads/ann-1/reply', { body: 'Moved.', resolve: false })
		sessionManager.remove('plan')
		sessionManager.upsert('plan', new Map([['plan.jsx', '<Section title="Plan" />']]), process.cwd())
		expect((await call(routes, 'GET', '/api/session/plan/threads')).json).toEqual({ threads: [] })
	})
})

function markdownOf(json: unknown): string {
	if (typeof json === 'object' && json !== null && 'markdown' in json && typeof json.markdown === 'string') return json.markdown
	throw new Error(`Expected markdown, got ${JSON.stringify(json)}`)
}
