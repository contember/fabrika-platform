import { DEAL_STAGES } from '../schemas'

type Stage = (typeof DEAL_STAGES)[number]

/** A won or lost deal is closed: it leaves its stage only by reopening. */
export const isClosed = (stage: Stage): boolean => stage === 'won' || stage === 'lost'

/** An aggregate's sum, text or a number; one past 2^53 - 1 is refused, never rounded. */
export const exactInteger = (sum: string | number): number => {
	const total = Number(sum)
	if (!Number.isSafeInteger(total)) throw new RangeError('a pipeline total is beyond the safe integer range')
	return total
}

/** Every stage in pipeline order, an empty one as 0 deals of 0, from the aggregate's rows of the stages that have deals. */
export const pipelineOf = (rows: readonly { readonly stage: Stage; readonly count: string; readonly sum_value: string | number | null }[]) =>
	DEAL_STAGES.map((stage) => {
		const row = rows.find((candidate) => candidate.stage === stage)
		return { stage, count: Number(row?.count ?? 0), value: exactInteger(row?.sum_value ?? 0) }
	})
