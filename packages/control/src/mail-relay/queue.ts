import type { EmailSender } from '@fabrika/email'
import type { JobQueue } from '@fabrika/platform'
import { z } from 'zod'
import type { MailMessageRepository, MailMessageRow } from '../db'

/** Whether a sender is an installation service (`installation:<service>`), not an application environment. */
export function isInstallationSender(sender: string): boolean {
	return sender.startsWith('installation:')
}

/** One dispatch job: the id of a `queued` message. The row, not the job, holds the message and its state. */
export interface MailDispatchMessage {
	readonly messageId: string
}

const dispatchMessageSchema = z.object({ messageId: z.string().min(1) })

/** Narrows a stored job payload; throws on anything else, which the consumer retries and then abandons. */
export function decodeMailDispatchMessage(payload: unknown): MailDispatchMessage {
	return dispatchMessageSchema.parse(payload)
}

/** The relay's process half. Only the Bun process has one; the Worker answers the relay's row with 404. */
export interface MailRelay {
	readonly queue: JobQueue<MailDispatchMessage>
	/** Control's `FABRIKA_IAM_RPC_KEY`, which IAM's mail key is derived from (`installationMailKey`). */
	readonly installationSecret: string
	/** The installation's sender over Control's own `FABRIKA_EMAIL_*`; `null` when Control has no transport. */
	readonly sender: EmailSender | null
}

export function enqueueMailDispatch(queue: JobQueue<MailDispatchMessage>, messageId: string, delaySeconds = 0): Promise<void> {
	return queue.send({ messageId }, delaySeconds > 0 ? { delaySeconds } : {})
}

export interface MailReleaseDeps {
	readonly messages: MailMessageRepository
	readonly queue: JobQueue<MailDispatchMessage>
}

/**
 * A person releases a held message: `held` → `queued`, then one dispatch job. `false`: the message is not held (any
 * more), and nothing is enqueued. A lost enqueue is repaired by maintenance, which re-enqueues stale queued rows.
 */
export async function releaseMailMessage(deps: MailReleaseDeps, id: string, decidedBy: string, now: number): Promise<boolean> {
	if (!(await deps.messages.release(id, decidedBy, now))) return false
	await enqueueMailDispatch(deps.queue, id)
	return true
}

/**
 * The final states a person may send again: `failed` always, and `unknown` only over an idempotent transport, where
 * a second send under the relay's key is not delivered twice.
 */
export function requeueableMailStates(sender: EmailSender | null): readonly ('failed' | 'unknown')[] {
	return sender?.capabilities.idempotent === true ? ['failed', 'unknown'] : ['failed']
}

/** Whether `requeueMailMessage` would requeue the message now. */
export function mayRequeueMail(row: MailMessageRow, sender: EmailSender | null): boolean {
	return row.content !== null && requeueableMailStates(sender).some((state) => state === row.state)
}

export interface MailRequeueDeps {
	readonly messages: MailMessageRepository
	readonly queue: JobQueue<MailDispatchMessage>
	/** The relay's transport, whose idempotency decides whether an `unknown` message may go again. */
	readonly sender: EmailSender | null
}

/**
 * A person sends a final message again: `failed`, or `unknown` over an idempotent transport → `queued` with its
 * attempts spent anew, then one dispatch job. `false`: it is in no such state, or its content is gone.
 */
export async function requeueMailMessage(deps: MailRequeueDeps, id: string, decidedBy: string, now: number): Promise<boolean> {
	if (!(await deps.messages.requeue(id, requeueableMailStates(deps.sender), decidedBy, now))) return false
	await enqueueMailDispatch(deps.queue, id)
	return true
}
