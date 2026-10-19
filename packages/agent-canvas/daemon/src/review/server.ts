import { type ChannelSocket, createNotificationChannel, dispatch, jsonResponse, type Route } from '@fabrika/daemon-kit'
import type { z } from 'zod'
import { renderReviewRequests } from './markdown'
import {
	addCommentBodySchema,
	agentReplyBodySchema,
	createThreadBodySchema,
	PROJECT_RE,
	type ReviewBrowserFrame,
	type ReviewWaitFrame,
} from './model'
import { ReviewError, type ReviewStore } from './store'

export interface ReviewSocketData {
	type: 'review'
	role: 'browser' | 'wait'
	project: string
}

export interface ReviewSocket extends ChannelSocket {
	data: ReviewSocketData
}

/**
 * Loopback origins only: a page on any other origin must not be able to put a request in front of the agent.
 * The application under review runs on its own dev server, so its port is not the daemon's.
 */
export function isLoopbackOrigin(origin: string): boolean {
	let url: URL
	try {
		url = new URL(origin)
	} catch {
		return false
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
	return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname.endsWith('.localhost')
}

function corsHeaders(origin: string): Record<string, string> {
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		Vary: 'Origin',
	}
}

async function parseBody<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
	let body: unknown
	try {
		body = await req.json()
	} catch {
		throw new ReviewError('Body must be JSON', 400)
	}
	const parsed = schema.safeParse(body)
	if (!parsed.success) throw new ReviewError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), 400)
	return parsed.data
}

function projectOf(match: URLPatternResult): string {
	const project = match.pathname.groups['project'] ?? ''
	if (!PROJECT_RE.test(project)) throw new ReviewError(`Invalid project name ${project}`, 400)
	return project
}

function threadIdOf(match: URLPatternResult): string {
	return match.pathname.groups['thread'] ?? ''
}

type Audience = 'browser' | 'agent'

/** Review mode: threads a person leaves on a running application through the injected widget, and their delivery to the agent. */
export function createReviewServer(store: ReviewStore) {
	const channel = createNotificationChannel<ReviewSocket>({
		roleOf: (socket) => socket.data.role,
		topicOf: (socket) => socket.data.project,
		presenceFrame: (watching): ReviewBrowserFrame => ({ type: 'agent-status', watching }),
	})

	function publish(project: string): void {
		const frame: ReviewBrowserFrame = { type: 'threads', threads: store.list(project) }
		channel.broadcast(project, frame)
	}

	function notifyAgent(project: string): void {
		const frame: ReviewWaitFrame = { type: 'queued' }
		channel.relayToWaiters(project, frame)
	}

	/**
	 * Browser routes answer only loopback origins. Agent routes refuse any request a browser makes: browsers send
	 * `Origin` on every cross-origin request, the CLI sends none.
	 */
	function route(
		method: Route['method'],
		pathname: string,
		audience: Audience,
		handle: (req: Request, match: URLPatternResult) => Promise<unknown>,
	): Route {
		return {
			method,
			pattern: new URLPattern({ pathname }),
			handler: async (req, _url, match) => {
				const origin = req.headers.get('Origin')
				if (audience === 'agent' && origin !== null) return jsonResponse({ error: 'Agent endpoints do not accept browser requests' }, 403)
				if (origin !== null && !isLoopbackOrigin(origin)) return jsonResponse({ error: 'Origin not allowed' }, 403)
				let response: Response
				try {
					response = jsonResponse(await handle(req, match))
				} catch (error) {
					if (!(error instanceof ReviewError)) throw error
					response = jsonResponse({ error: error.message }, error.status)
				}
				if (origin !== null) { for (const [name, value] of Object.entries(corsHeaders(origin))) response.headers.set(name, value) }
				return response
			},
		}
	}

	const routes: Route[] = [
		route('GET', '/api/review/:project/threads', 'browser', async (_req, match) => ({ threads: store.list(projectOf(match)) })),
		route('POST', '/api/review/:project/threads', 'browser', async (req, match) => {
			const project = projectOf(match)
			const body = await parseBody(req, createThreadBodySchema)
			const thread = store.create(project, body.anchor, body.body, body.send, body.screenshot)
			publish(project)
			if (body.send) notifyAgent(project)
			return { thread }
		}),
		route('POST', '/api/review/:project/threads/:thread/comments', 'browser', async (req, match) => {
			const project = projectOf(match)
			const body = await parseBody(req, addCommentBodySchema)
			const thread = store.addUserComment(project, threadIdOf(match), body.body, body.send)
			publish(project)
			if (body.send) notifyAgent(project)
			return { thread }
		}),
		route('POST', '/api/review/:project/threads/:thread/send', 'browser', async (_req, match) => {
			const project = projectOf(match)
			const thread = store.send(project, threadIdOf(match))
			publish(project)
			notifyAgent(project)
			return { thread }
		}),
		route('POST', '/api/review/:project/threads/:thread/resolve', 'browser', async (_req, match) => {
			const project = projectOf(match)
			const thread = store.setResolved(project, threadIdOf(match), true)
			publish(project)
			return { thread }
		}),
		route('POST', '/api/review/:project/threads/:thread/reopen', 'browser', async (_req, match) => {
			const project = projectOf(match)
			const thread = store.setResolved(project, threadIdOf(match), false)
			publish(project)
			return { thread }
		}),
		route('DELETE', '/api/review/:project/threads/:thread', 'browser', async (_req, match) => {
			const project = projectOf(match)
			store.delete(project, threadIdOf(match))
			publish(project)
			return { ok: true }
		}),
		route('POST', '/api/review/:project/claim', 'agent', async (_req, match) => {
			const project = projectOf(match)
			const threads = store.claimQueued(project)
			if (threads.length === 0) return { found: false }
			publish(project)
			return { found: true, markdown: renderReviewRequests(project, threads) }
		}),
		route('POST', '/api/review/:project/threads/:thread/reply', 'agent', async (req, match) => {
			const project = projectOf(match)
			const body = await parseBody(req, agentReplyBodySchema)
			const thread = store.agentReply(project, threadIdOf(match), body.body, body.resolve)
			publish(project)
			return { thread }
		}),
	]

	return {
		channel,
		/** Answers the request when it is review mode's: CORS preflight, a route, or a WebSocket upgrade. */
		fetch(
			req: Request,
			url: URL,
			server: { upgrade(req: Request, options: { data: ReviewSocketData }): boolean },
		): Response | Promise<Response> | 'upgraded' | null {
			const socketMatch = url.pathname.match(/^\/ws\/review(-wait)?\/([^/]+)$/)
			if (socketMatch !== null) {
				const origin = req.headers.get('Origin')
				const project = socketMatch[2] ?? ''
				const role = socketMatch[1] === undefined ? 'browser' : 'wait'
				if (!PROJECT_RE.test(project)) return jsonResponse({ error: 'Invalid project name' }, 400)
				if (role === 'browser' ? origin === null || !isLoopbackOrigin(origin) : origin !== null) return jsonResponse({ error: 'Origin not allowed' }, 403)
				return server.upgrade(req, { data: { type: 'review', role, project } }) ? 'upgraded' : new Response('WebSocket upgrade failed', { status: 400 })
			}
			if (!url.pathname.startsWith('/api/review/')) return null
			if (req.method === 'OPTIONS') {
				const origin = req.headers.get('Origin')
				if (origin === null || !isLoopbackOrigin(origin)) return new Response(null, { status: 403 })
				return new Response(null, { status: 204, headers: corsHeaders(origin) })
			}
			return dispatch(routes, req, url)
		},
	}
}

export type ReviewServer = ReturnType<typeof createReviewServer>
