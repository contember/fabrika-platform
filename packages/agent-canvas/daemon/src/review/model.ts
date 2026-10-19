import { z } from 'zod'

/**
 * Review threads: comments a person leaves on a running application. A thread is a note until the person sends it
 * to the agent; the agent picks it up, answers and may resolve it.
 */

export const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const shortText = z.string().max(500)

/** Where in the page a thread points. Every field is best effort; the agent reads them, the widget re-finds the element. */
export const reviewAnchorSchema = z.object({
	/** The page's URL when the thread was created, hash routes included. */
	url: z.string().min(1).max(2000),
	/** CSS path from the nearest element with an id, or from `body`. */
	selector: z.string().max(2000),
	/** ARIA role and accessible name, as the agent would target the element in a browser. */
	role: shortText.optional(),
	name: shortText.optional(),
	/** The element's visible text, shortened. */
	text: shortText.optional(),
	/** Owner components from the outermost to the element, read off React's development fibers. */
	components: z.array(z.string().max(200)).max(20).optional(),
	/** A text selection inside the element, with its surroundings. */
	quote: z.object({ exact: z.string().min(1).max(2000), before: shortText, after: shortText }).optional(),
})
export type ReviewAnchor = z.infer<typeof reviewAnchorSchema>

export const reviewAuthorSchema = z.enum(['user', 'agent'])
export type ReviewAuthor = z.infer<typeof reviewAuthorSchema>

export const reviewCommentSchema = z.object({
	id: z.string(),
	author: reviewAuthorSchema,
	body: z.string().min(1).max(20_000),
	createdAt: z.string(),
})
export type ReviewComment = z.infer<typeof reviewCommentSchema>

/**
 * - `open`: a note, or an answered thread waiting on the person.
 * - `queued`: sent to the agent, not picked up yet.
 * - `working`: delivered to the agent.
 * - `resolved`: the agent or the person closed it.
 */
export const reviewThreadStateSchema = z.enum(['open', 'queued', 'working', 'resolved'])
export type ReviewThreadState = z.infer<typeof reviewThreadStateSchema>

export const reviewThreadSchema = z.object({
	id: z.string(),
	anchor: reviewAnchorSchema,
	state: reviewThreadStateSchema,
	comments: z.array(reviewCommentSchema).min(1),
	createdAt: z.string(),
	updatedAt: z.string(),
})
export type ReviewThread = z.infer<typeof reviewThreadSchema>

export const reviewThreadsFileSchema = z.object({ threads: z.array(reviewThreadSchema) })

const commentBody = z.string().trim().min(1).max(20_000)

export const createThreadBodySchema = z.object({ anchor: reviewAnchorSchema, body: commentBody, send: z.boolean() })
export const addCommentBodySchema = z.object({ body: commentBody, send: z.boolean() })
export const agentReplyBodySchema = z.object({ body: commentBody, resolve: z.boolean() })

/** Frames the daemon sends to browsers on a project's topic. */
export type ReviewBrowserFrame =
	| { type: 'threads'; threads: readonly ReviewThread[] }
	| { type: 'agent-status'; watching: boolean }

/** The frame a waiting CLI receives when the person sends threads; it reads them back through the claim endpoint. */
export interface ReviewWaitFrame {
	type: 'queued'
}
