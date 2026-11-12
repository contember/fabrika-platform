import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from './session'
import { type CanvasSocket, createWebSocketManager, type WSData } from './websocket'

const testDirectories: string[] = []

afterEach(() => {
	for (const directory of testDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

class FakeSocket implements CanvasSocket {
	readonly sent: string[] = []
	closed = false

	constructor(readonly data: WSData) {}

	send(message: string) {
		this.sent.push(message)
	}

	close() {
		this.closed = true
	}

	ping() {}
}

function createSessionManager(): SessionManager {
	const directory = mkdtempSync(join(tmpdir(), 'agent-canvas-websocket-test-'))
	testDirectories.push(directory)
	const manager = new SessionManager(directory)
	manager.upsert(
		'session',
		new Map([['architecture.jsx', '<Section title="Architecture" />']]),
		directory,
	)
	return manager
}

describe('submitted answers', () => {
	test('stores the parsed answers beside the feedback and relays them; a later submission without answers clears them', () => {
		const manager = createSessionManager()
		const websocket = createWebSocketManager(manager, { feedbackConsumption: 'external' })
		const browser = new FakeSocket({ type: 'browser', sessionId: 'session' })
		const waiter = new FakeSocket({ type: 'wait', sessionId: 'session' })
		websocket.handlers.open(browser)
		websocket.handlers.open(waiter)

		const responses = [{ id: 'verdict', value: 'Approve' }, { id: 'tags', value: ['a', 'b'] }, { id: 'broken', value: { nested: true } }, 'junk']
		websocket.handlers.message(browser, JSON.stringify({ type: 'submit', feedback: 'ok', responses }))

		const parsed = [{ id: 'verdict', value: 'Approve' }, { id: 'tags', value: ['a', 'b'] }]
		expect(manager.getFeedback('session', 1)).toBe('ok')
		expect(manager.getSubmittedResponses('session', 1)).toEqual(parsed)
		expect(waiter.sent).toEqual([JSON.stringify({ type: 'submit', feedback: 'ok', responses: parsed })])

		websocket.handlers.message(browser, JSON.stringify({ type: 'submit', feedback: 'again' }))
		expect(manager.getSubmittedResponses('session', 1)).toEqual([])
	})
})

describe('canvas render errors', () => {
	test('rejects malformed frames and keeps render error extension fields on delivery', () => {
		const manager = createSessionManager()
		const websocket = createWebSocketManager(manager)
		const browser = new FakeSocket({ type: 'browser', sessionId: 'session' })
		const waiter = new FakeSocket({ type: 'wait', sessionId: 'session' })
		websocket.handlers.open(browser)
		websocket.handlers.open(waiter)
		for (
			const frame of [
				null,
				[],
				{ type: 'submit', feedback: 42 },
				{ type: 'render-error', error: { revision: 1.5, filename: 'architecture.jsx', message: 'bad' } },
				{ type: 'render-error', error: { revision: 1, filename: 'architecture.jsx', message: 'bad', stack: null } },
				{ type: 'render-error', error: { revision: 2, filename: 'architecture.jsx', message: 'stale' } },
				{ type: 'render-error', error: { revision: 1, filename: 'foreign.jsx', message: 'foreign' } },
			]
		) websocket.handlers.message(browser, JSON.stringify(frame))
		expect(waiter.sent).toEqual([])
		expect(manager.getFeedback('session', 1)).toBeNull()
		const error = { revision: 1, filename: 'architecture.jsx', message: 'failed', diagnostic: { code: 'future' } }
		websocket.handlers.message(browser, JSON.stringify({ type: 'render-error', error }))
		expect(waiter.sent).toEqual([JSON.stringify({ type: 'render-error', error })])
	})
	test('delivers an error that arrived before the CLI watcher connected', () => {
		const sessionManager = createSessionManager()
		const websocket = createWebSocketManager(sessionManager)
		const browser = new FakeSocket({ type: 'browser', sessionId: 'session' })
		websocket.handlers.open(browser)

		websocket.handlers.message(
			browser,
			JSON.stringify({
				type: 'render-error',
				error: {
					revision: 1,
					filename: 'architecture.jsx',
					message: "Cannot read properties of undefined (reading 'map')",
				},
			}),
		)

		const watcher = new FakeSocket({ type: 'wait', sessionId: 'session' })
		websocket.handlers.open(watcher)

		expect(watcher.sent).toHaveLength(1)
		expect(JSON.parse(watcher.sent[0] ?? '')).toEqual({
			type: 'render-error',
			error: {
				revision: 1,
				filename: 'architecture.jsx',
				message: "Cannot read properties of undefined (reading 'map')",
			},
		})
		expect(watcher.closed).toBe(true)
		expect(sessionManager.get('session')?.revisions[0]?.hasFeedback).toBe(false)
	})

	test('drops a pending error when a new revision is pushed', () => {
		const sessionManager = createSessionManager()
		const websocket = createWebSocketManager(sessionManager)
		const browser = new FakeSocket({ type: 'browser', sessionId: 'session' })
		websocket.handlers.open(browser)
		websocket.handlers.message(
			browser,
			JSON.stringify({
				type: 'render-error',
				error: { revision: 1, filename: 'architecture.jsx', message: 'Broken revision' },
			}),
		)

		sessionManager.upsert(
			'session',
			new Map([['architecture.jsx', '<Section title="Fixed" />']]),
			'/project',
		)
		websocket.broadcastPlanUpdate('session')

		const watcher = new FakeSocket({ type: 'wait', sessionId: 'session' })
		websocket.handlers.open(watcher)
		expect(watcher.sent).toEqual([])
		expect(watcher.closed).toBe(false)
	})
})

describe('feedback consumption mode', () => {
	function submitWithWaiter(mode?: 'on-delivery' | 'external') {
		const sessionManager = createSessionManager()
		const websocket = createWebSocketManager(
			sessionManager,
			mode ? { feedbackConsumption: mode } : undefined,
		)
		const waiter = new FakeSocket({ type: 'wait', sessionId: 'session' })
		websocket.handlers.open(waiter)

		const browser = new FakeSocket({ type: 'browser', sessionId: 'session' })
		websocket.handlers.open(browser)
		websocket.handlers.message(browser, JSON.stringify({ type: 'submit', feedback: 'looks good' }))

		return { sessionManager, waiter }
	}

	test('the waiting client is handed the feedback in both modes', () => {
		for (const mode of ['on-delivery', 'external'] as const) {
			const { waiter } = submitWithWaiter(mode)
			expect(waiter.sent.map((m) => JSON.parse(m).feedback)).toEqual(['looks good'])
			expect(waiter.closed).toBe(true)
		}
	})

	test('on-delivery (default) leaves nothing for a second consumer to replay', () => {
		const { sessionManager } = submitWithWaiter()
		expect(sessionManager.getLatestUnconsumedFeedback('session')).toBeNull()
	})

	test('external leaves the feedback pending for a separate gate to claim', () => {
		const { sessionManager } = submitWithWaiter('external')
		expect(sessionManager.getLatestUnconsumedFeedback('session')?.feedback).toBe('looks good')
	})
})

describe('session project root', () => {
	test('a later push from a different cwd does not repoint the session', () => {
		const sessionManager = createSessionManager()
		const original = sessionManager.get('session')!.projectRoot

		const updated = sessionManager.upsert(
			'session',
			new Map([['architecture.jsx', '<Section title="Architecture v2" />']]),
			'/tmp/some-other-cwd',
		)

		expect(updated.projectRoot).toBe(original)
		expect(updated.currentRevision).toBe(2)
	})
})

describe('submitted annotations', () => {
	test('a submit keeps the annotations it carries, leaving out one it cannot thread', () => {
		const sessionManager = createSessionManager()
		const websocket = createWebSocketManager(sessionManager)
		const browser = new FakeSocket({ type: 'browser', sessionId: 'session' })
		websocket.handlers.open(browser)
		websocket.handlers.message(
			browser,
			JSON.stringify({
				type: 'submit',
				feedback: 'two notes',
				annotations: [
					{ id: 'ann-1-abcd', snippet: 'Architecture', note: 'rename', canvasFile: 'architecture.jsx' },
					{ id: '../escape', snippet: 'x', note: 'y' },
				],
			}),
		)

		expect(sessionManager.getFeedback('session', 1)).toBe('two notes')
		expect(sessionManager.findSubmittedAnnotation('session', 'ann-1-abcd')).toEqual({
			revision: 1,
			annotation: { id: 'ann-1-abcd', snippet: 'Architecture', note: 'rename', canvasFile: 'architecture.jsx' },
		})
		expect(sessionManager.findSubmittedAnnotation('session', '../escape')).toBeNull()
	})

	test('the latest revision that carried an annotation wins', () => {
		const sessionManager = createSessionManager()
		sessionManager.saveFeedback('session', 1, 'first', [{ id: 'ann-1', snippet: 'old', note: 'first' }])
		sessionManager.upsert('session', new Map([['architecture.jsx', '<Section title="v2" />']]), '/project')
		sessionManager.saveFeedback('session', 2, 'second', [{ id: 'ann-1', snippet: 'new', note: 'again' }])

		expect(sessionManager.findSubmittedAnnotation('session', 'ann-1')?.revision).toBe(2)
	})
})

describe('host frames', () => {
	test('notifying waiters leaves their wait open; a submit still ends it', () => {
		const sessionManager = createSessionManager()
		const websocket = createWebSocketManager(sessionManager)
		const waiter = new FakeSocket({ type: 'wait', sessionId: 'session' })
		websocket.handlers.open(waiter)

		expect(websocket.notifyWaiters('session', { type: 'thread-queued' })).toBe(true)
		expect(waiter.closed).toBe(false)

		const browser = new FakeSocket({ type: 'browser', sessionId: 'session' })
		websocket.handlers.open(browser)
		websocket.handlers.message(browser, JSON.stringify({ type: 'submit', feedback: 'done' }))
		expect(waiter.sent.map((message) => JSON.parse(message).type)).toEqual(['thread-queued', 'submit'])
		expect(waiter.closed).toBe(true)
	})
})
