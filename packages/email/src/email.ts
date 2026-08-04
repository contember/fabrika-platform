export interface EmailMessage {
	readonly to: string
	readonly subject: string
	readonly text: string
	readonly html?: string
	readonly idempotencyKey: string
}

export interface EmailDeliveryResult {
	readonly status: 'accepted'
	readonly provider: string
	readonly messageId: string
}

export interface EmailSender {
	send(message: EmailMessage): Promise<EmailDeliveryResult>
}

export type EmailDeliveryErrorCode =
	| 'invalid_configuration'
	| 'invalid_message'
	| 'network_error'
	| 'request_timeout'
	| 'rate_limited'
	| 'request_in_progress'
	| 'provider_rejected'
	| 'provider_unavailable'
	| 'malformed_response'

export interface EmailDeliveryErrorOptions {
	readonly code: EmailDeliveryErrorCode
	readonly retryable: boolean
	readonly httpStatus?: number
}

export class EmailDeliveryError extends Error {
	readonly code: EmailDeliveryErrorCode
	readonly retryable: boolean
	readonly httpStatus: number | undefined

	constructor(message: string, options: EmailDeliveryErrorOptions) {
		super(message)
		this.name = 'EmailDeliveryError'
		this.code = options.code
		this.retryable = options.retryable
		this.httpStatus = options.httpStatus
	}
}
