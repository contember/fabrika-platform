// The dispatcher: one job sends one `queued` message through the installation's own transport and settles its row.
// Runtime-neutral; the Bun process runs it from the `vozka-mail` queue.

import { EmailDeliveryError, type EmailMessage, type EmailSender, mayRetryDelivery } from '@fabrika/email'
import { parsePlatformMailRequest } from '@fabrika/email/platform'
import type { JobQueue } from '@fabrika/platform'
import type { MailMessageRepository, MailMessageRow } from '../db'
import { enqueueMailDispatch, type MailDispatchMessage } from './queue'

export const MAIL_SEND_TIMEOUT_MS = 30_000
/** Attempts of one message, the first included, before a retryable failure becomes final. */
export const MAIL_MAX_ATTEMPTS = 5
const FIRST_RETRY_DELAY_S = 60
/** The longest idempotency key `EmailMessage` allows. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 256

export interface MailDispatchDeps {
	readonly messages: MailMessageRepository
	readonly queue: JobQueue<MailDispatchMessage>
	/** `null`: Control has no transport, and a queued message fails as `mail_not_configured`. */
	readonly sender: EmailSender | null
	/** Unix seconds. */
	readonly now: () => number
	readonly timeoutMs?: number
}

export type MailDispatchResult =
	| { readonly status: 'skipped' }
	| { readonly status: 'sent' }
	| { readonly status: 'requeued'; readonly delaySeconds: number }
	| { readonly status: 'failed' | 'unknown'; readonly code: string }

/** Sends the message the job names, once it is `queued` and due. A throw is unexpected, and the consumer retries it. */
export async function dispatchMail(deps: MailDispatchDeps, job: MailDispatchMessage): Promise<MailDispatchResult> {
	const row = await deps.messages.get(job.messageId)
	if (row === null || row.state !== 'queued') return { status: 'skipped' }
	// A deferred attempt has its own delayed job; an early duplicate leaves the message to it.
	if (row.next_attempt_at !== null && row.next_attempt_at > deps.now()) return { status: 'skipped' }

	const attempts = row.attempts + 1
	if (deps.sender === null) return await settleUndelivered(deps, row, 'failed', 'mail_not_configured', attempts)
	const message = await storedMessage(row)
	if (message === null) return await settleUndelivered(deps, row, 'failed', 'invalid_message', attempts)

	try {
		const result = await deps.sender.send(message, AbortSignal.timeout(deps.timeoutMs ?? MAIL_SEND_TIMEOUT_MS))
		if (!(await deps.messages.markSent(row.id, result.messageId, attempts, deps.now()))) return { status: 'skipped' }
		// An installation message (IAM's sign-in links) is not kept once it left.
		if (row.sender.startsWith('installation:')) await deps.messages.purgeContent(row.id)
		console.info(`mail relay: message ${row.id} sent`)
		return { status: 'sent' }
	} catch (cause) {
		if (!(cause instanceof EmailDeliveryError)) throw cause
		if (mayRetryDelivery(cause, deps.sender.capabilities) && attempts < MAIL_MAX_ATTEMPTS) {
			const delaySeconds = FIRST_RETRY_DELAY_S * 2 ** row.attempts
			if (!(await deps.messages.requeue(row.id, row.attempts, deps.now() + delaySeconds, cause.code, deps.now()))) return { status: 'skipped' }
			await enqueueMailDispatch(deps.queue, row.id, delaySeconds)
			console.warn(`mail relay: message ${row.id} attempt ${attempts} failed (${cause.code}); retrying in ${delaySeconds}s`)
			return { status: 'requeued', delaySeconds }
		}
		return await settleUndelivered(deps, row, cause.outcome === 'not_sent' ? 'failed' : 'unknown', cause.code, attempts)
	}
}

async function settleUndelivered(
	deps: MailDispatchDeps,
	row: MailMessageRow,
	state: 'failed' | 'unknown',
	code: string,
	attempts: number,
): Promise<MailDispatchResult> {
	if (!(await deps.messages.markUndelivered(row.id, state, code, attempts, deps.now()))) return { status: 'skipped' }
	console.warn(`mail relay: message ${row.id} ${state} (${code})`)
	return { status: state, code }
}

/** The stored request, parsed again at the row boundary, under the relay's own key. `null`: none, or unreadable. */
async function storedMessage(row: MailMessageRow): Promise<EmailMessage | null> {
	if (row.content === null) return null
	let json: unknown
	try {
		json = JSON.parse(row.content)
	} catch {
		return null
	}
	const parsed = parsePlatformMailRequest(json)
	if (!parsed.ok) return null
	return { ...parsed.message, idempotencyKey: await relayIdempotencyKey(row.sender, row.idempotency_key) }
}

/**
 * `relay:<sender>:<key>`, which keeps two senders' keys apart at the provider. A sender's key may already take the
 * whole length a message allows, so a longer one is replaced by its SHA-256.
 */
export async function relayIdempotencyKey(sender: string, idempotencyKey: string): Promise<string> {
	const plain = `relay:${sender}:${idempotencyKey}`
	if (plain.length <= MAX_IDEMPOTENCY_KEY_LENGTH) return plain
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${sender}:${idempotencyKey}`))
	return `relay:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
