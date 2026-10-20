import type { JobQueue } from '@fabrika/platform'
import type { MailMessageRepository } from '../db'
import { enqueueMailDispatch, type MailDispatchMessage } from './queue'

/** A queued message unchanged this long has lost its job, or its delayed job is overdue. */
export const MAIL_STALE_QUEUED_S = 10 * 60
/** How long a final message keeps its content (recipient, subject, bodies) for the console. */
export const MAIL_CONTENT_RETENTION_S = 30 * 24 * 60 * 60
const REQUEUE_BATCH = 100

export interface MailMaintenanceDeps {
	readonly messages: MailMessageRepository
	/** Absent on the Worker, which has no dispatcher: the pass then only purges. */
	readonly queue?: JobQueue<MailDispatchMessage>
	/** Unix seconds. */
	readonly now: number
}

export interface MailMaintenanceSummary {
	readonly requeued: number
	readonly purged: number
}

/** Re-enqueues the queued messages the dispatcher lost, and forgets the content of final ones past retention. */
export async function runMailMaintenance(deps: MailMaintenanceDeps): Promise<MailMaintenanceSummary> {
	let requeued = 0
	if (deps.queue !== undefined) {
		for (const row of await deps.messages.listDueQueued(deps.now - MAIL_STALE_QUEUED_S, deps.now, REQUEUE_BATCH)) {
			await enqueueMailDispatch(deps.queue, row.id)
			requeued++
		}
	}
	const purged = await deps.messages.purgeFinalContent(deps.now - MAIL_CONTENT_RETENTION_S)
	return { requeued, purged }
}
