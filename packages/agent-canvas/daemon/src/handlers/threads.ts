import { jsonResponse, type Route } from '@fabrika/daemon-kit'
import { errorMessage } from '../../client/errorMessage'
import { parseBody } from '../review/server'
import { ReviewError } from '../review/threads'
import { agentReplyBodySchema, type CanvasThreadStore, resolvedBodySchema, threadRepliesMarkdown, userReplyBodySchema } from '../threads'

export interface ThreadRoutesContext {
	store: CanvasThreadStore
	/** Sends the session's threads to its browsers. */
	broadcast: (sessionId: string, frame: { type: 'threads'; threads: unknown }) => void
	/** Tells the session's waiting CLI that the user answered a thread. */
	notifyWaiters: (sessionId: string, frame: { type: 'thread-queued' }) => void
}

/**
 * Threads on submitted annotations. `reply` and `claim` are the CLI's (admission requires its capability); the
 * browser lists threads, answers them and resolves them.
 */
export function createThreadHandlers(ctx: ThreadRoutesContext): Route[] {
	const { store } = ctx

	function publish(sessionId: string): void {
		ctx.broadcast(sessionId, { type: 'threads', threads: store.list(sessionId) })
	}

	async function answer(work: () => Response | Promise<Response>): Promise<Response> {
		try {
			return await work()
		} catch (error) {
			if (error instanceof ReviewError) return jsonResponse({ error: error.message }, error.status)
			return jsonResponse({ error: errorMessage(error) }, 500)
		}
	}

	const sessionOf = (match: URLPatternResult) => match.pathname.groups['id'] ?? ''
	const threadOf = (match: URLPatternResult) => match.pathname.groups['thread'] ?? ''

	return [
		{
			method: 'GET',
			pattern: new URLPattern({ pathname: '/api/session/:id/threads' }),
			handler: (_req, _url, match) => answer(() => jsonResponse({ threads: store.list(sessionOf(match)) })),
		},
		{
			method: 'POST',
			pattern: new URLPattern({ pathname: '/api/session/:id/threads/claim' }),
			handler: (_req, _url, match) =>
				answer(() => {
					const sessionId = sessionOf(match)
					const claimed = store.claimQueued(sessionId)
					if (claimed.length > 0) publish(sessionId)
					return jsonResponse({ markdown: claimed.length > 0 ? threadRepliesMarkdown(claimed) : null })
				}),
		},
		{
			method: 'POST',
			pattern: new URLPattern({ pathname: '/api/session/:id/threads/:thread/reply' }),
			handler: (req, _url, match) =>
				answer(async () => {
					const sessionId = sessionOf(match)
					const body = await parseBody(req, agentReplyBodySchema)
					const thread = store.agentReply(sessionId, threadOf(match), body.body, body.resolve)
					publish(sessionId)
					return jsonResponse({ thread })
				}),
		},
		{
			method: 'POST',
			pattern: new URLPattern({ pathname: '/api/session/:id/threads/:thread/comments' }),
			handler: (req, _url, match) =>
				answer(async () => {
					const sessionId = sessionOf(match)
					const body = await parseBody(req, userReplyBodySchema)
					const thread = store.userReply(sessionId, threadOf(match), body.body)
					publish(sessionId)
					ctx.notifyWaiters(sessionId, { type: 'thread-queued' })
					return jsonResponse({ thread })
				}),
		},
		{
			method: 'POST',
			pattern: new URLPattern({ pathname: '/api/session/:id/threads/:thread/resolved' }),
			handler: (req, _url, match) =>
				answer(async () => {
					const sessionId = sessionOf(match)
					const body = await parseBody(req, resolvedBodySchema)
					const thread = store.setResolved(sessionId, threadOf(match), body.resolved)
					publish(sessionId)
					return jsonResponse({ thread })
				}),
		},
	]
}
