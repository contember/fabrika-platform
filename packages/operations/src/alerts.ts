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
