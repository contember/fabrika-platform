// The dispatcher: one job sends one `queued` message through the installation's own transport and settles its row.
// Runtime-neutral; the Bun process runs it from the `vozka-mail` queue.
//
// A message can have more than one job (a retry, a release, maintenance), and Control can run two consumers. Each
// attempt is claimed before the send (`queued` → `sending`), so exactly one consumer sends it, and its outcome is
// recorded against that claim.

import { EmailDeliveryError, type EmailMessage, type EmailSender, mayRetryDelivery } from '@fabrika/email'
import { parsePlatformMailRequest } from '@fabrika/email/platform'
import type { JobQueue } from '@fabrika/platform'
import type { MailMessageRepository, MailMessageRow } from '../db'
import { enqueueMailDispatch, isInstallationSender, type MailDispatchMessage } from './queue'

export const MAIL_SEND_TIMEOUT_MS = 30_000
// The retry schedule of an application's queue table with its default one-minute tick (`@fabrika/db`:
// `DEFAULT_MAX_ATTEMPTS` and the claim backoff in `orm.ts`): before the relay, a 0.6 outbox retried mail on it.
// Mirrored, because Control does not depend on the application data layer.
/** Attempts of one message, the first included, before a retryable failure becomes final. */
export const MAIL_MAX_ATTEMPTS = 10
const FIRST_RETRY_DELAY_S = 60
const MAX_RETRY_DELAY_S = 30 * 24 * 60 * 60
/** A claim this old belongs to a consumer that stopped: far past the send deadline and the writes around it. */
export const MAIL_STALE_CLAIM_S = 10 * 60
/** The error code of an attempt whose consumer stopped after the claim, before it recorded an outcome. */
export const MAIL_DISPATCH_INTERRUPTED = 'dispatch_interrupted'
/** The longest idempotency key `EmailMessage` allows. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 256

export interface MailDispatchDeps {
	readonly messages: MailMessageRepository
	readonly queue: JobQueue<MailDispatchMessage>
	/** `null`: Control has no transport, and a queued message waits for one; maintenance enqueues it again. */
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

/**
 * Sends the message the job names, once it is `queued` and due, or settles an attempt whose consumer stopped. A
 * consumer that loses the claim does nothing. A throw is unexpected, and the consumer retries it.
 */
export async function dispatchMail(deps: MailDispatchDeps, job: MailDispatchMessage): Promise<MailDispatchResult> {
	const row = await deps.messages.get(job.messageId)
	if (row === null) return { status: 'skipped' }
	const now = deps.now()
	if (row.state === 'queued') {
		// A deferred attempt has its own delayed job; an early duplicate leaves the message to it.
		if (row.next_attempt_at !== null && row.next_attempt_at > now) return { status: 'skipped' }
		// As a 0.6 application's outbox did, the message waits for a transport without spending an attempt.
		if (deps.sender === null) return { status: 'skipped' }
		if (!(await deps.messages.claim(row.id, row.attempts, now))) return { status: 'skipped' }
		return await attempt(deps, deps.sender, row, row.attempts + 1)
	}
	if (row.state === 'sending' && row.updated_at <= now - MAIL_STALE_CLAIM_S) return await settleStaleClaim(deps, row)
	return { status: 'skipped' }
}

/**
 * The provider may have taken the stopped attempt. Only an idempotent transport may send it again, under the same
 * key; over any other the message is `unknown`, for a person.
 */
async function settleStaleClaim(deps: MailDispatchDeps, row: MailMessageRow): Promise<MailDispatchResult> {
	const now = deps.now()
	const sender = deps.sender
	if (sender !== null && sender.capabilities.idempotent && row.attempts < MAIL_MAX_ATTEMPTS) {
		if (!(await deps.messages.reclaim(row.id, row.attempts, now - MAIL_STALE_CLAIM_S, now))) return { status: 'skipped' }
		console.warn(`mail relay: message ${row.id} attempt ${row.attempts} was interrupted; sending again under its key`)
		return await attempt(deps, sender, row, row.attempts + 1)
	}
	return await settleUndelivered(deps, row, 'unknown', MAIL_DISPATCH_INTERRUPTED, row.attempts)
}

/** Runs the claimed attempt `attempts` and records its outcome against that claim. */
async function attempt(deps: MailDispatchDeps, sender: EmailSender, row: MailMessageRow, attempts: number): Promise<MailDispatchResult> {
	const message = await storedMessage(row)
	if (message === null) return await settleUndelivered(deps, row, 'failed', 'invalid_message', attempts)

	let providerMessageId: string
	try {
		providerMessageId = (await sender.send(message, AbortSignal.timeout(deps.timeoutMs ?? MAIL_SEND_TIMEOUT_MS))).messageId
	} catch (cause) {
		if (!(cause instanceof EmailDeliveryError)) throw cause
		if (mayRetryDelivery(cause, sender.capabilities) && attempts < MAIL_MAX_ATTEMPTS) {
			const delaySeconds = mailRetryDelaySeconds(attempts)
			if (!(await deps.messages.defer(row.id, attempts, deps.now() + delaySeconds, cause.code, deps.now()))) return { status: 'skipped' }
			await enqueueMailDispatch(deps.queue, row.id, delaySeconds)
			console.warn(`mail relay: message ${row.id} attempt ${attempts} failed (${cause.code}); retrying in ${delaySeconds}s`)
			return { status: 'requeued', delaySeconds }
		}
		return await settleUndelivered(deps, row, cause.outcome === 'not_sent' ? 'failed' : 'unknown', cause.code, attempts)
	}
	if (!(await deps.messages.markSent(row.id, providerMessageId, attempts, deps.now()))) {
		console.warn(`mail relay: message ${row.id} attempt ${attempts} was sent, but its claim was no longer held`)
		return { status: 'skipped' }
	}
	await forgetInstallationContent(deps, row)
	console.info(`mail relay: message ${row.id} sent`)
	return { status: 'sent' }
}

/** The wait after the failed attempt `attempts`: one minute, doubled per further attempt, at most 30 days. */
export function mailRetryDelaySeconds(attempts: number): number {
	return Math.min(FIRST_RETRY_DELAY_S * 2 ** (attempts - 1), MAX_RETRY_DELAY_S)
}

async function settleUndelivered(
	deps: MailDispatchDeps,
	row: MailMessageRow,
	state: 'failed' | 'unknown',
	code: string,
	attempts: number,
): Promise<MailDispatchResult> {
	if (!(await deps.messages.markUndelivered(row.id, state, code, attempts, deps.now()))) return { status: 'skipped' }
	await forgetInstallationContent(deps, row)
	console.warn(`mail relay: message ${row.id} ${state} (${code})`)
	return { status: state, code }
}

/** An installation message carries a one-time link (IAM's sign-in), so its content is not kept once it is final. */
async function forgetInstallationContent(deps: MailDispatchDeps, row: MailMessageRow): Promise<void> {
	if (isInstallationSender(row.sender)) await deps.messages.purgeContent(row.id)
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
