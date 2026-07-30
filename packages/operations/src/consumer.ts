import type { IngestMessage } from '@fabrika/operations-contract'
import type { OperationsDataEnv } from './pipeline.js'
import { archiveDeadEvent, persistIngest } from './pipeline.js'

export interface IngestDelivery {
	body: IngestMessage
	attempts: number
	ack(): void
	retry(): void
}

export async function consumeDeliveries(env: OperationsDataEnv, deliveries: IngestDelivery[]): Promise<void> {
	for (const delivery of deliveries) {
		try {
			await persistIngest(env, delivery.body)
			delivery.ack()
		} catch {
			delivery.retry()
		}
	}
}

export async function consumeDeadDeliveries(env: OperationsDataEnv, deliveries: IngestDelivery[]): Promise<void> {
	for (const delivery of deliveries) {
		try {
			await archiveDeadEvent(env, delivery.body, {
				attempts: delivery.attempts,
				reason: 'retry_exhausted',
			})
			delivery.ack()
		} catch {
			delivery.retry()
		}
	}
}
