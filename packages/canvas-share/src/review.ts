/**
 * Remote review projects: the threads a reviewer leaves on a deployed application through the agent-canvas review
 * widget, kept for the agent's CLI. One Durable Object per project serializes every change and relays them over
 * WebSockets. Anchors, comment bodies and screenshots arrive sealed with a key only the browser and the CLI hold; the
 * object moves threads through their lifecycle without reading them.
 *
 * Storage:
 *   DO:  meta                — origins allowed to write, the agent token's hash
 *        thread:{uuidv7}     — one sealed thread; keys sort in creation order
 *   R2:  reviews/{projectId}/screenshots/{threadId} — a sealed screenshot
 *
 * Access: a browser request must come from an allowed origin and name the project id, which only the reviewer's link
 * carries; an agent request must carry the agent token returned when the project was created.
 */

import type { ReviewComment, ReviewWaitFrame } from 'agent-canvas/review/model'
import {
	AGENT_SOCKET_PROTOCOL,
	createRemoteProjectBodySchema,
	KEEPALIVE_PING,
	KEEPALIVE_PONG,
	MAX_COMMENTS,
	MAX_SEALED_SCREENSHOT,
	MAX_THREADS,
	REMOTE_PROJECT_ID_RE,
	type RemoteBrowserFrame,
	sealedAgentReplyBodySchema,
	sealedCommentBodySchema,
	sealedCreateThreadBodySchema,
	type SealedThread,
	sealedThreadSchema,
} from 'agent-canvas/review/remote'
import { agentReplied, claimed, notesSent, openingState, resolvedAs, ReviewError, sent, userCommented } from 'agent-canvas/review/threads'
import { z } from 'zod'
import type { Env } from './types'
import { json, monotonicUuidv7, randomHexId, rateLimitShareCreate, readBodyWithLimit, sha256Hex, timingSafeEqual, verifyShareAuth } from './util'

const projectMetaSchema = z.object({
	origins: z.array(z.string()),
	agentTokenHash: z.string(),
	createdAt: z.string(),
})
type ProjectMeta = z.infer<typeof projectMetaSchema>

const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PROJECT_PATH_RE = /^\/review\/([a-f0-9]{24})(\/.*)?$/
const INIT_PATH = '/__init'
/** A sealed screenshot plus the rest of a thread, with headroom for JSON. */
const MAX_REQUEST_BYTES = MAX_SEALED_SCREENSHOT + 400_000
const BROWSER_WRITES_PER_MINUTE = 120

/** Routes a request under `/review/{projectId}` to its project. */
export function reviewProjectStub(env: Env, projectId: string): DurableObjectStub {
	return env.REVIEWS.get(env.REVIEWS.idFromName(projectId))
}

export function matchReviewPath(pathname: string): string | null {
	return pathname.match(PROJECT_PATH_RE)?.[1] ?? null
}

/** POST /reviews — gated like share creation, since a project stores data on this worker. */
export async function handleCreateReviewProject(req: Request, env: Env): Promise<Response> {
	const auth = verifyShareAuth(env, req)
	if (auth) return auth
	const limited = await rateLimitShareCreate(env, req)
	if (limited) return limited

	const text = await readBodyWithLimit(req, 16 * 1024)
	if (typeof text !== 'string') return text
	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 })
	}
	const parsed = createRemoteProjectBodySchema.safeParse(body)
	if (!parsed.success) return json({ error: issuesOf(parsed.error) }, { status: 400 })

	const projectId = randomHexId(12)
	const agentToken = randomHexId(32)
	const meta: ProjectMeta = { origins: parsed.data.origins, agentTokenHash: await sha256Hex(agentToken), createdAt: new Date().toISOString() }
	const created = await reviewProjectStub(env, projectId).fetch(`https://review${INIT_PATH}`, { method: 'POST', body: JSON.stringify(meta) })
	if (!created.ok) return json({ error: 'Could not create the review project' }, { status: 500 })
	return json({ projectId, agentToken }, { status: 201 })
}

function issuesOf(error: z.ZodError): string {
	return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
}

function corsHeaders(origin: string): Record<string, string> {
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		'Access-Control-Max-Age': '86400',
		Vary: 'Origin',
	}
}

function reply(data: unknown, status: number, origin: string | null): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json', ...(origin === null ? {} : corsHeaders(origin)) },
	})
}

class RefusedError extends Error {
	constructor(message: string, readonly status: 403 | 413 | 429) {
		super(message)
	}
}

async function parseBody<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
	const text = await readBodyWithLimit(req, MAX_REQUEST_BYTES)
	if (typeof text !== 'string') throw new RefusedError('Body too large', 413)
	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		throw new ReviewError('Body must be JSON', 400)
	}
	const parsed = schema.safeParse(body)
	if (!parsed.success) throw new ReviewError(issuesOf(parsed.error), 400)
	return parsed.data
}

/** A plain class rather than `cloudflare:workers`' base, so Bun and Lopata load it in tests. */
export class ReviewProject {
	private readonly writes: number[] = []
	private readonly uuidv7 = monotonicUuidv7()

	constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(KEEPALIVE_PING, KEEPALIVE_PONG))
	}

	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url)
		if (url.pathname === INIT_PATH && req.method === 'POST') {
			await this.ctx.storage.put('meta', projectMetaSchema.parse(await req.json()))
			return new Response(null, { status: 204 })
		}
		const match = url.pathname.match(PROJECT_PATH_RE)
		const projectId = match?.[1]
		if (projectId === undefined || !REMOTE_PROJECT_ID_RE.test(projectId)) return reply({ error: 'Not found' }, 404, null)
		const meta = await this.meta()
		if (meta === undefined) return reply({ error: 'No such review project' }, 404, null)
		const path = match?.[2] ?? '/'
		if (path === '/agent' || path.startsWith('/agent/')) return this.agent(req, path.slice('/agent'.length), projectId, meta)
		return this.browser(req, path, projectId, meta)
	}

	webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
		if (message === KEEPALIVE_PING) socket.send(KEEPALIVE_PONG)
	}

	/** Any socket may be the last waiting agent; a runtime may no longer report the tags of one that is closing. */
	webSocketClose(socket: WebSocket): void {
		this.broadcastPresence(socket)
	}

	private async browser(req: Request, path: string, projectId: string, meta: ProjectMeta): Promise<Response> {
		const origin = req.headers.get('Origin')
		if (origin === null || !meta.origins.includes(origin)) return reply({ error: 'Origin not allowed' }, 403, null)
		if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) })
		if (path === '/ws') return this.accept(req, 'browser')
		try {
			if (req.method !== 'GET') this.countWrite()
			return reply(await this.browserRoute(req, path, projectId), 200, origin)
		} catch (error) {
			if (error instanceof ReviewError || error instanceof RefusedError) return reply({ error: error.message }, error.status, origin)
			throw error
		}
	}

	private async browserRoute(req: Request, path: string, projectId: string): Promise<unknown> {
		const threadMatch = path.match(/^\/threads\/([^/]+)(?:\/(comments|send|resolve|reopen))?$/)
		const threadId = threadMatch?.[1]
		const action = threadMatch?.[2]
		if (path === '/threads' && req.method === 'GET') return { threads: await this.threads() }
		if (path === '/threads' && req.method === 'POST') return this.create(projectId, await parseBody(req, sealedCreateThreadBodySchema))
		if (path === '/notes/send' && req.method === 'POST') {
			const result = notesSent(await this.threads(), this.now())
			await this.putAll(result.sent)
			if (result.sent.length > 0) await this.changed(true)
			return { threads: result.sent }
		}
		if (threadId === undefined || req.method === 'GET') throw new ReviewError(`No route ${req.method} ${path}`, 404)
		if (action === undefined && req.method === 'DELETE') {
			await this.thread(threadId)
			await this.ctx.storage.delete(`thread:${threadId}`)
			await this.env.BLOBS.delete(screenshotKey(projectId, threadId))
			await this.changed(false)
			return { ok: true }
		}
		if (req.method !== 'POST') throw new ReviewError(`No route ${req.method} ${path}`, 404)
		if (action === 'comments') {
			const body = await parseBody(req, sealedCommentBodySchema)
			const thread = await this.thread(threadId)
			if (thread.comments.length >= MAX_COMMENTS) throw new RefusedError('This thread has too many comments', 413)
			return this.save(userCommented(thread, this.comment('user', body.body), body.send), body.send)
		}
		if (action === 'send') return this.save(sent(await this.thread(threadId), this.now()), true)
		if (action === 'resolve' || action === 'reopen') return this.save(resolvedAs(await this.thread(threadId), action === 'resolve', this.now()), false)
		throw new ReviewError(`No route ${req.method} ${path}`, 404)
	}

	private async agent(req: Request, path: string, projectId: string, meta: ProjectMeta): Promise<Response> {
		if (path === '/ws') {
			const [protocol, token] = (req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((part) => part.trim())
			if (protocol !== AGENT_SOCKET_PROTOCOL || token === undefined || !(await this.isAgentToken(token, meta))) {
				return reply({ error: 'Unauthorized' }, 401, null)
			}
			return this.accept(req, 'wait')
		}
		const token = req.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/)?.[1]
		if (token === undefined || !(await this.isAgentToken(token, meta))) return reply({ error: 'Unauthorized' }, 401, null)
		try {
			return reply(await this.agentRoute(req, path, projectId), 200, null)
		} catch (error) {
			if (error instanceof ReviewError || error instanceof RefusedError) return reply({ error: error.message }, error.status, null)
			throw error
		}
	}

	private async isAgentToken(token: string, meta: ProjectMeta): Promise<boolean> {
		return timingSafeEqual(await sha256Hex(token), meta.agentTokenHash)
	}

	private async agentRoute(req: Request, path: string, projectId: string): Promise<unknown> {
		if (path === '/threads' && req.method === 'GET') return { threads: await this.threads() }
		if (path === '/claim' && req.method === 'POST') {
			const result = claimed(await this.threads(), this.now())
			await this.putAll(result.claimed)
			if (result.claimed.length > 0) await this.changed(false)
			return { threads: result.claimed }
		}
		const threadMatch = path.match(/^\/threads\/([^/]+)\/(reply|screenshot)$/)
		const threadId = threadMatch?.[1]
		if (threadId !== undefined && threadMatch?.[2] === 'reply' && req.method === 'POST') {
			const body = await parseBody(req, sealedAgentReplyBodySchema)
			const thread = await this.thread(threadId)
			if (thread.comments.length >= MAX_COMMENTS) throw new RefusedError('This thread has too many comments', 413)
			return this.save(agentReplied(thread, this.comment('agent', body.body), body.resolve), false)
		}
		if (threadId !== undefined && threadMatch?.[2] === 'screenshot' && req.method === 'GET') {
			await this.thread(threadId)
			const object = await this.env.BLOBS.get(screenshotKey(projectId, threadId))
			if (object === null) throw new ReviewError(`Thread ${threadId} has no screenshot`, 404)
			return { screenshot: await object.text() }
		}
		throw new ReviewError(`No route ${req.method} ${path}`, 404)
	}

	private async create(projectId: string, body: z.infer<typeof sealedCreateThreadBodySchema>): Promise<{ thread: SealedThread }> {
		const existing = await this.ctx.storage.list({ prefix: 'thread:' })
		if (existing.size >= MAX_THREADS) throw new RefusedError('This review project has too many threads', 413)
		const createdAt = this.now()
		const id = this.uuidv7()
		if (body.screenshot !== undefined) await this.env.BLOBS.put(screenshotKey(projectId, id), body.screenshot)
		const thread: SealedThread = {
			id,
			anchor: body.anchor,
			state: openingState(body.send),
			comments: [{ id: this.uuidv7(), author: 'user', body: body.body, createdAt }],
			screenshot: body.screenshot !== undefined,
			createdAt,
			updatedAt: createdAt,
		}
		return this.save(thread, body.send)
	}

	private accept(req: Request, role: 'browser' | 'wait'): Response {
		if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return reply({ error: 'Expected a WebSocket upgrade' }, 426, null)
		const pair = new WebSocketPair()
		const [client, server] = Object.values(pair)
		this.ctx.acceptWebSocket(server, [role])
		if (role === 'wait') this.broadcastPresence(null)
		else server.send(JSON.stringify(this.presenceFrame(null)))
		const headers: Record<string, string> = role === 'wait' ? { 'Sec-WebSocket-Protocol': AGENT_SOCKET_PROTOCOL } : {}
		return new Response(null, { status: 101, webSocket: client, headers })
	}

	private async save(thread: SealedThread, notify: boolean): Promise<{ thread: SealedThread }> {
		await this.ctx.storage.put(`thread:${thread.id}`, thread)
		await this.changed(notify)
		return { thread }
	}

	private async putAll(threads: readonly SealedThread[]): Promise<void> {
		if (threads.length === 0) return
		await this.ctx.storage.put(Object.fromEntries(threads.map((thread) => [`thread:${thread.id}`, thread])))
	}

	/** Sends the threads to every browser and, when something was queued, wakes the waiting agents. */
	private async changed(queued: boolean): Promise<void> {
		const frame: RemoteBrowserFrame = { type: 'threads', threads: await this.threads() }
		this.send('browser', frame)
		if (queued) {
			const wake: ReviewWaitFrame = { type: 'queued' }
			this.send('wait', wake)
		}
	}

	/** `closing` is a wait socket on its way out, which the runtime may still list. */
	private presenceFrame(closing: WebSocket | null): RemoteBrowserFrame {
		return { type: 'agent-status', watching: this.ctx.getWebSockets('wait').some((socket) => socket !== closing) }
	}

	private broadcastPresence(closing: WebSocket | null): void {
		this.send('browser', this.presenceFrame(closing))
	}

	private send(tag: 'browser' | 'wait', frame: RemoteBrowserFrame | ReviewWaitFrame): void {
		const data = JSON.stringify(frame)
		for (const socket of this.ctx.getWebSockets(tag)) {
			try {
				socket.send(data)
			} catch {}
		}
	}

	private async threads(): Promise<SealedThread[]> {
		const stored = await this.ctx.storage.list({ prefix: 'thread:' })
		return [...stored.values()].map((value) => sealedThreadSchema.parse(value))
	}

	private async thread(threadId: string): Promise<SealedThread> {
		if (!THREAD_ID_RE.test(threadId)) throw new ReviewError(`No thread ${threadId}`, 404)
		const stored = await this.ctx.storage.get(`thread:${threadId}`)
		if (stored === undefined) throw new ReviewError(`No thread ${threadId}`, 404)
		return sealedThreadSchema.parse(stored)
	}

	private async meta(): Promise<ProjectMeta | undefined> {
		const stored = await this.ctx.storage.get('meta')
		return stored === undefined ? undefined : projectMetaSchema.parse(stored)
	}

	private comment(author: ReviewComment['author'], body: string): ReviewComment {
		return { id: this.uuidv7(), author, body, createdAt: this.now() }
	}

	/** A soft limit per project, kept in memory: it resets when the object is evicted, which an idle project is. */
	private countWrite(): void {
		const now = Date.now()
		while (this.writes.length > 0 && (this.writes[0] ?? now) < now - 60_000) this.writes.shift()
		if (this.writes.length >= BROWSER_WRITES_PER_MINUTE) throw new RefusedError('Too many changes, try again in a minute', 429)
		this.writes.push(now)
	}

	private now(): string {
		return new Date().toISOString()
	}
}

function screenshotKey(projectId: string, threadId: string): string {
	return `reviews/${projectId}/screenshots/${threadId}`
}
