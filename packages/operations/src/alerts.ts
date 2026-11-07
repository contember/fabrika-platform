import type { IngestMessage } from '@fabrika/operations-contract'
import type { AlertsRepository, ErrorIngestRepository, IssueRow, RecordOccurrenceResult } from './repositories.js'

export const SPIKE_WINDOW_MS = 60_000
export const SPIKE_DEDUP_WINDOW_SECONDS = 15 * 60
export const NEW_ISSUE_ALERT_LIMIT = 10
export const NEW_ISSUE_ALERT_WINDOW_MS = 10 * 60_000

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

export interface IssueAlertProductionResult extends AlertProductionResult {
	capped: number
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

	async produceIngest(messages: IngestMessage[], results: RecordOccurrenceResult[]): Promise<IssueAlertProductionResult> {
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
		let capped = 0
		const fullChannels = new Set<string>()
		for (const candidate of candidates.values()) {
			const rules = await this.alerts.listRules(candidate.message.projectId)
			if (!rules.some((rule) => rule.type === candidate.kind && rule.enabled === 1)) continue
			const channels = await this.alerts.listChannels(candidate.message.projectId)
			for (const channel of channels) {
				if (channel.scope !== candidate.kind || channel.enabled !== 1) continue
				if (candidate.kind === 'new_issue' && !(await this.claimNewIssueSlot(candidate.message.projectId, channel.id, fullChannels))) {
					capped++
					continue
				}
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
		return { enqueued, deduplicated, capped }
	}

	// One claim per slot: at most NEW_ISSUE_ALERT_LIMIT new-issue alerts per source and channel in any window.
	private async claimNewIssueSlot(sourceId: string, channelId: string, fullChannels: Set<string>): Promise<boolean> {
		const channelKey = JSON.stringify([sourceId, channelId])
		if (fullChannels.has(channelKey)) return false
		for (let slot = 0; slot < NEW_ISSUE_ALERT_LIMIT; slot++) {
			if (await this.alerts.tryClaim(`new_issue:${sourceId}:${channelId}:${slot}`, NEW_ISSUE_ALERT_WINDOW_MS)) return true
		}
		fullChannels.add(channelKey)
		return false
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
