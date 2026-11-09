import { z } from 'zod'
import {
	decryptString,
	ENCRYPTION_META,
	type EncryptionMeta,
	encryptString,
	exportShareKey,
	generateShareKey,
	importShareKey,
} from '../client/shareCrypto'
import { MAX_SHARED_RESPONSES, type SharedResponse, sharedResponseSchema } from './share-responses'

/**
 * Client for the canvas share worker, independent of the daemon's sessions.
 *
 * Exported as `agent-canvas/share` so another host can share a compiled
 * canvas and read its feedback with the same wire format and end-to-end
 * encryption the daemon uses. The daemon's own sharing (share.ts), its
 * feedback poller (remote-feedback.ts), the shared page and the worker's
 * validation are built on it.
 *
 * Encryption: see `daemon/client/shareCrypto.ts`; the key travels only in
 * the URL fragment, so the worker stores ciphertext it cannot read.
 */

export { decryptString, ENCRYPTION_META, type EncryptionMeta, encryptString, exportShareKey, generateShareKey, importShareKey }
export {
	answeredResponses,
	MAX_SHARED_RESPONSE_TEXT,
	MAX_SHARED_RESPONSES,
	type SharedResponse,
	sharedResponseSchema,
	sharedResponsesSchema,
} from './share-responses'

export interface SharePayload {
	version: 1
	/** Present iff payload fields below are ciphertext rather than plaintext. */
	encryption?: EncryptionMeta
	origin: {
		sessionId: string
		revision: number
		label?: string
		createdAt: string
	}
	canvasFiles: Array<{
		filename: string
		compiledJs: string
		sourceJsx?: string
	}>
	runtime: {
		componentsVersion: string
	}
}

const shareResponseSchema = z.object({
	shareId: z.string().min(1),
	url: z.string().min(1),
	ownerToken: z.string().optional(),
	expiresAt: z.string().optional(),
})
export type ShareResponse = z.infer<typeof shareResponseSchema>

export interface ShareEndpoint {
	/** Base URL of the share worker, without a trailing slash. */
	endpoint: string
	/** Bearer token, when the worker sets SHARE_AUTH_TOKEN. */
	authToken?: string
}

/** A created share. `url` carries the `#k=` key when the share is encrypted. */
export interface CreatedShare extends ShareResponse {
	/** The base64url key, when encrypted; it decrypts the share's feedback. */
	encryptionKey?: string
}

// --- Feedback ---------------------------------------------------------------

const annotationContextSchema = z.object({
	before: z.string(),
	after: z.string(),
	hierarchy: z.array(z.string()),
	lineStart: z.number().optional(),
	lineEnd: z.number().optional(),
})

export interface SharedAnnotation {
	id: string
	snippet: string
	note: string
	createdAt: string
	filePath?: string
	canvasFile?: string
	context?: z.infer<typeof annotationContextSchema>
	attachments?: { url: string; mime?: string }[]
}

/** A feedback entry as a reviewer submitted it, decrypted. */
export interface SharedFeedbackEntry {
	id: string
	shareId: string
	revision: number
	submittedAt: string
	author: { id: string; name: string }
	annotations: SharedAnnotation[]
	generalNote?: string
	/** Structured answers; absent in entries from share pages that predate them. */
	responses?: SharedResponse[]
	/** How many responses did not fit the wire shape (a newer page, or tampering) and were left out. */
	droppedResponses?: number
}

/** A feedback entry as the worker returns it. In an encrypted entry the text
 *  fields, the annotation context (as JSON) and `responses` (as one JSON
 *  blob) are ciphertext. */
export const wireFeedbackEntrySchema = z.object({
	id: z.string(),
	shareId: z.string(),
	revision: z.number().int(),
	submittedAt: z.string(),
	author: z.object({ id: z.string(), name: z.string() }),
	annotations: z.array(z.object({
		id: z.string(),
		snippet: z.string(),
		note: z.string(),
		createdAt: z.string(),
		filePath: z.string().optional(),
		canvasFile: z.string().optional(),
		context: z.unknown().optional(),
		attachments: z.array(z.object({ url: z.string(), mime: z.string().optional() })).optional(),
	})),
	generalNote: z.string().optional(),
	// Checked per response in decryptFeedbackEntry: one that does not fit must not cost the whole entry.
	responses: z.unknown().optional(),
	encryption: z.object({ alg: z.string(), v: z.number() }).optional(),
})
export type WireFeedbackEntry = z.infer<typeof wireFeedbackEntrySchema>

export interface FeedbackPage {
	entries: WireFeedbackEntry[]
	/** Ids of entries that did not match the wire format; they are skipped. */
	malformed: string[]
	/** High-water mark: pass it back as `since` on the next call. */
	latestAt?: string
}

const feedbackPageSchema = z.object({ entries: z.array(z.unknown()), latestAt: z.string().optional() })

/** The share no longer exists on the worker (revoked or expired). */
export class ShareGoneError extends Error {}

// --- Requests ---------------------------------------------------------------

/**
 * Encrypt a plaintext SharePayload, returning a new payload whose secret
 * fields are ciphertext + the `encryption` marker.
 * Fields kept plaintext (and why):
 *  - `version`, `runtime.componentsVersion`: routing
 *  - `origin.revision`, `origin.createdAt`: indexing/display
 *  - `canvasFiles[].filename`: used as the route key by the worker
 * Everything else (sessionId, label, compiledJs, sourceJsx) is encrypted.
 */
export async function encryptSharePayload(
	payload: SharePayload,
	key: CryptoKey,
): Promise<SharePayload> {
	const canvasFiles = await Promise.all(
		payload.canvasFiles.map(async (cf) => ({
			filename: cf.filename,
			compiledJs: await encryptString(key, cf.compiledJs),
			...(cf.sourceJsx ? { sourceJsx: await encryptString(key, cf.sourceJsx) } : {}),
		})),
	)
	return {
		version: payload.version,
		encryption: ENCRYPTION_META,
		origin: {
			sessionId: await encryptString(key, payload.origin.sessionId),
			revision: payload.origin.revision,
			...(payload.origin.label
				? { label: await encryptString(key, payload.origin.label) }
				: {}),
			createdAt: payload.origin.createdAt,
		},
		canvasFiles,
		runtime: payload.runtime,
	}
}

/**
 * POST the payload to the worker. Returns the `shareId` + public URL
 * assigned by the worker. Throws on any HTTP error or a response that is
 * not a share.
 */
export async function pushShareToWorker(payload: SharePayload, config: ShareEndpoint): Promise<ShareResponse> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' }
	if (config.authToken) headers['Authorization'] = `Bearer ${config.authToken}`

	const res = await fetch(`${config.endpoint}/shares`, {
		method: 'POST',
		headers,
		body: JSON.stringify(payload),
	})
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		throw new Error(`Share endpoint returned ${res.status}: ${text || res.statusText}`)
	}
	const data: unknown = await res.json()
	const parsed = shareResponseSchema.safeParse(data)
	if (!parsed.success) {
		throw new Error(`Share endpoint returned invalid response: ${JSON.stringify(data)}`)
	}
	return parsed.data
}

/**
 * Encrypt (unless `encryption` is false) and upload a plaintext payload.
 * The URL of an encrypted share carries the `#k=` fragment, so it can be
 * handed to reviewers as is.
 */
export async function createShare(
	payload: SharePayload,
	config: ShareEndpoint & { encryption?: boolean },
): Promise<CreatedShare> {
	if (config.encryption === false) return pushShareToWorker(payload, config)
	const key = await generateShareKey()
	const encryptionKey = await exportShareKey(key)
	const response = await pushShareToWorker(await encryptSharePayload(payload, key), config)
	return { ...response, url: `${response.url}#k=${encryptionKey}`, encryptionKey }
}

/** Revoke a share with the owner token returned when it was created. */
export async function revokeShareOnWorker(endpoint: string, shareId: string, ownerToken: string): Promise<void> {
	const res = await fetch(`${endpoint}/shares/${encodeURIComponent(shareId)}/revoke`, {
		method: 'POST',
		headers: { 'Authorization': `Bearer ${ownerToken}` },
	})
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		throw new Error(`Revoke failed: ${res.status} ${text}`)
	}
}

/**
 * Feedback submitted since `since` (the previous `latestAt`, or "" for all).
 * Throws ShareGoneError when the worker no longer serves the share.
 */
export async function fetchShareFeedback(endpoint: string, shareId: string, since: string): Promise<FeedbackPage> {
	const url = `${endpoint}/shares/${encodeURIComponent(shareId)}/feedback${since ? `?since=${encodeURIComponent(since)}` : ''}`
	const res = await fetch(url)
	if (res.status === 404) throw new ShareGoneError(`Share ${shareId} not found (revoked or expired)`)
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	const page = feedbackPageSchema.safeParse(await res.json())
	if (!page.success) throw new Error('Feedback endpoint returned invalid response')
	const entries: WireFeedbackEntry[] = []
	const malformed: string[] = []
	for (const candidate of page.data.entries) {
		const entry = wireFeedbackEntrySchema.safeParse(candidate)
		if (entry.success) entries.push(entry.data)
		else malformed.push(z.object({ id: z.string() }).safeParse(candidate).data?.id ?? '(no id)')
	}
	return { entries, malformed, ...(page.data.latestAt ? { latestAt: page.data.latestAt } : {}) }
}

// The responses that fit the wire shape; the rest are counted, not fatal.
function readResponses(value: unknown): Pick<SharedFeedbackEntry, 'responses' | 'droppedResponses'> {
	if (value === undefined) return {}
	if (!Array.isArray(value)) return { droppedResponses: 1 }
	const responses = value.flatMap((candidate) => {
		const parsed = sharedResponseSchema.safeParse(candidate)
		return parsed.success ? [parsed.data] : []
	}).slice(0, MAX_SHARED_RESPONSES)
	const droppedResponses = value.length - responses.length
	return { ...(responses.length > 0 ? { responses } : {}), ...(droppedResponses > 0 ? { droppedResponses } : {}) }
}

async function openResponses(key: CryptoKey, value: unknown): Promise<Pick<SharedFeedbackEntry, 'responses' | 'droppedResponses'>> {
	if (value === undefined) return {}
	if (typeof value !== 'string') return { droppedResponses: 1 }
	try {
		return readResponses(JSON.parse(await decryptString(key, value)))
	} catch {
		return { droppedResponses: 1 }
	}
}

function annotationContext(value: unknown): SharedAnnotation['context'] {
	const parsed = annotationContextSchema.safeParse(value)
	return parsed.success ? parsed.data : undefined
}

/**
 * The plaintext form of a feedback entry. An encrypted entry needs the
 * share's key; a plaintext one (from an unencrypted share) needs none.
 * Throws if a text field fails to decrypt. Responses that do not fit are
 * left out and counted in `droppedResponses`, so the rest of the entry stays.
 */
export async function decryptFeedbackEntry(entry: WireFeedbackEntry, key: CryptoKey | null): Promise<SharedFeedbackEntry> {
	const { encryption, responses, generalNote, annotations, ...rest } = entry
	if (!encryption) {
		return {
			...rest,
			annotations: annotations.map(({ context, ...a }) => {
				const parsed = annotationContext(context)
				return parsed ? { ...a, context: parsed } : a
			}),
			...(generalNote ? { generalNote } : {}),
			...readResponses(responses),
		}
	}
	if (!key) throw new Error(`Entry ${entry.id} is encrypted and no key was given`)

	const opened: SharedAnnotation[] = await Promise.all(
		annotations.map(async (a) => {
			const out: SharedAnnotation = {
				id: a.id,
				snippet: await decryptString(key, a.snippet),
				note: await decryptString(key, a.note),
				createdAt: a.createdAt,
			}
			if (a.filePath) out.filePath = await decryptString(key, a.filePath)
			if (a.canvasFile) out.canvasFile = await decryptString(key, a.canvasFile)
			if (typeof a.context === 'string' && a.context.length > 0) {
				const context = annotationContext(JSON.parse(await decryptString(key, a.context)))
				if (context) out.context = context
			}
			if (a.attachments) out.attachments = a.attachments
			return out
		}),
	)

	return {
		...rest,
		author: { id: entry.author.id, name: await decryptString(key, entry.author.name) },
		annotations: opened,
		...(generalNote ? { generalNote: await decryptString(key, generalNote) } : {}),
		...(await openResponses(key, responses)),
	}
}
