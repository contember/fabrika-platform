import type { IngestMessage } from '@fabrika/operations-contract'
import type { AlertsRepository, ErrorIngestRepository, IssueRow, RecordOccurrenceResult } from './repositories.js'

export const SPIKE_WINDOW_MS = 60_000
export const SPIKE_DEDUP_WINDOW_SECONDS = 15 * 60

export interface SpikeInput {
	count: number
	threshold: number
	claimed: boolean
}

export interface SpikeDecision {
	fire: boolean
	deduped: boolean
}

export function evaluateSpike(input: SpikeInput): SpikeDecision {
	if (input.count < input.threshold) return { fire: false, deduped: false }
	return input.claimed ? { fire: false, deduped: true } : { fire: true, deduped: false }
}

export interface AlertProductionResult {
	enqueued: number
	deduplicated: number
}

export interface SpikeProductionResult extends AlertProductionResult {
	evaluated: number
}

type IssueAlertKind = 'new_issue' | 'regression'

export class OperationsAlertProducer {
	constructor(
		private readonly alerts: AlertsRepository,
		private readonly ingest: ErrorIngestRepository,
		private readonly now: () => number = Date.now,
	) {}

	async produceIngest(messages: IngestMessage[], results: RecordOccurrenceResult[]): Promise<AlertProductionResult> {
		if (messages.length !== results.length) throw new Error('ingest alert inputs must align with persistence results')
		const candidates = new Map<string, { kind: IssueAlertKind; message: IngestMessage; issue: IssueRow; transitionAt: number }>()
		for (const [index, message] of messages.entries()) {
			const result = results[index]
			if (!result) throw new Error('ingest alert result is missing')
			const transition = issueTransition(message, result.issue)
			if (!transition) continue
			const key = JSON.stringify([transition.kind, message.projectId, result.issue.fingerprint, transition.at])
			candidates.set(key, { kind: transition.kind, message, issue: result.issue, transitionAt: transition.at })
		}

		let enqueued = 0
		let deduplicated = 0
		for (const candidate of candidates.values()) {
			const rules = await this.alerts.listRules(candidate.message.projectId)
			if (!rules.some((rule) => rule.type === candidate.kind && rule.enabled === 1)) continue
			const channels = await this.alerts.listChannels(candidate.message.projectId)
			for (const channel of channels) {
				if (channel.scope !== candidate.kind || channel.enabled !== 1) continue
				const inserted = await this.alerts.enqueueNotification({
					dedupKey: `${candidate.kind}:${candidate.message.projectId}:${candidate.issue.fingerprint}:${candidate.transitionAt}:${channel.id}`,
					sourceId: candidate.message.projectId,
					channelId: channel.id,
					kind: candidate.kind,
					payload: issuePayload(candidate.kind, candidate.message.projectId, candidate.issue),
				})
				if (inserted) enqueued++
				else deduplicated++
			}
		}
		return { enqueued, deduplicated }
	}

	async detectSpikes(): Promise<SpikeProductionResult> {
		const now = this.now()
		const configs = await this.alerts.listEnabledConfigs()
		let evaluated = 0
		let enqueued = 0
		let deduplicated = 0
		for (const config of configs) {
			const counts = await this.ingest.counts({ sourceId: config.source_id, since: now - SPIKE_WINDOW_MS, until: now })
			for (const count of counts) {
				evaluated++
				if (!evaluateSpike({ count: count.count, threshold: config.threshold, claimed: false }).fire) continue
				const claimKey = `spike:${config.source_id}:${count.fingerprint}`
				const claimed = await this.alerts.tryClaim(claimKey, SPIKE_DEDUP_WINDOW_SECONDS * 1_000)
				const decision = evaluateSpike({ count: count.count, threshold: config.threshold, claimed: !claimed })
				if (!decision.fire) {
					if (decision.deduped) deduplicated++
					continue
				}
				const channels = await this.alerts.listChannels(config.source_id)
				const claimWindow = Math.floor(now / (SPIKE_DEDUP_WINDOW_SECONDS * 1_000))
				for (const channel of channels) {
					if (channel.scope !== 'spike' || channel.enabled !== 1) continue
					const inserted = await this.alerts.enqueueNotification({
						dedupKey: `spike:${config.source_id}:${count.fingerprint}:${claimWindow}:${channel.id}`,
						sourceId: config.source_id,
						channelId: channel.id,
						kind: 'spike',
						payload: spikePayload(config.source_id, count.fingerprint, count.count, config.threshold),
					})
					if (inserted) enqueued++
					else deduplicated++
				}
			}
		}
		return { evaluated, enqueued, deduplicated }
	}
}

function issueTransition(message: IngestMessage, issue: IssueRow): { kind: IssueAlertKind; at: number } | null {
	if (issue.regressed_at === message.receivedAt) return { kind: 'regression', at: message.receivedAt }
	if (issue.first_seen === message.receivedAt) return { kind: 'new_issue', at: message.receivedAt }
	return null
}

function issuePayload(kind: IssueAlertKind, sourceId: string, issue: IssueRow): Record<string, unknown> {
	const label = kind === 'new_issue' ? 'New issue' : 'Regression'
	return {
		text: `Fabrika Operations: ${label} — ${issue.title} (${issue.fingerprint.slice(0, 12)}) in ${sourceId}`,
		type: kind,
		sourceId,
		fingerprint: issue.fingerprint,
		title: issue.title,
	}
}

function spikePayload(sourceId: string, fingerprint: string, count: number, threshold: number): Record<string, unknown> {
	return {
		text: `Fabrika Operations: spike on ${fingerprint} (${count}/min >= ${threshold}/min) in ${sourceId}`,
		type: 'spike',
		sourceId,
		fingerprint,
		rate: count,
		threshold,
	}
}
