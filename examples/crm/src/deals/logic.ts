import type { DEAL_STAGES } from '../schemas'

/** A won or lost deal is closed: it leaves its stage only by reopening. */
export const isClosed = (stage: (typeof DEAL_STAGES)[number]): boolean => stage === 'won' || stage === 'lost'

/** A sum Postgres answers as `bigint` text, as a number; one past 2^53 - 1 is refused, never rounded. */
export const safeTotal = (text: string): number => {
	const total = Number(text)
	if (!Number.isSafeInteger(total)) throw new RangeError('a pipeline total is beyond the safe integer range')
	return total
}
