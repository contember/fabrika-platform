import { z } from 'zod'
import { type ReviewAnchor, type ReviewBrowserFrame, type ReviewThread, reviewThreadSchema } from '../src/review/model'

const threadListSchema = z.object({ threads: z.array(reviewThreadSchema) })

export interface ReviewEvents {
	threads(threads: readonly ReviewThread[]): void
	agentWatching(watching: boolean): void
	connected(connected: boolean): void
	reload(path: string): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The daemon only ever sends these frames; anything else is ignored rather than trusted. */
function readFrame(data: unknown): ReviewBrowserFrame | undefined {
	if (typeof data !== 'string') return undefined
	let frame: unknown
	try {
		frame = JSON.parse(data)
	} catch {
		return undefined
	}
	if (!isRecord(frame)) return undefined
	if (frame['type'] === 'agent-status' && typeof frame['watching'] === 'boolean') return { type: 'agent-status', watching: frame['watching'] }
	if (frame['type'] === 'reload' && typeof frame['path'] === 'string') return { type: 'reload', path: frame['path'] }
	if (frame['type'] !== 'threads') return undefined
	const parsed = threadListSchema.safeParse(frame)
	return parsed.success ? { type: 'threads', threads: parsed.data.threads } : undefined
}

/** Where the widget keeps threads: the local daemon, or a remote project on the share worker. */
export interface ReviewClient {
	/** The presence label while the widget cannot reach its store. */
	readonly offlineLabel: string
	connect(events: ReviewEvents): void
	close(): void
	createThread(anchor: ReviewAnchor, body: string, send: boolean, screenshot?: string): Promise<unknown>
	comment(threadId: string, body: string, send: boolean): Promise<unknown>
	send(threadId: string): Promise<unknown>
	sendNotes(): Promise<unknown>
	setResolved(threadId: string, resolved: boolean): Promise<unknown>
	delete(threadId: string): Promise<unknown>
}

/** The widget's side of the daemon: thread mutations over HTTP, the thread list and agent presence over a WebSocket. */
export class DaemonReviewClient implements ReviewClient {
	readonly offlineLabel = 'Daemon offline'
	private socket: WebSocket | null = null
	private closed = false

	constructor(private readonly daemonOrigin: string, private readonly project: string) {}

	connect(events: ReviewEvents): void {
		const url = `${this.daemonOrigin.replace(/^http/, 'ws')}/ws/review/${encodeURIComponent(this.project)}`
		const socket = new WebSocket(url)
		this.socket = socket
		socket.onopen = () => {
			events.connected(true)
			void this.request('GET', '/threads').then((body) => {
				const parsed = threadListSchema.safeParse(body)
				if (parsed.success) events.threads(parsed.data.threads)
			})
		}
		socket.onmessage = (event) => {
			const frame = readFrame(event.data)
			if (frame?.type === 'threads') events.threads(frame.threads)
			if (frame?.type === 'agent-status') events.agentWatching(frame.watching)
			if (frame?.type === 'reload') events.reload(frame.path)
		}
		socket.onclose = () => {
			events.connected(false)
			if (!this.closed) setTimeout(() => this.connect(events), 2000)
		}
	}

	close(): void {
		this.closed = true
		this.socket?.close()
	}

	createThread(anchor: ReviewAnchor, body: string, send: boolean, screenshot?: string): Promise<unknown> {
		return this.request('POST', '/threads', { anchor, body, send, ...(screenshot === undefined ? {} : { screenshot }) })
	}

	comment(threadId: string, body: string, send: boolean): Promise<unknown> {
		return this.request('POST', `/threads/${threadId}/comments`, { body, send })
	}

	send(threadId: string): Promise<unknown> {
		return this.request('POST', `/threads/${threadId}/send`)
	}

	sendNotes(): Promise<unknown> {
		return this.request('POST', '/notes/send')
	}

	setResolved(threadId: string, resolved: boolean): Promise<unknown> {
		return this.request('POST', `/threads/${threadId}/${resolved ? 'resolve' : 'reopen'}`)
	}

	delete(threadId: string): Promise<unknown> {
		return this.request('DELETE', `/threads/${threadId}`)
	}

	private async request(method: string, path: string, body?: unknown): Promise<unknown> {
		const response = await fetch(`${this.daemonOrigin}/api/review/${encodeURIComponent(this.project)}${path}`, {
			method,
			...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
		})
		const result: unknown = await response.json()
		if (!response.ok) throw new Error(isRecord(result) && typeof result['error'] === 'string' ? result['error'] : `Request failed (${response.status})`)
		return result
	}
}
