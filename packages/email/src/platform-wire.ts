// The wire of the platform transport's mail receiver: what an application's `PlatformEmailSender` posts to Control's
// relay and what the relay answers. Both sides import it, so the encoding, the one parser and the status mapping
// cannot drift apart. Runtime-neutral: Web APIs only.

import { z } from 'zod'
import { base64Of } from './content.js'
import { EMAIL_DELIVERY_ERRORS, EmailDeliveryError, type EmailDeliveryErrorCode, type EmailMessage, type EmailSenderCapabilities } from './email.js'
import { validateEmailAttachments, validateEmailMessage } from './validation.js'

/** The relay's path under the receiver's URL (`FABRIKA_PLATFORM_MAIL_URL`). */
export const PLATFORM_MAIL_SEND_PATH = '/platform/mail/send'

/** What the relay promises: it records the message under its key and dispatches it later, perhaps after a person releases it. */
export const PLATFORM_MAIL_CAPABILITIES: EmailSenderCapabilities = {
	idempotent: true,
	confirmation: 'queued',
	maxBatch: 1,
	listUnsubscribe: true,
	maxAttachmentBytes: 10 * 1024 * 1024,
}

const LABEL = 'Platform mail'

/** One attachment on the wire: the bytes as standard base64. */
interface PlatformMailAttachment {
	readonly filename: string
	readonly contentType: string
	readonly contentBase64: string
}

/** The request body: the message's own fields in a fixed order, absent optional fields left out. */
interface PlatformMailRequest {
	readonly to: string
	readonly subject: string
	readonly text: string
	readonly html?: string
	readonly idempotencyKey: string
	readonly replyTo?: string
	readonly fromName?: string
	readonly unsubscribeUrl?: string
	readonly attachments?: readonly PlatformMailAttachment[]
}

function platformMailRequestOf(message: EmailMessage): PlatformMailRequest {
	const attachments = message.attachments ?? []
	return {
		to: message.to,
		subject: message.subject,
		text: message.text,
		...(message.html === undefined ? {} : { html: message.html }),
		idempotencyKey: message.idempotencyKey,
		...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
		...(message.fromName === undefined ? {} : { fromName: message.fromName }),
		...(message.unsubscribeUrl === undefined ? {} : { unsubscribeUrl: message.unsubscribeUrl }),
		...(attachments.length === 0
			? {}
			: {
				attachments: attachments.map((attachment) => ({
					filename: attachment.filename,
					contentType: attachment.contentType,
					contentBase64: base64Of(attachment.content),
				})),
			}),
	}
}

/**
 * The request body as JSON text. It is canonical: two messages with the same content encode to the same text, so the
 * relay fingerprints and stores this form.
 */
export function encodePlatformMailRequest(message: EmailMessage): string {
	return JSON.stringify(platformMailRequestOf(message))
}

/** The SHA-256 (hex) of the canonical request body: what tells a repeated send from a different one under the same key. */
export async function platformMailFingerprint(message: EmailMessage): Promise<string> {
	return hexOf(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encodePlatformMailRequest(message))))
}

/** The SHA-256 (hex) of a transport key: the only form the receiver stores. */
export async function hashPlatformKey(key: string): Promise<string> {
	return hexOf(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))
}

/**
 * The key an installation service (IAM) sends to the relay with: derived from the installation secret both it and
 * Control already hold, so an existing installation needs no new secret.
 */
export async function installationMailKey(installationSecret: string): Promise<string> {
	const secret = await crypto.subtle.importKey('raw', new TextEncoder().encode(installationSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
	return `px_${hexOf(await crypto.subtle.sign('HMAC', secret, new TextEncoder().encode('fabrika-platform-mail')))}`
}

function hexOf(digest: ArrayBuffer): string {
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/

/** Standard padded base64. A single character class, because a grouped pattern overflows on a 10 MiB attachment. */
function isBase64(value: string): boolean {
	return value.length % 4 === 0 && BASE64_ALPHABET.test(value)
}

const attachmentSchema = z.object({
	filename: z.string(),
	contentType: z.string(),
	contentBase64: z.string().refine(isBase64),
}).strict()

// Strict: a field this release does not know is refused, never dropped from a message someone will receive.
const requestSchema = z.object({
	to: z.string(),
	subject: z.string(),
	text: z.string(),
	html: z.string().optional(),
	idempotencyKey: z.string(),
	replyTo: z.string().optional(),
	fromName: z.string().optional(),
	unsubscribeUrl: z.string().optional(),
	attachments: z.array(attachmentSchema).optional(),
}).strict()

export type PlatformMailRequestResult =
	| { readonly ok: true; readonly message: EmailMessage }
	/** `reason` is a fixed text that names no recipient, subject or body. */
	| { readonly ok: false; readonly code: 'invalid_message'; readonly reason: string }

/** The relay's one parser of a request body (parsed JSON): a message the package's own validation accepts, or a refusal. */
export function parsePlatformMailRequest(body: unknown): PlatformMailRequestResult {
	const parsed = requestSchema.safeParse(body)
	if (!parsed.success) return { ok: false, code: 'invalid_message', reason: 'Platform mail request is malformed' }
	const { attachments, ...fields } = parsed.data
	const message: EmailMessage = {
		...fields,
		...(attachments === undefined || attachments.length === 0
			? {}
			: {
				attachments: attachments.map((attachment) => ({
					filename: attachment.filename,
					contentType: attachment.contentType,
					content: bytesOf(attachment.contentBase64),
				})),
			}),
	}
	try {
		validateEmailMessage(message)
		validateEmailAttachments(message, PLATFORM_MAIL_CAPABILITIES, LABEL)
	} catch (cause) {
		if (cause instanceof EmailDeliveryError) return { ok: false, code: 'invalid_message', reason: cause.message }
		throw cause
	}
	return { ok: true, message }
}

function bytesOf(base64: string): Uint8Array {
	return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
}

/** The HTTP status of each error the relay answers. */
export const PLATFORM_MAIL_ERROR_STATUS = {
	invalid_message: 400,
	provider_unauthorized: 401,
	idempotency_conflict: 409,
	// An installation sender's message when Control has no transport: refused at once, as `not_sent`.
	mail_not_configured: 503,
	provider_unavailable: 503,
} as const satisfies Partial<Record<EmailDeliveryErrorCode, number>>

export type PlatformMailErrorCode = keyof typeof PLATFORM_MAIL_ERROR_STATUS

export interface PlatformMailAccepted {
	readonly status: 'accepted'
	readonly messageId: string
}

/** The relay's answer as a sender reads it: any `EmailDeliveryErrorCode`, so its `retryable` and `outcome` carry over. */
export type PlatformMailAnswer = PlatformMailAccepted | { readonly error: { readonly code: EmailDeliveryErrorCode } }

/** The relay's answer as it writes one: an acceptance, or an error that has a status. */
export type PlatformMailReply = PlatformMailAccepted | { readonly error: { readonly code: PlatformMailErrorCode } }

/** `200 { status: 'accepted', messageId }`, or the error's status with `{ error: { code } }`. */
export function platformMailAnswerResponse(reply: PlatformMailReply): Response {
	if ('error' in reply) {
		return Response.json({ error: { code: reply.error.code } }, { status: PLATFORM_MAIL_ERROR_STATUS[reply.error.code] })
	}
	return Response.json({ status: 'accepted', messageId: reply.messageId }, { status: 200 })
}

const errorCodeSchema = z.string().refine((code): code is EmailDeliveryErrorCode => Object.hasOwn(EMAIL_DELIVERY_ERRORS, code))
const acceptedSchema = z.object({ status: z.literal('accepted'), messageId: z.string().min(1) })
const errorSchema = z.object({ error: z.object({ code: errorCodeSchema }) })

/**
 * The relay's answer from its status and parsed JSON body, or `null` when it is no answer the relay writes: an
 * acceptance under any status but 200, an error code under a success status, or anything else.
 */
export function parsePlatformMailAnswer(status: number, body: unknown): PlatformMailAnswer | null {
	if (status === 200) {
		const accepted = acceptedSchema.safeParse(body)
		return accepted.success ? { status: 'accepted', messageId: accepted.data.messageId } : null
	}
	if (status < 400) return null
	const refused = errorSchema.safeParse(body)
	return refused.success ? { error: { code: refused.data.error.code } } : null
}
