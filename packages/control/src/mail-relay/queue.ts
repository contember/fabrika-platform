import type { EmailSender } from '@fabrika/email'
import type { JobQueue } from '@fabrika/platform'
import { z } from 'zod'
import type { MailMessageRepository } from '../db'

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
