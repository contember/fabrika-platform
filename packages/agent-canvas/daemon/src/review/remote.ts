import { z } from 'zod'
import { reviewAuthorSchema, reviewThreadStateSchema } from './model'

/**
 * Remote review: the threads of an application deployed somewhere else, kept by the share worker. The reviewer's
 * browser and the agent's CLI share a key the worker never sees, so the worker stores and relays ciphertext. It reads
 * only what moves a thread through its lifecycle: ids, states, comment authors and timestamps.
 */

/** The worker's name for a remote project: 12 random bytes, hex. Knowing it, from an allowed origin, lets a browser write. */
export const REMOTE_PROJECT_ID_RE = /^[a-f0-9]{24}$/

/** The fragment that hands a reviewer the project and its key: `#agent-canvas-review=<projectId>.<key>`. */
export const REVIEW_FRAGMENT_PARAM = 'agent-canvas-review'

export const MAX_ORIGINS = 5
export const MAX_THREADS = 1000
export const MAX_COMMENTS = 200
/** Ciphertext limits: base64 of AES-GCM over the plaintext limits in `model.ts`, with room for multi-byte UTF-8. */
export const MAX_SEALED_ANCHOR = 160_000
export const MAX_SEALED_BODY = 110_000
export const MAX_SEALED_SCREENSHOT = 11_000_000

/** `shareCrypto` packing: base64(IV || ciphertext || tag). */
function sealed(max: number) {
	return z.string().min(1).max(max).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64 ciphertext')
}

/** A deployed application's origin, or one on this machine for trying the setup out. */
export const reviewOriginSchema = z.string().refine((value) => {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return false
	}
	if (url.origin !== value) return false
	if (url.protocol === 'https:') return true
	return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.endsWith('.localhost'))
}, 'must be an origin such as https://app.example.com')

export const sealedCommentSchema = z.object({
	id: z.string().max(64),
	author: reviewAuthorSchema,
	body: sealed(MAX_SEALED_BODY),
	createdAt: z.string().max(64),
})
export type SealedComment = z.infer<typeof sealedCommentSchema>

export const sealedThreadSchema = z.object({
	id: z.string().max(64),
	/** The `ReviewAnchor` as JSON, sealed. */
	anchor: sealed(MAX_SEALED_ANCHOR),
	state: reviewThreadStateSchema,
	comments: z.array(sealedCommentSchema).min(1).max(MAX_COMMENTS),
	/** Whether the reviewer attached a screenshot; the agent fetches it separately. */
	screenshot: z.boolean(),
	createdAt: z.string().max(64),
	updatedAt: z.string().max(64),
})
export type SealedThread = z.infer<typeof sealedThreadSchema>

export const sealedThreadsSchema = z.object({ threads: z.array(sealedThreadSchema) })

export const createRemoteProjectBodySchema = z.object({ origins: z.array(reviewOriginSchema).min(1).max(MAX_ORIGINS) })
export const createRemoteProjectResponseSchema = z.object({ projectId: z.string().regex(REMOTE_PROJECT_ID_RE), agentToken: z.string().min(32) })

export const sealedCreateThreadBodySchema = z.object({
	anchor: sealed(MAX_SEALED_ANCHOR),
	body: sealed(MAX_SEALED_BODY),
	send: z.boolean(),
	/** The PNG data URL, sealed. */
	screenshot: sealed(MAX_SEALED_SCREENSHOT).optional(),
})
export const sealedCommentBodySchema = z.object({ body: sealed(MAX_SEALED_BODY), send: z.boolean() })
export const sealedAgentReplyBodySchema = z.object({ body: sealed(MAX_SEALED_BODY), resolve: z.boolean() })
export const sealedScreenshotSchema = z.object({ screenshot: sealed(MAX_SEALED_SCREENSHOT) })

/** Frames the worker sends to a project's browsers. */
export type RemoteBrowserFrame =
	| { type: 'threads'; threads: readonly SealedThread[] }
	| { type: 'agent-status'; watching: boolean }

/** Sockets send this to keep an idle connection open; the worker answers `pong` without waking the project. */
export const KEEPALIVE_PING = 'ping'
export const KEEPALIVE_PONG = 'pong'

export interface ReviewCredentials {
	projectId: string
	/** The base64url AES-GCM key, as `exportShareKey` writes it. */
	key: string
}

const KEY_RE = /^[A-Za-z0-9_-]{43}$/

/** `<projectId>.<key>`, the value of the fragment parameter. */
export function formatReviewCredentials(credentials: ReviewCredentials): string {
	return `${credentials.projectId}.${credentials.key}`
}

export function parseReviewCredentials(value: string): ReviewCredentials | null {
	const [projectId, key, ...rest] = value.split('.')
	if (projectId === undefined || key === undefined || rest.length > 0) return null
	if (!REMOTE_PROJECT_ID_RE.test(projectId) || !KEY_RE.test(key)) return null
	return { projectId, key }
}

/**
 * A WebSocket client cannot always set headers, so the agent's wait socket offers its token as a second subprotocol:
 * `[AGENT_SOCKET_PROTOCOL, <agent token>]`. The worker answers with the first one only.
 */
export const AGENT_SOCKET_PROTOCOL = 'agent-canvas-review'
