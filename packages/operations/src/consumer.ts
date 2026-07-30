import type { IngestMessage } from '@fabrika/operations-contract'
import type { OperationsDataEnv } from './pipeline.js'
import { archiveDeadEvent, effectiveIngestMessage, persistIngestGroup } from './pipeline.js'

export interface IngestDelivery {
	body: IngestMessage
	attempts: number
	ack(): void
	retry(): void
}

export async function consumeDeliveries(env: OperationsDataEnv, deliveries: IngestDelivery[]): Promise<void> {
	const rawGroups = new Map<string, IngestDelivery[]>()
	for (const delivery of deliveries) {
		const key = JSON.stringify([delivery.body.projectId, delivery.body.fingerprint])
		const group = rawGroups.get(key) ?? []
		group.push(delivery)
		rawGroups.set(key, group)
	}
	const groups = new Map<string, { delivery: IngestDelivery; message: IngestMessage }[]>()
	for (const rawGroup of rawGroups.values()) {
		const first = rawGroup[0]
		if (!first) continue
		try {
			const effective = await effectiveIngestMessage(env, first.body)
			const key = JSON.stringify([effective.projectId, effective.fingerprint])
			const group = groups.get(key) ?? []
			for (const delivery of rawGroup) {
				const message = delivery.body.fingerprint === effective.fingerprint
					? delivery.body
					: { ...delivery.body, fingerprint: effective.fingerprint }
				group.push({ delivery, message })
			}
			groups.set(key, group)
		} catch {
			for (const delivery of rawGroup) delivery.retry()
		}
	}
	for (const group of groups.values()) {
		for (let offset = 0; offset < group.length; offset += 50) {
			const chunk = group.slice(offset, offset + 50)
			try {
				await persistIngestGroup(env, chunk.map((item) => item.message))
				for (const item of chunk) item.delivery.ack()
			} catch {
				for (const item of chunk) item.delivery.retry()
			}
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
