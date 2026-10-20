/** The mail relay as the console reads and steers it. */

/**
 * `held` waits for a person, `queued` for the dispatcher, `sending` is one attempt a dispatcher claimed. `sent`,
 * `failed` (not sent), `unknown` (may have left) and `dropped` are final.
 */
export type MailMessageState = 'held' | 'queued' | 'sending' | 'sent' | 'failed' | 'unknown' | 'dropped'

export type MailRuleAction = 'pass' | 'hold' | 'drop'

/** A relayed message's metadata, behind `mail.read`. It carries no recipient, subject or body. */
export interface MailMessageDto {
	readonly id: string
	/** `<app>@<env>`, or `installation:<service>` for an installation sender. */
	readonly sender: string
	readonly recipientDomain: string
	readonly state: MailMessageState
	/** The rule that decided the message at acceptance; null when none did. */
	readonly ruleId: string | null
	/** Who released or dropped it, or requeued it once it was final. */
	readonly decidedBy: string | null
	readonly attempts: number
	readonly nextAttemptAt: number | null
	readonly providerMessageId: string | null
	/**
	 * The `EmailDeliveryErrorCode` of the last failed attempt, or `dispatch_interrupted`: the dispatcher stopped after it
	 * claimed the attempt, before it recorded an outcome.
	 */
	readonly errorCode: string | null
	readonly createdAt: number
	readonly updatedAt: number
}

/** One attachment as the console shows it: its name, type and size, never its bytes. */
export interface MailAttachmentDto {
	readonly filename: string
	readonly contentType: string
	readonly bytes: number
}

/** What the recipient sees, behind `mail.content.read`. */
export interface MailMessageContentDto {
	readonly to: string
	readonly subject: string
	readonly text: string
	readonly html?: string
	readonly replyTo?: string
	readonly fromName?: string
	readonly unsubscribeUrl?: string
	readonly attachments: readonly MailAttachmentDto[]
}

/** `withheld`: the caller does not hold `mail.content.read`. `purged`: the relay no longer keeps it. */
export type MailContentDto =
	| { readonly kind: 'withheld' }
	| { readonly kind: 'purged' }
	| { readonly kind: 'present'; readonly message: MailMessageContentDto }

export interface MailMessageDetailDto extends MailMessageDto {
	readonly content: MailContentDto
	/** Whether a requeue would send it again now: `failed`, or `unknown` over an idempotent transport, with its content kept. */
	readonly requeueable: boolean
}

export interface MailMessageListInput {
	readonly state?: MailMessageState
	/** One sender: `<app>@<env>` or `installation:<service>`. */
	readonly scope?: string
	readonly cursor?: string
}

export interface MailMessageIdInput {
	readonly id: string
}

export interface MailRuleDto {
	readonly id: string
	/** `*` or `<app>@<env>`. */
	readonly scope: string
	/** `*` or a lowercase recipient domain. */
	readonly domain: string
	readonly action: MailRuleAction
	readonly createdAt: number
	readonly updatedAt: number
}

/** Sets the action of the rule of `scope` and `domain`, creating it when there is none. */
export interface SetMailRuleInput {
	readonly scope: string
	readonly domain: string
	readonly action: MailRuleAction
}

export interface MailRuleIdInput {
	readonly id: string
}
