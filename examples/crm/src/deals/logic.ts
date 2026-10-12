import type { DEAL_STAGES } from '../schemas'

/** A won or lost deal is closed: it leaves its stage only by reopening. */
export const isClosed = (stage: (typeof DEAL_STAGES)[number]): boolean => stage === 'won' || stage === 'lost'
