import type {
	OperationsAlertKind,
	OperationsAlertSettingsResponseDto,
	OperationsNotificationChannelRequestDto,
	OperationsSpikeAlertRequestDto,
} from '@fabrika/operations-contract/operator-api'
import { alertKind } from '../operator-input.js'
import { uuidv7 } from '../uuid.js'
import { isValidWebhookTarget } from '../webhook-target.js'
import { visibleSource } from './access.js'
import type { OperationsOperatorOptions } from './context.js'
import { badRequest, notFoundError } from './errors.js'
import { now } from './values.js'

export async function alertSettings(sourceId: string, options: OperationsOperatorOptions): Promise<OperationsAlertSettingsResponseDto> {
	await visibleSource(sourceId, 'operations.manage', options)
	const [config, rules, channels, deliveries] = await Promise.all([
		options.repositories.alerts.getConfig(sourceId),
		options.repositories.alerts.listRules(sourceId),
		options.repositories.alerts.listChannels(sourceId),
		options.repositories.operator.listNotificationDeliveries(sourceId),
	])
	return {
		spike: config === null ? null : { threshold: config.threshold, enabled: config.enabled === 1 },
		rules: rules.flatMap((rule) => {
			const kind = alertKind(rule.type)
			return kind === null ? [] : [{ kind, enabled: rule.enabled === 1 }]
		}),
		channels: channels.flatMap((channel) => {
			const scope = alertKind(channel.scope)
			return scope === null || channel.type !== 'webhook'
				? []
				: [{
					id: channel.id,
					scope,
					type: 'webhook',
					targetDisplay: redactTarget(channel.target),
					hasTarget: channel.target !== '',
					enabled: channel.enabled === 1,
				}]
		}),
		deliveries: deliveries.flatMap((delivery) => {
			const kind = alertKind(delivery.kind)
			return kind === null
				? []
				: [{
					id: delivery.id,
					channelId: delivery.channel_id,
					kind,
					createdAt: delivery.created_at,
					attemptCount: delivery.attempts,
					maxAttempts: delivery.max_attempts,
					status: notificationStatus(delivery.delivered_at, delivery.abandoned_at),
					deliveredAt: delivery.delivered_at,
					abandonedAt: delivery.abandoned_at,
					attempts: delivery.attempt_history.map((attempt) => ({
						id: attempt.id,
						attemptedAt: attempt.attempted_at,
						delivered: attempt.delivered === 1,
						errorCode: attempt.error_code,
					})),
				}]
		}),
	}
}

export async function updateSpikeAlert(
	sourceId: string,
	loadInput: () => Promise<OperationsSpikeAlertRequestDto>,
	options: OperationsOperatorOptions,
): Promise<{ threshold: number; enabled: boolean }> {
	await visibleSource(sourceId, 'operations.manage', options)
	const input = await loadInput()
	const { threshold, enabled } = input
	await options.repositories.alerts.setConfig(sourceId, { threshold, enabled })
	await options.auth.audit({ action: 'operations.alert.spike', resourceType: 'operations_source', resourceId: sourceId })
	return { threshold, enabled }
}

export async function updateAlertRule(
	sourceId: string,
	loadKind: () => Promise<OperationsAlertKind>,
	loadInput: () => Promise<{ enabled: boolean }>,
	options: OperationsOperatorOptions,
): Promise<{ kind: OperationsAlertKind; enabled: boolean }> {
	await visibleSource(sourceId, 'operations.manage', options)
	const kind = await loadKind()
	const input = await loadInput()
	const { enabled } = input
	await options.repositories.alerts.setRule(sourceId, kind, enabled)
	await options.auth.audit({ action: 'operations.alert.rule', resourceType: 'operations_source', resourceId: sourceId })
	return { kind, enabled }
}

export async function createAlertChannel(
	sourceId: string,
	loadInput: () => Promise<OperationsNotificationChannelRequestDto>,
	options: OperationsOperatorOptions,
): Promise<{ id: string }> {
	await visibleSource(sourceId, 'operations.manage', options)
	const input = await loadInput()
	if (input.target === undefined) throw badRequest('target is required')
	if (!isValidWebhookTarget(input.target)) throw badRequest('target must be a public HTTPS URL without credentials or a fragment')
	const id = uuidv7(now(options))
	await options.repositories.alerts.upsertChannel({ id, sourceId, ...input, target: input.target })
	await options.auth.audit({ action: 'operations.alert_channel.create', resourceType: 'operations_alert_channel', resourceId: id })
	return { id }
}

export async function updateAlertChannel(
	sourceId: string,
	channelId: string,
	loadInput: () => Promise<OperationsNotificationChannelRequestDto>,
	options: OperationsOperatorOptions,
): Promise<{ id: string }> {
	await visibleSource(sourceId, 'operations.manage', options)
	const existing = (await options.repositories.alerts.listChannels(sourceId)).find((channel) => channel.id === channelId)
	if (existing === undefined) return notFoundError()
	const input = await loadInput()
	if (input.target !== undefined && !isValidWebhookTarget(input.target)) {
		throw badRequest('target must be a public HTTPS URL without credentials or a fragment')
	}
	await options.repositories.alerts.upsertChannel({
		id: channelId,
		sourceId,
		scope: input.scope,
		type: input.type,
		target: input.target ?? existing.target,
		enabled: input.enabled,
	})
	await options.auth.audit({ action: 'operations.alert_channel.update', resourceType: 'operations_alert_channel', resourceId: channelId })
	return { id: channelId }
}

export async function deleteAlertChannel(sourceId: string, channelId: string, options: OperationsOperatorOptions): Promise<null> {
	await visibleSource(sourceId, 'operations.manage', options)
	if (!await options.repositories.alerts.deleteChannel(sourceId, channelId)) return notFoundError()
	await options.auth.audit({ action: 'operations.alert_channel.delete', resourceType: 'operations_alert_channel', resourceId: channelId })
	return null
}

function notificationStatus(
	deliveredAt: number | null,
	abandonedAt: number | null,
): 'pending' | 'delivered' | 'abandoned' {
	if (deliveredAt !== null) return 'delivered'
	if (abandonedAt !== null) return 'abandoned'
	return 'pending'
}

function redactTarget(target: string): string {
	try {
		const url = new URL(target)
		return `${url.protocol}//${url.host}/…`
	} catch {
		return 'configured'
	}
}
