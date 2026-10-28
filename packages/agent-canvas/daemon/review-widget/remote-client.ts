import { z } from 'zod'
import type { ReviewAnchor, ReviewThread } from '../src/review/model'
import { KEEPALIVE_PING, type SealedThread, sealedThreadSchema, sealedThreadsSchema } from '../src/review/remote'
import { openThread, sealAnchor, sealText } from '../src/review/sealing'
import type { ReviewClient, ReviewEvents } from './client'

const KEEPALIVE_MS = 30_000

const frameSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('threads'), threads: z.array(sealedThreadSchema) }),
	z.object({ type: z.literal('agent-status'), watching: z.boolean() }),
])
const errorSchema = z.object({ error: z.string() })

/**
 * The widget's side of a remote review project on the share worker. Everything the reviewer writes is sealed with the
 * project key before it leaves the page, and every thread the worker sends is opened here.
 */
export class RemoteReviewClient implements ReviewClient {
	readonly offlineLabel = 'Offline'
	private socket: WebSocket | null = null
	private keepalive: ReturnType<typeof setInterval> | null = null
	private closed = false
	/** Opening threads is asynchronous; only the newest list may reach the widget. */
	private generation = 0

	constructor(private readonly workerOrigin: string, private readonly projectId: string, private readonly key: CryptoKey) {}

	connect(events: ReviewEvents): void {
		const socket = new WebSocket(`${this.workerOrigin.replace(/^http/, 'ws')}/review/${this.projectId}/ws`)
		this.socket = socket
		socket.onopen = () => {
			events.connected(true)
			this.keepalive = setInterval(() => socket.send(KEEPALIVE_PING), KEEPALIVE_MS)
			void this.request('GET', '/threads').then((body) => this.publish(sealedThreadsSchema.parse(body).threads, events))
		}
		socket.onmessage = (event) => {
			if (typeof event.data !== 'string' || event.data === 'pong') return
			let data: unknown
			try {
				data = JSON.parse(event.data)
			} catch {
				return
			}
			const frame = frameSchema.safeParse(data)
			if (!frame.success) return
			if (frame.data.type === 'threads') this.publish(frame.data.threads, events)
			else events.agentWatching(frame.data.watching)
		}
		socket.onclose = () => {
			if (this.keepalive !== null) clearInterval(this.keepalive)
			events.connected(false)
			if (!this.closed) setTimeout(() => this.connect(events), 2000)
		}
	}

	close(): void {
		this.closed = true
		this.socket?.close()
	}

	async createThread(anchor: ReviewAnchor, body: string, send: boolean, screenshot?: string): Promise<unknown> {
		return this.request('POST', '/threads', {
			anchor: await sealAnchor(this.key, anchor),
			body: await sealText(this.key, body),
			send,
			...(screenshot === undefined ? {} : { screenshot: await sealText(this.key, screenshot) }),
		})
	}

	async comment(threadId: string, body: string, send: boolean): Promise<unknown> {
		return this.request('POST', `/threads/${threadId}/comments`, { body: await sealText(this.key, body), send })
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

	/** A thread that does not open was not sealed with this project's key; the reviewer never sees it. */
	private publish(sealed: readonly SealedThread[], events: ReviewEvents): void {
		const generation = ++this.generation
		void Promise.allSettled(sealed.map((thread) => openThread(this.key, thread))).then((results) => {
			if (generation !== this.generation) return
			const threads: ReviewThread[] = []
			for (const result of results) {
				if (result.status === 'fulfilled') threads.push(result.value)
				else console.warn('agent-canvas review: a thread did not open with this project key')
			}
			events.threads(threads)
		})
	}

	private async request(method: string, path: string, body?: unknown): Promise<unknown> {
		const response = await fetch(`${this.workerOrigin}/review/${this.projectId}${path}`, {
			method,
			...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
		})
		const result: unknown = await response.json()
		if (!response.ok) {
			const error = errorSchema.safeParse(result)
			throw new Error(error.success ? error.data.error : `Request failed (${response.status})`)
		}
		return result
	}
}
