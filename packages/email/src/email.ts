export type EmailFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** One file a message carries: the name the recipient sees, its media type and its bytes. */
export interface EmailAttachment {
	readonly filename: string
	readonly contentType: string
	readonly content: Uint8Array
}

export interface EmailMessage {
	readonly to: string
	readonly subject: string
	readonly text: string
	readonly html?: string
	/** 1..256 visible ASCII characters (Resend's limit). A prefix the caller adds must fit inside it. */
	readonly idempotencyKey: string
	/** One mailbox address. */
	readonly replyTo?: string
	/** Replaces the transport's display name for this message. */
	readonly fromName?: string
	/**
	 * An `https:` URL that unsubscribes the recipient in one click (RFC 8058): the transport writes `List-Unsubscribe:
	 * <url>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. A transport without `listUnsubscribe` refuses it.
	 */
	readonly unsubscribeUrl?: string
	/**
	 * One message of a send to many recipients (a newsletter, an announcement), not a reply to what the recipient did.
	 * A provider keeps such mail apart from transactional mail, and the law and the mailbox providers ask it to carry
	 * an unsubscribe, so it needs `unsubscribeUrl`. A transport without `broadcast` refuses it.
	 */
	readonly broadcast?: boolean
	/**
	 * Files the message carries, at most `MAX_EMAIL_ATTACHMENTS`, together at most the transport's `maxAttachmentBytes`.
	 * A transport without `maxAttachmentBytes` refuses a message that has any; an empty list is none.
	 */
	readonly attachments?: readonly EmailAttachment[]
}

export interface EmailDeliveryResult {
	readonly status: 'accepted'
	readonly provider: string
	readonly messageId: string
}

export interface EmailSenderCapabilities {
	/** A repeated send under one key with the same message is not delivered again. */
	readonly idempotent: boolean
	/** 'sync': `accepted` means the provider took the message. 'queued': it queued the request and may still drop it. */
	readonly confirmation: 'sync' | 'queued'
	/** The most messages one call carries. `send` carries one, so every built-in adapter reports 1. */
	readonly maxBatch: number
	/** Whether it writes a message's one-click unsubscribe headers (`unsubscribeUrl`); absent is no. */
	readonly listUnsubscribe?: boolean
	/** The most attachment bytes one message carries, every file together; absent: it sends no attachments. */
	readonly maxAttachmentBytes?: number
	/** File extensions it refuses an attachment for, lowercase and without the dot; absent: none. */
	readonly refusedAttachmentExtensions?: readonly string[]
	/** The fewest characters a text or HTML body has once trimmed; absent: any body that is not blank. */
	readonly minBodyLength?: number
	/** Whether it sends a `broadcast` message, on its provider's channel for them where it has one; absent is no. */
	readonly broadcast?: boolean
}

export interface EmailSender {
	readonly capabilities: EmailSenderCapabilities
	send(message: EmailMessage, signal: AbortSignal): Promise<EmailDeliveryResult>
}

/** 'not_sent': the provider did not take the message. 'unknown': it may have taken it. */
export type EmailDeliveryOutcome = 'not_sent' | 'unknown'

/** The one classification of every failure: an adapter names the code, and the code decides the rest. */
export const EMAIL_DELIVERY_ERRORS = {
	invalid_configuration: { retryable: false, outcome: 'not_sent' },
	invalid_message: { retryable: false, outcome: 'not_sent' },
	// The installation has no transport (`FABRIKA_EMAIL_PROVIDER=none`): the message waits for one, it is not refused.
	mail_not_configured: { retryable: false, outcome: 'not_sent' },
	aborted: { retryable: true, outcome: 'unknown' },
	network_error: { retryable: true, outcome: 'unknown' },
	request_timeout: { retryable: true, outcome: 'unknown' },
	request_in_progress: { retryable: true, outcome: 'unknown' },
	idempotency_conflict: { retryable: false, outcome: 'unknown' },
	provider_unauthorized: { retryable: false, outcome: 'not_sent' },
	rate_limited: { retryable: true, outcome: 'not_sent' },
	quota_exceeded: { retryable: true, outcome: 'not_sent' },
	provider_rejected: { retryable: false, outcome: 'not_sent' },
	provider_unavailable: { retryable: true, outcome: 'unknown' },
	malformed_response: { retryable: true, outcome: 'unknown' },
} as const satisfies Record<string, { readonly retryable: boolean; readonly outcome: EmailDeliveryOutcome }>

export type EmailDeliveryErrorCode = keyof typeof EMAIL_DELIVERY_ERRORS

export interface EmailDeliveryErrorOptions {
	readonly code: EmailDeliveryErrorCode
	readonly httpStatus?: number
}

/** Its message is a fixed string plus the HTTP status: never a credential, a response body, a subject or a body. */
export class EmailDeliveryError extends Error {
	readonly code: EmailDeliveryErrorCode
	readonly retryable: boolean
	readonly outcome: EmailDeliveryOutcome
	readonly httpStatus: number | undefined

	constructor(message: string, options: EmailDeliveryErrorOptions) {
		super(message)
		this.name = 'EmailDeliveryError'
		this.code = options.code
		this.retryable = EMAIL_DELIVERY_ERRORS[options.code].retryable
		this.outcome = EMAIL_DELIVERY_ERRORS[options.code].outcome
		this.httpStatus = options.httpStatus
	}
}

/** The two headers of a one-click unsubscribe (RFC 8058), as a transport writes them for `unsubscribeUrl`. */
export function oneClickUnsubscribeHeaders(url: string): Readonly<Record<string, string>> {
	return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
}

/** The one retry rule: an unknown outcome is retried only over an idempotent transport. */
export function mayRetryDelivery(error: EmailDeliveryError, capabilities: EmailSenderCapabilities): boolean {
	return error.retryable && (error.outcome === 'not_sent' || capabilities.idempotent)
}

/** The bytes of every attachment of `message` together. */
export function attachmentBytes(message: EmailMessage): number {
	return (message.attachments ?? []).reduce((total, attachment) => total + attachment.content.byteLength, 0)
}
