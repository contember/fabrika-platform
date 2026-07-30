import type { AlertsRepository, ClaimedNotification } from './repositories.js'

export interface NotificationSender {
	send(input: {
		type: string
		target: string
		payload: Record<string, unknown>
		idempotencyKey: string
		signal?: AbortSignal
	}): Promise<void>
}

export interface OperationsLogger {
	warn(message: string, fields: { notificationId: string; attempt: number }): void
}

export interface OperationsMaintenanceOptions {
	batchSize?: number
	leaseMs?: number
	retryDelayMs?: (attempt: number) => number
	logger?: OperationsLogger
}

const silentLogger: OperationsLogger = { warn() {} }

export class OperationsMaintenance {
	private readonly batchSize: number
	private readonly leaseMs: number
	private readonly retryDelayMs: (attempt: number) => number
	private readonly logger: OperationsLogger

	constructor(
		private readonly alerts: AlertsRepository,
		private readonly sender: NotificationSender,
		options: OperationsMaintenanceOptions = {},
	) {
		this.batchSize = options.batchSize ?? 50
		this.leaseMs = options.leaseMs ?? 60_000
		this.retryDelayMs = options.retryDelayMs ?? ((attempt) => Math.min(15 * 60_000, 1_000 * 2 ** attempt))
		this.logger = options.logger ?? silentLogger
	}

	async run(signal?: AbortSignal): Promise<{ prunedClaims: number; notifications: number }> {
		const prunedClaims = await this.alerts.pruneClaims()
		const claimed = await this.alerts.claimNotifications({ limit: this.batchSize, leaseMs: this.leaseMs })
		for (const notification of claimed) {
			if (signal?.aborted) break
			await this.deliver(notification, signal)
		}
		return { prunedClaims, notifications: claimed.length }
	}

	private async deliver(notification: ClaimedNotification, signal?: AbortSignal): Promise<void> {
		try {
			await this.sender.send({
				type: notification.type,
				target: notification.target,
				payload: notification.payload,
				idempotencyKey: notification.dedupKey,
				...(signal ? { signal } : {}),
			})
			await this.alerts.completeNotification({
				id: notification.id,
				claimToken: notification.claimToken,
				delivered: true,
			})
		} catch {
			this.logger.warn('notification delivery failed', {
				notificationId: notification.id,
				attempt: notification.attempts,
			})
			await this.alerts.completeNotification({
				id: notification.id,
				claimToken: notification.claimToken,
				delivered: false,
				retryDelayMs: this.retryDelayMs(notification.attempts),
				errorCode: 'delivery_failed',
			})
		}
	}
}

export type NotificationFetch = (request: Request) => Promise<Response>

export class WebhookNotificationSender implements NotificationSender {
	constructor(private readonly fetch: NotificationFetch = globalThis.fetch) {}

	async send(input: {
		type: string
		target: string
		payload: Record<string, unknown>
		idempotencyKey: string
		signal?: AbortSignal
	}): Promise<void> {
		if (input.type !== 'webhook') throw new Error('unsupported notification channel')
		const response = await this.fetch(
			new Request(input.target, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'Idempotency-Key': input.idempotencyKey,
				},
				body: JSON.stringify(input.payload),
				...(input.signal ? { signal: input.signal } : {}),
			}),
		)
		if (!response.ok) throw new Error('notification endpoint rejected delivery')
	}
}
