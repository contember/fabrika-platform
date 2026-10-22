import { z } from 'zod'

/**
 * Review threads: comments a person leaves on a running application. A thread is a note until the person sends it
 * to the agent; the agent picks it up, answers and may resolve it.
 */

export const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

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

const shortText = z.string().max(500)

export const MAX_HTML = 4000
export const MAX_SOURCE_FILE = 1000
export const MAX_STYLE = 1000

/** A position in the application's source, resolved from a development stack through the page's source maps. */
export const reviewSourceSchema = z.object({
	/** What was created there, e.g. `<a> in ProductListCell` or `<ProductListCell> in DataGrid`. */
	label: shortText,
	file: z.string().max(MAX_SOURCE_FILE),
	line: z.number().int().positive(),
	column: z.number().int().nonnegative(),
})
export type ReviewSource = z.infer<typeof reviewSourceSchema>

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
	/** Source positions of the element and its nearest owner components, innermost first. */
	sources: z.array(reviewSourceSchema).max(10).optional(),
	/** The landmarks around the element: page heading, section, dialog. */
	context: shortText.optional(),
	/** The reviewer's browser and operating system, e.g. `Chrome 141 · Linux`, viewport and colour scheme. */
	browser: z.object({
		name: shortText,
		viewport: z.object({ width: z.number().int().nonnegative(), height: z.number().int().nonnegative(), scale: z.number().positive() }),
		colorScheme: z.enum(['light', 'dark']),
	}).optional(),
	/** The element's computed box, layout and type as CSS declarations, initial values left out. */
	style: z.string().max(MAX_STYLE).optional(),
	/** The element's markup, trimmed: deep subtrees, long lists and long texts are cut. */
	html: z.string().max(MAX_HTML).optional(),
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
	/** Absolute path of a PNG of the element the reviewer attached, stored by the daemon. */
	screenshot: z.string().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
})
export type ReviewThread = z.infer<typeof reviewThreadSchema>

/** A note the person saved and has not sent: open, with their own comment last rather than the agent's answer. */
export function isUnsentNote(thread: ReviewThread): boolean {
	return thread.state === 'open' && thread.comments.at(-1)?.author === 'user'
}

export const reviewThreadsFileSchema = z.object({ threads: z.array(reviewThreadSchema) })

const commentBody = z.string().trim().min(1).max(20_000)

const PNG_DATA_URL = 'data:image/png;base64,'

/** A PNG the widget rendered from the element, as a data URL; at most about 6 MB decoded. */
export const screenshotDataUrlSchema = z.string().startsWith(PNG_DATA_URL).max(8_000_000)
	.transform((url) => Uint8Array.from(atob(url.slice(PNG_DATA_URL.length)), (char) => char.charCodeAt(0)))

export const createThreadBodySchema = z.object({
	anchor: reviewAnchorSchema,
	body: commentBody,
	send: z.boolean(),
	screenshot: screenshotDataUrlSchema.optional(),
})
export const addCommentBodySchema = z.object({ body: commentBody, send: z.boolean() })
export const agentReplyBodySchema = z.object({ body: commentBody, resolve: z.boolean() })

/** An application on this machine: the review proxy forwards to its origin and refuses any other host. */
const loopbackUrlSchema = z.string().url().refine((url) => isLoopbackOrigin(url), 'must be an http(s) URL on localhost')

/** The CLI's request to open an application for review through the daemon's proxy. */
export const openProxyBodySchema = z.object({ target: loopbackUrlSchema })

/** A project's review proxy, kept so a restarted daemon serves it on the same port: the reviewer's tab keeps working. */
export const reviewProxySchema = z.object({ target: loopbackUrlSchema, port: z.number().int().min(1).max(65_535) })
export type ReviewProxy = z.infer<typeof reviewProxySchema>

/** Frames the daemon sends to browsers on a project's topic. */
export type ReviewBrowserFrame =
	| { type: 'threads'; threads: readonly ReviewThread[] }
	| { type: 'agent-status'; watching: boolean }
	/** The application's dev server asked for a full reload; the widget holds it while the reviewer writes. */
	| { type: 'reload'; path: string }

/** The frame a waiting CLI receives when the person sends threads; it reads them back through the claim endpoint. */
export interface ReviewWaitFrame {
	type: 'queued'
}
