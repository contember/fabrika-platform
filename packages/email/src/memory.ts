// A sender that keeps every message in memory and delivers nothing: the stand-in for tests and local development.
// Runtime-neutral. Its faults let a test reproduce each answer a provider can give, including the one where the
// provider took the message and the answer was lost.

import { type EmailContent, emailContentOf, sameEmailContent } from './content.js'
import {
	EmailDeliveryError,
	type EmailDeliveryErrorCode,
	type EmailDeliveryResult,
	type EmailMessage,
	type EmailSender,
	type EmailSenderCapabilities,
} from './email.js'
import { validateEmailMessage } from './validation.js'

export interface MemoryEmail {
	readonly message: EmailMessage
	readonly messageId: string
	readonly acceptedAt: number
}

export interface MemoryHandoff {
	readonly message: EmailMessage
	readonly at: number
	/** Whether this call added the message to `accepted`. */
	readonly taken: boolean
	readonly answer: 'accepted' | EmailDeliveryErrorCode
}

export type MemoryRefusal = 'provider_rejected' | 'provider_unauthorized' | 'rate_limited' | 'quota_exceeded'

export interface MemoryEmailSenderOptions {
	readonly capabilities?: Partial<EmailSenderCapabilities>
	readonly provider?: string
	readonly now?: () => number
}

type MemoryHook = (message: EmailMessage, signal: AbortSignal) => Promise<void>
type MemoryFault = MemoryRefusal | 'provider_unavailable' | 'network_error'
type MemoryFailure = MemoryFault | 'aborted' | 'idempotency_conflict'

interface MutableHandoff {
	readonly message: EmailMessage
	readonly at: number
	taken: boolean
	answer: 'accepted' | EmailDeliveryErrorCode
}

interface KeyedEmail {
	readonly content: EmailContent
	readonly messageId: string
}

const FAULT_MESSAGES: Readonly<Record<MemoryFault, string>> = {
	provider_rejected: 'The memory sender rejected the message',
	provider_unauthorized: 'The memory sender refused the credentials',
	rate_limited: 'The memory sender rate limit was exceeded',
	quota_exceeded: 'The memory sender quota was exceeded',
	provider_unavailable: 'The memory sender is unavailable',
	network_error: 'The memory sender could not be reached',
}

export class MemoryEmailSender implements EmailSender {
	readonly capabilities: EmailSenderCapabilities
	readonly #provider: string
	readonly #now: () => number
	readonly #accepted: MemoryEmail[] = []
	readonly #handoffs: MutableHandoff[] = []
	readonly #byKey = new Map<string, KeyedEmail>()
	#fault: MemoryFault | null = null
	#lostAnswers = 0
	#during: MemoryHook | null = null
	#taken = 0

	constructor(options: MemoryEmailSenderOptions = {}) {
		this.capabilities = { idempotent: true, confirmation: 'sync', maxBatch: 1, ...options.capabilities }
		if (!Number.isSafeInteger(this.capabilities.maxBatch) || this.capabilities.maxBatch < 1) {
			throw new EmailDeliveryError('The memory sender batch size is invalid', { code: 'invalid_configuration' })
		}
		this.#provider = options.provider ?? 'memory'
		this.#now = options.now ?? Date.now
	}

	/** What reached the inbox, oldest first. */
	get accepted(): readonly MemoryEmail[] {
		return [...this.#accepted]
	}

	/** Every call that passed validation and the abort check. */
	get handoffs(): readonly MemoryHandoff[] {
		return this.#handoffs.map((handoff) => ({ ...handoff }))
	}

	/** Every following call is refused with `code` and takes nothing. */
	refuse(code: MemoryRefusal = 'provider_rejected'): void {
		this.#fault = code
	}

	/** Every following call answers `provider_unavailable` and takes nothing. */
	unavailable(): void {
		this.#fault = 'provider_unavailable'
	}

	/** Every following call answers `network_error` and takes nothing. */
	unreachable(): void {
		this.#fault = 'network_error'
	}

	/** The next `count` calls take the message, then answer `network_error`. */
	loseAnswers(count: number): void {
		this.#lostAnswers = count
	}

	/** Runs after the handoff is recorded and before the answer; a rejection becomes `aborted` once the signal aborted, else `network_error`. */
	during(hook: MemoryHook | null): void {
		this.#during = hook
	}

	heal(): void {
		this.#fault = null
		this.#lostAnswers = 0
		this.#during = null
	}

	async send(message: EmailMessage, signal: AbortSignal): Promise<EmailDeliveryResult> {
		validateEmailMessage(message)
		if (signal.aborted) throw failure('aborted')
		const handoff: MutableHandoff = { message, at: this.#now(), taken: false, answer: 'network_error' }
		this.#handoffs.push(handoff)
		const answer = (code: MemoryFailure): EmailDeliveryError => {
			handoff.answer = code
			return failure(code)
		}

		if (this.#during !== null) {
			try {
				await this.#during(message, signal)
			} catch {
				throw answer(signal.aborted ? 'aborted' : 'network_error')
			}
		}
		if (signal.aborted) throw answer('aborted')
		if (this.#fault !== null) throw answer(this.#fault)

		const content = emailContentOf(message)
		const previous = this.capabilities.idempotent ? this.#byKey.get(message.idempotencyKey) : undefined
		if (previous !== undefined && !sameEmailContent(previous.content, content)) throw answer('idempotency_conflict')
		const messageId = previous?.messageId ?? this.#take(message, content)
		handoff.taken = previous === undefined

		if (this.#lostAnswers > 0) {
			this.#lostAnswers -= 1
			throw answer('network_error')
		}
		handoff.answer = 'accepted'
		return { status: 'accepted', provider: this.#provider, messageId }
	}

	#take(message: EmailMessage, content: EmailContent): string {
		this.#taken += 1
		const messageId = `memory-${this.#taken}`
		this.#accepted.push({ message, messageId, acceptedAt: this.#now() })
		if (this.capabilities.idempotent) this.#byKey.set(message.idempotencyKey, { content, messageId })
		return messageId
	}
}

function failure(code: MemoryFailure): EmailDeliveryError {
	if (code === 'aborted') return new EmailDeliveryError('The memory sender call was aborted by the caller', { code })
	if (code === 'idempotency_conflict') {
		return new EmailDeliveryError('A different message was already accepted under this idempotency key', { code })
	}
	return new EmailDeliveryError(FAULT_MESSAGES[code], { code })
}
